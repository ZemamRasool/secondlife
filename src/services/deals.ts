// Offers, messages, and the deal itself (escrow + handover). SPEC.md user flow steps 3–6.
//
//   Offer: pending ──seller accepts──▶ accepted (a deal is opened)    pending ──▶ declined / withdrawn / superseded
//   Deal:  awaiting_payment ──escrow funded──▶ funded ──seller finishes handover──▶ (7-day window)
//            ──buyer confirms, or 7 days pass──▶ release_approved ──escrow pays seller──▶ released
//          Before release the buyer can open a dispute → disputed → admin: release or refund.
import type { Listing, ListingType, Offer, Transaction, User } from "../generated/prisma/client.js";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import { commissionCents, money } from "../lib/util.js";
import { enqueue } from "../jobs/queue.js";
import type { EscrowProvider } from "./escrow.js";
import { AppError } from "./listings.js";

export const HANDOVER_TASKS: Record<ListingType, string[]> = {
  codebase: [
    "Transfer the GitHub repository to the buyer's account (Settings → Transfer ownership)",
    "Share every credential and API key the project needs, through a password manager share (never in messages)",
    "Hand over design files, docs and other assets named in the listing",
  ],
  domain: [
    "Unlock the domain at the registrar and remove privacy/transfer locks",
    "Send the transfer (EPP/auth) code to the buyer",
    "Approve the transfer email from the registrar",
  ],
  website: [
    "Transfer the hosting or deployment account (or move the site to the buyer's hosting)",
    "Unlock the domain and send the transfer (EPP/auth) code",
    "Share admin logins and credentials through a password manager share (never in messages)",
    "Hand over a full backup of the code, content and database",
  ],
};

const name = (u: Pick<User, "displayName">) => u.displayName ?? "A SecondLife member";

export class DealService {
  constructor(
    private readonly prisma: Db,
    private readonly escrow: EscrowProvider,
    private readonly config: Config,
  ) {}

  private link(path: string) {
    return `${this.config.PUBLIC_BASE_URL}${path}`;
  }

  private notify(to: string, subject: string, text: string) {
    return enqueue(this.prisma, "send_email", {
      to,
      subject: `SecondLife: ${subject}`,
      text: `${text}\n\n— SecondLife\nDon't reply to this email; reply on the site so there's a record.`,
    });
  }

  // ---------------- offers ----------------

  async makeOffer(buyer: User, listingId: string, amountCents: number, message: string | undefined) {
    if (!buyer.termsAcceptedAt) throw new AppError(403, "Please accept the terms first (Profile tab).");
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
    if (!listing || listing.status !== "published" || listing.seller.banned) throw new AppError(404, "This listing isn't accepting offers.");
    if (listing.sellerId === buyer.id) throw new AppError(400, "You can't make an offer on your own listing.");
    if (amountCents < Math.round(listing.priceCents * 0.1)) throw new AppError(400, "That offer is too low to send.");

    // A new offer replaces the buyer's earlier pending offer on the same listing.
    await this.prisma.offer.updateMany({ where: { listingId, buyerId: buyer.id, status: "pending" }, data: { status: "superseded" } });
    const offer = await this.prisma.offer.create({ data: { listingId, buyerId: buyer.id, amountCents } });
    if (message?.trim()) await this.prisma.message.create({ data: { offerId: offer.id, senderId: buyer.id, body: message.trim() } });
    await this.notify(
      listing.seller.email,
      `New offer on "${listing.title}"`,
      `${name(buyer)} offered ${money(amountCents, listing.currency)} (your price: ${money(listing.priceCents, listing.currency)}).${message?.trim() ? `\n\nTheir message:\n${message.trim()}` : ""}\n\nAccept, decline or reply: ${this.link("/app#offers")}`,
    );
    return offer;
  }

