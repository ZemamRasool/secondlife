// Public pages' data — no login needed.
//   GET /api/listings            search + filters (q, type, tech, min, max, verified, sort, page)
//   GET /api/listings/:slug      one live listing
//   GET /api/sellers/:id         a seller's public profile and live listings
//   GET /api/tags                most used tech tags (for the filter)
//   GET /media/:listingId/:file  listing screenshots
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../lib/prisma.js";
import { publicListing, type ListingService } from "../services/listings.js";
import type { MediaStore } from "../services/media.js";
import { handle, parse } from "./common.js";

const searchQuery = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(["codebase", "domain", "website"]).optional(),
  tech: z.string().max(300).optional(),
  min: z.coerce.number().min(0).optional(),
  max: z.coerce.number().min(0).optional(),
  verified: z.enum(["1", "true"]).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc", "relevance"]).optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
});

export function publicRouter(prisma: Db, listings: ListingService, media: MediaStore) {
  const router = Router();

  router.get(
    "/api/listings",
    handle(async (req, res) => {
      const q = parse(searchQuery, req.query);
      const result = await listings.search({
        text: q.q,
        type: q.type,
        tech: q.tech ? q.tech.split(",") : [],
        minPriceCents: q.min === undefined ? undefined : Math.round(q.min * 100),
        maxPriceCents: q.max === undefined ? undefined : Math.round(q.max * 100),
        verifiedOnly: Boolean(q.verified),
        sort: q.sort,
        page: q.page,
      });
      res.json({ ...result, results: result.results.map((l) => publicListing(l)) });
    }),
  );

  router.get(
    "/api/listings/:slug",
    handle(async (req, res) => {
      res.json(publicListing(await listings.publicBySlug(String(req.params.slug))));
    }),
  );

  router.get(
    "/api/sellers/:id",
    handle(async (req, res) => {
      const seller = await prisma.user.findFirst({ where: { id: String(req.params.id), banned: false } });
      if (!seller) return res.status(404).json({ error: "Seller not found." });
      const [live, sold] = await Promise.all([
        listings.search({ sellerId: seller.id }),
        prisma.listing.count({ where: { sellerId: seller.id, status: "sold" } }),
      ]);
      res.json({
        id: seller.id,
        name: seller.displayName ?? "Seller",
        bio: seller.bio,
        website: seller.website,
        github: seller.githubLogin,
        memberSince: seller.createdAt,
        sold,
        listings: live.results.map((l) => publicListing(l)),
      });
    }),
  );

  router.get(
    "/api/tags",
    handle(async (_req, res) => {
      const rows = await prisma.$queryRaw<{ tag: string; n: bigint }[]>`
        SELECT tag, count(*)::bigint AS n FROM listings, unnest(tech_stack) AS tag
        WHERE status = 'published' GROUP BY tag ORDER BY n DESC, tag LIMIT 30`;
      res.json(rows.map((r) => ({ tag: r.tag, count: Number(r.n) })));
    }),
  );

  router.get("/media/:listingId/:file", async (req, res) => {
    const file = await media.read(`${req.params.listingId}/${req.params.file}`);
    if (!file) return res.status(404).end();
    res.setHeader("Content-Type", file.type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", "inline");
    res.end(file.data);
  });

  return router;
}
