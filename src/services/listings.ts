// Listings: create, edit, submit for review, search, and prove ownership.
//
// Status flow:  draft ──submit──▶ pending_review ──admin approves──▶ published ──offer accepted──▶ under_offer ──deal done──▶ sold
//                 ▲                     │ admin rejects                  │ seller removes
//                 └──── edit ◀── rejected                                └──▶ removed
import { resolveTxt } from "node:dns/promises";
import { Prisma, type Listing, type ListingAsset, type ListingType, type User, type HealthReport } from "../generated/prisma/client.js";
import type { Db } from "../lib/prisma.js";
import type { Encryptor } from "../lib/crypto.js";
import { cleanTags, normalizeDomain, normalizeRepo, randomToken, slugify } from "../lib/util.js";
import type { GitHubApi } from "./github.js";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TxtResolver = (name: string) => Promise<string[][]>;
export const dnsTxt: TxtResolver = (name) => resolveTxt(name);

export interface ListingInput {
  type: ListingType;
  title: string;
  summary: string;
  description: string;
  priceCents: number;
  techStack: string[];
  whatsMissing?: string | null;
  traction?: string | null;
  monthlyVisitors?: number | null;
}

/** Which proof each listing type needs before it shows the Verified badge. */
const REQUIRED_PROOF: Record<ListingType, "repo" | "domain"> = { codebase: "repo", domain: "domain", website: "domain" };

type Full = Listing & { assets: ListingAsset[]; seller: Pick<User, "id" | "displayName" | "githubLogin" | "createdAt">; healthReports?: HealthReport[] };

/** What the public sees. Never includes emails, tokens or DNS proof values. */
export function publicListing(l: Full) {
  const report = l.healthReports?.[0];
  return {
    id: l.id,
    slug: l.slug,
    type: l.type,
    title: l.title,
    summary: l.summary,
    description: l.description,
    price: l.priceCents / 100,
    currency: l.currency,
    techStack: l.techStack,
    whatsMissing: l.whatsMissing,
    traction: l.traction,
    monthlyVisitors: l.monthlyVisitors,
    status: l.status,
    verified: l.verified,
    publishedAt: l.publishedAt,
    seller: { id: l.seller.id, name: l.seller.displayName ?? "Seller", github: l.seller.githubLogin, memberSince: l.seller.createdAt },
    screenshots: l.assets.filter((a) => a.kind === "screenshot").sort((a, b) => a.position - b.position).map((a) => `/media/${a.reference}`),
    proofs: l.assets
      .filter((a) => a.kind !== "screenshot")
      .map((a) => ({ kind: a.kind, reference: a.reference, verified: Boolean(a.verifiedAt), facts: a.kind === "repo" ? a.metaJson : null })),
    healthReport: report ? { score: report.score, summary: report.summary, report: report.reportJson, createdAt: report.createdAt } : null,
  };
}

/** What the seller sees about their own listing (adds DNS proof instructions and review notes). */
export function ownerListing(l: Full) {
  return {
    ...publicListing(l),
    rejectReason: l.rejectReason,
    createdByAdmin: l.createdByAdmin,
    assets: l.assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      reference: a.kind === "screenshot" ? `/media/${a.reference}` : a.reference,
      verified: Boolean(a.verifiedAt),
      dnsRecord: a.kind === "domain" && a.verifyToken ? { type: "TXT", name: `_secondlife.${a.reference}`, value: `secondlife-verify=${a.verifyToken}` } : null,
    })),
  };
}

const include = {
  assets: true,
  seller: { select: { id: true, displayName: true, githubLogin: true, createdAt: true } },
  healthReports: { orderBy: { createdAt: "desc" as const }, take: 1 },
};

export class ListingService {
  constructor(
    private readonly prisma: Db,
    private readonly crypto: Encryptor,
    private readonly github: GitHubApi,
    private readonly resolveTxtRecords: TxtResolver,
    private readonly minPriceCents: number,
  ) {}

  private check(input: ListingInput) {
    if (input.priceCents < this.minPriceCents) throw new AppError(400, `The lowest price is $${this.minPriceCents / 100}.`);
  }

  async create(seller: User, input: ListingInput, opts: { byAdmin?: boolean } = {}) {
    this.check(input);
    return this.prisma.listing.create({
      data: {
        sellerId: seller.id,
        slug: slugify(input.title),
        type: input.type,
        title: input.title,
        summary: input.summary,
        description: input.description,
        priceCents: input.priceCents,
        techStack: cleanTags(input.techStack),
        whatsMissing: input.whatsMissing ?? null,
        traction: input.traction ?? null,
        monthlyVisitors: input.monthlyVisitors ?? null,
        createdByAdmin: Boolean(opts.byAdmin),
      },
      include,
    });
  }

  /** The seller's own listing, or 404. Every seller action goes through this. */
  async own(sellerId: string, id: string): Promise<Full> {
    const l = await this.prisma.listing.findFirst({ where: { id, sellerId }, include });
    if (!l) throw new AppError(404, "Listing not found.");
    return l;
  }

