// Escrow (SPEC.md Milestone 4): the buyer's money is held by a LICENSED escrow company until
// the handover is confirmed. SecondLife never holds the money itself.
//
//   manual    — works today, from anywhere. Each deal is opened on Escrow.com's website by an
//               admin (as broker); the admin records "funded" and "released" in /admin.
//   escrowcom — the deal is created through the Escrow.com API, and its status is checked
//               automatically every few minutes.
import type { Listing, Transaction, User } from "../generated/prisma/client.js";

export type EscrowState = "awaiting_payment" | "funded" | "released" | "refunded" | "cancelled";

export interface EscrowDeal {
  transaction: Transaction;
  listing: Listing;
  buyer: User;
  seller: User;
}

export interface EscrowProvider {
  name: "manual" | "escrowcom";
  /** Open the escrow. Returns the provider's reference and where the buyer pays. */
  open(deal: EscrowDeal): Promise<{ ref: string | null; payUrl: string | null; instructions: string }>;
  /** Latest state at the provider, or null if it can't be checked automatically. */
  status(ref: string): Promise<EscrowState | null>;
}

export function createManualEscrow(): EscrowProvider {
  return {
    name: "manual",
    async open() {
      return {
        ref: null,
        payUrl: null,
        instructions:
          "We are opening this deal with Escrow.com, a licensed escrow company. You'll get an email from Escrow.com with payment instructions within one working day. Never send money directly to the seller.",
      };
    },
    async status() {
      return null;
    },
  };
}

export function createEscrowComProvider(opts: { email: string; apiKey: string; apiUrl: string; commissionPercent: number }): EscrowProvider {
  const auth = `Basic ${Buffer.from(`${opts.email}:${opts.apiKey}`).toString("base64")}`;
  const web = opts.apiUrl.includes("sandbox") ? "https://www.escrow-sandbox.com" : "https://www.escrow.com";

  return {
    name: "escrowcom",

    async open({ transaction: t, listing, buyer, seller }) {
      const amount = t.amountCents / 100;
      const body = {
        parties: [
          { role: "broker", customer: "me" },
          { role: "buyer", customer: buyer.email },
          { role: "seller", customer: seller.email },
        ],
        currency: t.currency.toLowerCase(),
        description: `SecondLife: ${listing.title}`.slice(0, 200),
        items: [
          {
            title: listing.title.slice(0, 100),
            description: listing.summary.slice(0, 500),
            type: listing.type === "domain" ? "domain_name" : "general_merchandise",
            inspection_period: 7 * 86_400,
            quantity: 1,
            ...(listing.type === "domain" ? { extra_attributes: { with_content: false } } : {}),
            schedule: [{ amount, payer_customer: buyer.email, beneficiary_customer: seller.email }],
          },
          // Our commission, paid by the seller out of the sale.
          { type: "broker_fee", schedule: [{ amount: t.commissionCents / 100, payer_customer: seller.email, beneficiary_customer: "me" }] },
        ],
      };
      const res = await fetch(`${opts.apiUrl}/transaction`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Escrow.com error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { id?: number | string };
      const ref = String(data.id ?? "");
      return {
        ref,
        payUrl: ref ? `${web}/transaction/${ref}` : null,
        instructions: "Escrow.com has emailed you both. Agree to the transaction there, then the buyer pays Escrow.com. The seller is only paid after the buyer confirms the handover.",
      };
    },

    async status(ref) {
      const res = await fetch(`${opts.apiUrl}/transaction/${encodeURIComponent(ref)}`, { headers: { Authorization: auth } });
      if (!res.ok) return null;
      return mapEscrowComStatus((await res.json()) as EscrowComTransaction);
    },
  };
}

export interface EscrowComTransaction {
  items?: {
    type?: string;
    status?: Record<string, boolean | undefined>;
    schedule?: { status?: Record<string, boolean | undefined> }[];
  }[];
}

/** Read Escrow.com's status flags. Exported for tests. */
export function mapEscrowComStatus(tx: EscrowComTransaction): EscrowState | null {
  const item = (tx.items ?? []).find((i) => i.type !== "broker_fee");
  if (!item) return null;
  const s = item.status ?? {};
  if (s.canceled || s.cancelled) return "cancelled";
  if (s.rejected_returned || s.refunded) return "refunded";
  const schedule = item.schedule ?? [];
  if (schedule.length && schedule.every((p) => p.status?.disbursed_to_beneficiary)) return "released";
  if (schedule.length && schedule.every((p) => p.status?.secured)) return "funded";
  return "awaiting_payment";
}