  /** An offer the user is part of (as buyer or as the listing's seller), or 404. */
  async offerFor(userId: string, offerId: string) {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, OR: [{ buyerId: userId }, { listing: { sellerId: userId } }] },
      include: { listing: { include: { seller: true } }, buyer: true, transaction: true },
    });
    if (!offer) throw new AppError(404, "Offer not found.");
    return offer;
  }

  async listOffers(userId: string) {
    return this.prisma.offer.findMany({
      where: { status: { not: "superseded" }, OR: [{ buyerId: userId }, { listing: { sellerId: userId } }] },
      include: {
        listing: { select: { id: true, title: true, slug: true, sellerId: true, currency: true, priceCents: true, status: true } },
        buyer: { select: { id: true, displayName: true } },
        messages: { orderBy: { createdAt: "asc" }, include: { sender: { select: { id: true, displayName: true } } } },
        transaction: { select: { id: true, escrowStatus: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }

  async sendMessage(user: User, offerId: string, body: string) {
    const offer = await this.offerFor(user.id, offerId);
    if (["withdrawn", "superseded"].includes(offer.status)) throw new AppError(409, "This conversation is closed.");
    const msg = await this.prisma.message.create({ data: { offerId, senderId: user.id, body } });
    const toSeller = user.id === offer.buyerId;
    const recipient = toSeller ? offer.listing.seller : offer.buyer;
    await this.notify(
      recipient.email,
      `New message about "${offer.listing.title}"`,
      `${name(user)} wrote:\n\n${body}\n\nReply on the site: ${this.link("/app#offers")}`,
    );
    return msg;
  }

  async decline(sellerId: string, offerId: string) {
    const offer = await this.offerFor(sellerId, offerId);
    if (offer.listing.sellerId !== sellerId) throw new AppError(403, "Only the seller can decline.");
    const res = await this.prisma.offer.updateMany({ where: { id: offerId, status: "pending" }, data: { status: "declined" } });
    if (!res.count) throw new AppError(409, "This offer is no longer pending.");
    await this.notify(offer.buyer.email, `Offer declined: "${offer.listing.title}"`, `Your offer of ${money(offer.amountCents, offer.listing.currency)} was declined. You can make a new offer: ${this.link(`/l/${offer.listing.slug}`)}`);
    return this.offerFor(sellerId, offerId);
  }

  async withdraw(buyerId: string, offerId: string) {
    const offer = await this.offerFor(buyerId, offerId);
    if (offer.buyerId !== buyerId) throw new AppError(403, "Only the buyer can withdraw.");
    const res = await this.prisma.offer.updateMany({ where: { id: offerId, status: "pending" }, data: { status: "withdrawn" } });
    if (!res.count) throw new AppError(409, "This offer is no longer pending.");
    return this.offerFor(buyerId, offerId);
  }

  /** Seller accepts: the listing goes under offer, other offers close, and escrow opens. */
  async accept(seller: User, offerId: string) {
    const offer = await this.offerFor(seller.id, offerId);
    if (offer.listing.sellerId !== seller.id) throw new AppError(403, "Only the seller can accept.");
    if (!seller.termsAcceptedAt) throw new AppError(403, "Please accept the terms first (Profile tab).");

    const commission = commissionCents(offer.amountCents, this.config.COMMISSION_PERCENT);
    const tx = await this.prisma.$transaction(async (db) => {
      // Both updates check the current status, so two accepts at once can't both win.
      const listingMoved = await db.listing.updateMany({ where: { id: offer.listingId, status: "published" }, data: { status: "under_offer" } });
      const offerMoved = await db.offer.updateMany({ where: { id: offerId, status: "pending" }, data: { status: "accepted" } });
      if (!listingMoved.count || !offerMoved.count) throw new AppError(409, "This offer can't be accepted any more.");
      await db.offer.updateMany({ where: { listingId: offer.listingId, status: "pending" }, data: { status: "declined" } });
      return db.transaction.create({
        data: {
          offerId,
          listingId: offer.listingId,
          buyerId: offer.buyerId,
          sellerId: seller.id,
          amountCents: offer.amountCents,
          commissionCents: commission,
          sellerPayoutCents: offer.amountCents - commission,
          currency: offer.listing.currency,
          escrowProvider: this.escrow.name,
          tasks: { create: HANDOVER_TASKS[offer.listing.type].map((task, position) => ({ task, position })) },
        },
      });
    });

    let instructions: string;
    try {
      const opened = await this.escrow.open({ transaction: tx, listing: offer.listing, buyer: offer.buyer, seller });
      if (opened.ref) await this.prisma.transaction.update({ where: { id: tx.id }, data: { escrowRef: opened.ref } });
      instructions = opened.instructions + (opened.payUrl ? `\n\nEscrow page: ${opened.payUrl}` : "");
    } catch (err) {
      console.error("escrow open failed", err);
      instructions = "We're setting up the escrow and will email you payment instructions shortly.";
    }

    const price = money(offer.amountCents, offer.listing.currency);
    await this.notify(offer.buyer.email, `Offer accepted: "${offer.listing.title}"`, `Good news: your offer of ${price} was accepted.\n\n${instructions}\n\nTrack the deal: ${this.link("/app#deals")}`);
    await this.notify(
      seller.email,
      `You accepted an offer: "${offer.listing.title}"`,
      `Sale price ${price}. Our ${this.config.COMMISSION_PERCENT}% commission: ${money(commission, tx.currency)}. You'll receive ${money(tx.sellerPayoutCents, tx.currency)}.\n\nDon't hand anything over until the deal page says the escrow is FUNDED.\n\nTrack the deal: ${this.link("/app#deals")}`,
    );
    return this.dealFor(seller.id, tx.id);
  }

  // ---------------- deals ----------------

  async dealFor(userId: string, txId: string) {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: txId, OR: [{ buyerId: userId }, { sellerId: userId }] },
      include: { tasks: { orderBy: { position: "asc" } }, listing: { select: { title: true, slug: true, type: true } }, buyer: true, seller: true },
    });
    if (!tx) throw new AppError(404, "Deal not found.");
    return tx;
  }

  async listDeals(userId: string) {
    return this.prisma.transaction.findMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
      include: { tasks: { orderBy: { position: "asc" } }, listing: { select: { title: true, slug: true, type: true } }, buyer: true, seller: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Seller ticks a handover step. When every step is done, the buyer's 7-day window starts. */
  async markTaskDone(sellerId: string, txId: string, taskId: string) {
    const tx = await this.dealFor(sellerId, txId);
    if (tx.sellerId !== sellerId) throw new AppError(403, "Only the seller marks handover steps done.");
    if (tx.escrowStatus !== "funded") throw new AppError(409, "Wait until the escrow is funded before handing anything over.");
    const task = tx.tasks.find((t) => t.id === taskId);
    if (!task) throw new AppError(404, "Step not found.");
    if (!task.doneAt) await this.prisma.handoverTask.update({ where: { id: task.id }, data: { doneAt: new Date(), doneById: sellerId } });

    const remaining = await this.prisma.handoverTask.count({ where: { transactionId: tx.id, doneAt: null } });
    if (remaining === 0 && !tx.handoverDoneAt) {
      const due = new Date(Date.now() + this.config.CONFIRM_WINDOW_DAYS * 86_400_000);
      await this.prisma.transaction.update({ where: { id: tx.id }, data: { handoverDoneAt: new Date(), releaseDueAt: due } });
      await this.notify(
        tx.buyer.email,
        `Handover finished: "${tx.listing.title}"`,
        `The seller has marked every handover step done. Please check everything and confirm on the deal page.\n\nIf something is missing, open a dispute before ${due.toUTCString()}. After that, the money is released to the seller automatically.\n\n${this.link("/app#deals")}`,
      );
    }
    return this.dealFor(sellerId, txId);
  }

  /** Buyer confirms a single step arrived. */
  async confirmTask(buyerId: string, txId: string, taskId: string) {
    const tx = await this.dealFor(buyerId, txId);
    if (tx.buyerId !== buyerId) throw new AppError(403, "Only the buyer confirms steps.");
    const task = tx.tasks.find((t) => t.id === taskId);
    if (!task) throw new AppError(404, "Step not found.");
    if (!task.doneAt) throw new AppError(409, "The seller hasn't marked this step done yet.");
    await this.prisma.handoverTask.update({ where: { id: task.id }, data: { confirmedAt: task.confirmedAt ?? new Date() } });
    return this.dealFor(buyerId, txId);
  }

  /** Buyer confirms they have everything: the money can go to the seller. */
  async confirmAll(buyerId: string, txId: string) {
    const tx = await this.dealFor(buyerId, txId);
    if (tx.buyerId !== buyerId) throw new AppError(403, "Only the buyer can confirm the handover.");
    if (!tx.handoverDoneAt) throw new AppError(409, "The seller hasn't finished the handover yet.");
    const res = await this.prisma.transaction.updateMany({
      where: { id: tx.id, escrowStatus: "funded" },
      data: { escrowStatus: "release_approved", confirmedAt: new Date() },
    });
    if (!res.count) throw new AppError(409, "This deal can't be confirmed in its current state.");
    await this.prisma.handoverTask.updateMany({ where: { transactionId: tx.id, confirmedAt: null }, data: { confirmedAt: new Date() } });
    await this.afterReleaseApproved(tx.id, "The buyer confirmed the handover.");
    return this.dealFor(buyerId, txId);
  }

  async openDispute(buyerId: string, txId: string, reason: string) {
    const tx = await this.dealFor(buyerId, txId);
    if (tx.buyerId !== buyerId) throw new AppError(403, "Only the buyer can open a dispute.");
    const res = await this.prisma.transaction.updateMany({ where: { id: tx.id, escrowStatus: "funded" }, data: { escrowStatus: "disputed", disputeReason: reason } });
    if (!res.count) throw new AppError(409, "A dispute can only be opened while the escrow holds the money.");
    for (const admin of this.config.ADMIN_EMAILS) {
      await this.notify(admin, `Dispute opened: "${tx.listing.title}"`, `Buyer's reason:\n${reason}\n\nReview it in the admin dashboard: ${this.link("/admin")}`);
    }
    await this.notify(tx.seller.email, `The buyer opened a dispute: "${tx.listing.title}"`, `The buyer reported a problem:\n${reason}\n\nThe money stays in escrow while we look at it. Reply on the deal page: ${this.link("/app#deals")}`);
    return this.dealFor(buyerId, txId);
  }

  /** Called when the buyer confirms or the 7-day window ends. */
  private async afterReleaseApproved(txId: string, why: string) {
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: txId }, include: { seller: true, buyer: true, listing: true } });
    for (const admin of this.config.ADMIN_EMAILS) {
      await this.notify(
        admin,
        `Release approved: "${tx.listing.title}"`,
        `${why}\nPay the seller ${money(tx.sellerPayoutCents, tx.currency)} through the escrow, then mark it released in /admin.`,
      );
    }
    await this.notify(tx.seller.email, `Payment approved: "${tx.listing.title}"`, `${why} The escrow is now releasing ${money(tx.sellerPayoutCents, tx.currency)} to you.`);
  }

  /** Background job: approve release for deals whose 7-day window ended without a dispute. */
  async autoRelease(now = new Date()): Promise<number> {
    const due = await this.prisma.transaction.findMany({
      where: { escrowStatus: "funded", releaseDueAt: { lte: now } },
      select: { id: true },
    });
    let n = 0;
    for (const { id } of due) {
      const res = await this.prisma.transaction.updateMany({ where: { id, escrowStatus: "funded" }, data: { escrowStatus: "release_approved", confirmedAt: now } });
      if (res.count) {
        n++;
        await this.afterReleaseApproved(id, `The ${this.config.CONFIRM_WINDOW_DAYS}-day confirmation window ended with no dispute.`);
      }
    }
    return n;
  }

  // ---------------- escrow state changes (admin, or automatic for Escrow.com) ----------------

  async markFunded(txId: string) {
    const res = await this.prisma.transaction.updateMany({ where: { id: txId, escrowStatus: "awaiting_payment" }, data: { escrowStatus: "funded", fundedAt: new Date() } });
    if (!res.count) throw new AppError(409, "Only deals waiting for payment can be marked funded.");
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: txId }, include: { seller: true, buyer: true, listing: true } });
    await this.notify(tx.seller.email, `Escrow funded: start the handover for "${tx.listing.title}"`, `The buyer's money is safely held in escrow. Start the handover now and tick each step on the deal page: ${this.link("/app#deals")}`);
    await this.notify(tx.buyer.email, `Payment received in escrow: "${tx.listing.title}"`, `Your payment is held in escrow. The seller will now hand everything over. You'll have ${this.config.CONFIRM_WINDOW_DAYS} days after the handover to check it.`);
    return tx;
  }

  /** The escrow paid the seller. The deal is done and the listing is sold. */
  async markReleased(txId: string, opts: { force?: boolean } = {}) {
    const from = opts.force ? (["release_approved", "disputed"] as const) : (["release_approved"] as const);
    const res = await this.prisma.transaction.updateMany({ where: { id: txId, escrowStatus: { in: [...from] } }, data: { escrowStatus: "released", releasedAt: new Date() } });
    if (!res.count) throw new AppError(409, "Only approved (or disputed, by admin decision) deals can be released.");
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: txId }, include: { seller: true, buyer: true, listing: true } });
    await this.prisma.listing.update({ where: { id: tx.listingId }, data: { status: "sold" } });
    await this.notify(tx.seller.email, `Deal complete: "${tx.listing.title}"`, `${money(tx.sellerPayoutCents, tx.currency)} has been released to you. Thanks for selling on SecondLife.`);
    await this.notify(tx.buyer.email, `Deal complete: "${tx.listing.title}"`, `The deal is complete. Enjoy your new project!`);
    return tx;
  }

  /** Money goes back to the buyer (dispute decided for the buyer, or deal cancelled before handover). */
  async markRefunded(txId: string) {
    const res = await this.prisma.transaction.updateMany({ where: { id: txId, escrowStatus: { in: ["disputed", "funded"] } }, data: { escrowStatus: "refunded" } });
    if (!res.count) throw new AppError(409, "Only funded or disputed deals can be refunded.");
    return this.reopenListing(txId, "refunded");
  }

  async cancel(txId: string) {
    const res = await this.prisma.transaction.updateMany({ where: { id: txId, escrowStatus: "awaiting_payment" }, data: { escrowStatus: "cancelled" } });
    if (!res.count) throw new AppError(409, "Only deals still waiting for payment can be cancelled.");
    return this.reopenListing(txId, "cancelled");
  }

  private async reopenListing(txId: string, what: string) {
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: txId }, include: { seller: true, buyer: true, listing: true } });
    await this.prisma.listing.updateMany({ where: { id: tx.listingId, status: "under_offer" }, data: { status: "published" } });
    for (const u of [tx.buyer, tx.seller]) await this.notify(u.email, `Deal ${what}: "${tx.listing.title}"`, `The deal was ${what}. ${what === "refunded" ? "The escrow returns the buyer's money." : ""}`.trim());
    return tx;
  }

  /** Background job (Escrow.com mode): copy the provider's state onto our deals. */
  async syncEscrow(): Promise<number> {
    if (this.escrow.name === "manual") return 0;
    const open = await this.prisma.transaction.findMany({
      where: { escrowRef: { not: null }, escrowStatus: { in: ["awaiting_payment", "release_approved"] } },
      take: 100,
    });
    let changed = 0;
    for (const tx of open) {
      const state = await this.escrow.status(tx.escrowRef!).catch(() => null);
      if (state === "funded" && tx.escrowStatus === "awaiting_payment") {
        await this.markFunded(tx.id).catch(() => undefined);
        changed++;
      } else if (state === "released" && tx.escrowStatus === "release_approved") {
        await this.markReleased(tx.id).catch(() => undefined);
        changed++;
      } else if (state === "cancelled" && tx.escrowStatus === "awaiting_payment") {
        await this.cancel(tx.id).catch(() => undefined);
        changed++;
      }
    }
    return changed;
  }
}