  async update(sellerId: string, id: string, input: ListingInput) {
    const l = await this.own(sellerId, id);
    if (["under_offer", "sold"].includes(l.status)) throw new AppError(409, "This listing has an accepted offer and can't be edited.");
    this.check(input);
    // Changing what is being sold sends a live listing back to review; price-only changes don't.
    const contentChanged = l.title !== input.title || l.description !== input.description || l.summary !== input.summary || l.type !== input.type;
    const status = l.status === "published" && contentChanged ? "pending_review" : l.status === "rejected" ? "draft" : l.status;
    await this.prisma.listing.update({
      where: { id: l.id },
      data: {
        type: input.type,
        title: input.title,
        summary: input.summary,
        description: input.description,
        priceCents: input.priceCents,
        techStack: cleanTags(input.techStack),
        whatsMissing: input.whatsMissing ?? null,
        traction: input.traction ?? null,
        monthlyVisitors: input.monthlyVisitors ?? null,
        status,
      },
    });
    await this.recomputeVerified(l.id);
    return this.own(sellerId, id);
  }

  async submit(sellerId: string, id: string) {
    const l = await this.own(sellerId, id);
    if (!["draft", "rejected"].includes(l.status)) throw new AppError(409, "Only drafts can be submitted for review.");
    await this.prisma.listing.update({ where: { id: l.id }, data: { status: "pending_review", rejectReason: null } });
    return this.own(sellerId, id);
  }

  async remove(sellerId: string, id: string) {
    const l = await this.own(sellerId, id);
    if (["under_offer", "sold"].includes(l.status)) throw new AppError(409, "This listing has an accepted offer and can't be removed.");
    await this.prisma.listing.update({ where: { id: l.id }, data: { status: "removed" } });
    await this.prisma.offer.updateMany({ where: { listingId: l.id, status: "pending" }, data: { status: "declined" } });
    return this.own(sellerId, id);
  }

  /** Public page: only live (or under offer / sold) listings. */
  async publicBySlug(slug: string) {
    const l = await this.prisma.listing.findFirst({
      where: { slug, status: { in: ["published", "under_offer", "sold"] }, seller: { banned: false } },
      include,
    });
    if (!l) throw new AppError(404, "Listing not found.");
    return l;
  }

  async search(q: {
    text?: string;
    type?: ListingType;
    tech?: string[];
    minPriceCents?: number;
    maxPriceCents?: number;
    verifiedOnly?: boolean;
    sort?: "newest" | "price_asc" | "price_desc" | "relevance";
    page?: number;
    sellerId?: string;
  }) {
    const pageSize = 24;
    const page = Math.max(1, q.page ?? 1);
    const where: Prisma.Sql[] = [Prisma.sql`l.status = 'published'`, Prisma.sql`u.banned = false`];
    const text = q.text?.trim().slice(0, 200);
    if (text) where.push(Prisma.sql`l.search_vector @@ websearch_to_tsquery('english', ${text})`);
    if (q.type) where.push(Prisma.sql`l.type = ${q.type}::"ListingType"`);
    const tech = cleanTags(q.tech ?? []);
    if (tech.length) where.push(Prisma.sql`l.tech_stack @> ${tech}::text[]`);
    if (q.minPriceCents !== undefined) where.push(Prisma.sql`l.price_cents >= ${q.minPriceCents}`);
    if (q.maxPriceCents !== undefined) where.push(Prisma.sql`l.price_cents <= ${q.maxPriceCents}`);
    if (q.verifiedOnly) where.push(Prisma.sql`l.verified = true`);
    if (q.sellerId) where.push(Prisma.sql`l.seller_id = ${q.sellerId}`);

    const order =
      q.sort === "price_asc"
        ? Prisma.sql`l.price_cents ASC`
        : q.sort === "price_desc"
          ? Prisma.sql`l.price_cents DESC`
          : text && (q.sort === "relevance" || !q.sort)
            ? Prisma.sql`ts_rank(l.search_vector, websearch_to_tsquery('english', ${text})) DESC, l.published_at DESC`
            : Prisma.sql`l.published_at DESC`;

    const cond = Prisma.join(where, " AND ");
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT l.id FROM listings l JOIN users u ON u.id = l.seller_id
      WHERE ${cond} ORDER BY ${order}, l.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM listings l JOIN users u ON u.id = l.seller_id WHERE ${cond}`;

    const ids = rows.map((r) => r.id);
    const listings = await this.prisma.listing.findMany({ where: { id: { in: ids } }, include });
    const byId = new Map(listings.map((l) => [l.id, l]));
    return {
      total: Number(count),
      page,
      pageSize,
      results: ids.map((id) => byId.get(id)!).filter(Boolean),
    };
  }

  // ---------------- ownership proof ----------------

  async addDomain(sellerId: string, id: string, input: string) {
    const l = await this.own(sellerId, id);
    const domain = normalizeDomain(input);
    if (!domain) throw new AppError(400, "Enter a domain like example.com.");
    if (l.assets.some((a) => a.kind === "domain" && a.reference === domain)) throw new AppError(409, "This domain is already on the listing.");
    await this.prisma.listingAsset.create({ data: { listingId: l.id, kind: "domain", reference: domain, verifyToken: randomToken(12) } });
    await this.recomputeVerified(l.id);
    return this.own(sellerId, id);
  }

  /** Checks for the TXT record "secondlife-verify=<token>" at _secondlife.<domain> (or the domain itself). */
  async verifyDomain(sellerId: string, listingId: string, assetId: string) {
    const l = await this.own(sellerId, listingId);
    const asset = l.assets.find((a) => a.id === assetId && a.kind === "domain");
    if (!asset || !asset.verifyToken) throw new AppError(404, "Domain not found on this listing.");
    const expected = `secondlife-verify=${asset.verifyToken}`;
    let found = false;
    for (const name of [`_secondlife.${asset.reference}`, asset.reference]) {
      try {
        const records = await this.resolveTxtRecords(name);
        if (records.some((parts) => parts.join("").trim() === expected)) found = true;
      } catch {
        /* no record at this name */
      }
      if (found) break;
    }
    if (!found) throw new AppError(422, `We couldn't find the TXT record yet. DNS changes can take up to an hour. Add: _secondlife.${asset.reference}  TXT  ${expected}`);
    await this.prisma.listingAsset.update({ where: { id: asset.id }, data: { verifiedAt: new Date() } });
    await this.recomputeVerified(l.id);
    return this.own(sellerId, listingId);
  }

  /** Adds a GitHub repo and checks the seller's connected GitHub account is an admin of it. */
  async addRepo(seller: User, listingId: string, input: string) {
    const l = await this.own(seller.id, listingId);
    const fullName = normalizeRepo(input);
    if (!fullName) throw new AppError(400, "Enter a repository like owner/name or its GitHub link.");
    if (!seller.githubTokenEnc || !seller.githubLogin) throw new AppError(412, "Connect your GitHub account first (Profile tab).");
    if (l.assets.some((a) => a.kind === "repo" && a.reference.toLowerCase() === fullName.toLowerCase())) throw new AppError(409, "This repository is already on the listing.");

    const token = this.crypto.decryptText(seller.githubTokenEnc);
    const repo = await this.github.getRepo(token, fullName);
    if (!repo) throw new AppError(422, "We can't see this repository with your GitHub account. If it's private, reconnect GitHub with private repo access.");
    const owns = repo.isAdmin || repo.ownerLogin.toLowerCase() === seller.githubLogin.toLowerCase();
    if (!owns) throw new AppError(403, `Your GitHub account (${seller.githubLogin}) isn't an owner or admin of ${repo.fullName}.`);

    const [languages, commits] = await Promise.all([this.github.getLanguages(token, fullName), this.github.getCommitStats(token, fullName)]);
    const asset = await this.prisma.listingAsset.create({
      data: {
        listingId: l.id,
        kind: "repo",
        reference: repo.fullName,
        verifiedAt: new Date(),
        metaJson: {
          stars: repo.stars,
          forks: repo.forks,
          private: repo.private,
          sizeKb: repo.sizeKb,
          license: repo.license,
          createdAt: repo.createdAt,
          lastPushAt: repo.pushedAt,
          commits: commits.count,
          lastCommitAt: commits.lastCommitAt,
          languages: Object.keys(languages).slice(0, 8),
        },
      },
    });
    await this.recomputeVerified(l.id);
    return { listing: await this.own(seller.id, listingId), assetId: asset.id };
  }

  async removeAsset(sellerId: string, listingId: string, assetId: string) {
    const l = await this.own(sellerId, listingId);
    const asset = l.assets.find((a) => a.id === assetId);
    if (!asset) throw new AppError(404, "Not found on this listing.");
    if (["under_offer", "sold"].includes(l.status) && asset.kind !== "screenshot") throw new AppError(409, "Proofs can't be removed while a deal is in progress.");
    await this.prisma.listingAsset.delete({ where: { id: asset.id } });
    await this.recomputeVerified(l.id);
    return { listing: await this.own(sellerId, listingId), removed: asset };
  }

  /** Verified = the proof this type needs is verified, and no ownership claim is left unproven. */
  async recomputeVerified(listingId: string) {
    const l = await this.prisma.listing.findUnique({ where: { id: listingId }, include: { assets: true } });
    if (!l) return;
    const proofs = l.assets.filter((a) => a.kind !== "screenshot");
    const verified = proofs.some((a) => a.kind === REQUIRED_PROOF[l.type] && a.verifiedAt) && proofs.every((a) => a.verifiedAt);
    if (verified !== l.verified) await this.prisma.listing.update({ where: { id: l.id }, data: { verified } });
  }
}