export function serializeDeal(tx: Transaction & { tasks: { id: string; task: string; doneAt: Date | null; confirmedAt: Date | null }[]; listing: Pick<Listing, "title" | "slug" | "type">; buyer: User; seller: User }, viewerId: string) {
  const role = tx.buyerId === viewerId ? "buyer" : "seller";
  return {
    id: tx.id,
    role,
    listing: tx.listing,
    counterpart: role === "buyer" ? tx.seller.displayName ?? "Seller" : tx.buyer.displayName ?? "Buyer",
    amount: tx.amountCents / 100,
    commission: tx.commissionCents / 100,
    sellerPayout: tx.sellerPayoutCents / 100,
    currency: tx.currency,
    escrowProvider: tx.escrowProvider,
    escrowStatus: tx.escrowStatus,
    fundedAt: tx.fundedAt,
    handoverDoneAt: tx.handoverDoneAt,
    releaseDueAt: tx.releaseDueAt,
    confirmedAt: tx.confirmedAt,
    releasedAt: tx.releasedAt,
    disputeReason: tx.disputeReason,
    tasks: tx.tasks.map((t) => ({ id: t.id, task: t.task, done: Boolean(t.doneAt), confirmed: Boolean(t.confirmedAt) })),
    createdAt: tx.createdAt,
  };
}

export function serializeOffer(o: Awaited<ReturnType<DealService["listOffers"]>>[number], viewerId: string) {
  const role = o.buyerId === viewerId ? "buyer" : "seller";
  return {
    id: o.id,
    role,
    status: o.status,
    amount: o.amountCents / 100,
    listing: { id: o.listing.id, title: o.listing.title, slug: o.listing.slug, price: o.listing.priceCents / 100, currency: o.listing.currency, status: o.listing.status },
    buyer: o.buyer.displayName ?? "Buyer",
    dealId: o.transaction?.id ?? null,
    messages: o.messages.map((m) => ({ id: m.id, mine: m.senderId === viewerId, from: m.sender.displayName ?? (m.senderId === o.buyerId ? "Buyer" : "Seller"), body: m.body, at: m.createdAt })),
    createdAt: o.createdAt,
  };
}

export type { Offer };
