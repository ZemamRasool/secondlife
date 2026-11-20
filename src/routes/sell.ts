// The seller's own listings. Every route checks the listing belongs to the logged-in seller.
//   GET    /api/my/listings
//   POST   /api/my/listings                        create a draft
//   GET    /api/my/listings/:id
//   PUT    /api/my/listings/:id                    edit
//   POST   /api/my/listings/:id/submit             send for review
//   POST   /api/my/listings/:id/remove             take it down
//   POST   /api/my/listings/:id/images             upload screenshots (field "images")
//   POST   /api/my/listings/:id/domains            add a domain → returns the DNS TXT record to add
//   POST   /api/my/listings/:id/assets/:assetId/verify   check the DNS record
//   POST   /api/my/listings/:id/repos              add a GitHub repo (checked right away)
//   POST   /api/my/listings/:id/assets/:assetId/health   refresh the health report
//   DELETE /api/my/listings/:id/assets/:assetId
//   POST   /api/listings/:id/report                anyone logged in: report a listing
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { sniffImage } from "../lib/util.js";
import { enqueue } from "../jobs/queue.js";
import { AppError, ownerListing, type ListingService } from "../services/listings.js";
import type { MediaStore } from "../services/media.js";
import { handle, listingBody, parse, toListingInput } from "./common.js";

export function sellRouter(prisma: Db, listings: ListingService, media: MediaStore, opts: { maxImageMb: number; maxImages: number; adminEmails: string[] }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: opts.maxImageMb * 1024 * 1024, files: opts.maxImages } });
  const id = (v: unknown) => String(v);

  router.get(
    "/api/my/listings",
    handle(async (req, res) => {
      const rows = await prisma.listing.findMany({
        where: { sellerId: req.user!.id },
        include: { assets: true, seller: { select: { id: true, displayName: true, githubLogin: true, createdAt: true } }, healthReports: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { offers: { where: { status: "pending" } } } } },
        orderBy: { updatedAt: "desc" },
      });
      res.json(rows.map((l) => ({ ...ownerListing(l), pendingOffers: l._count.offers })));
    }),
  );

  router.post(
    "/api/my/listings",
    handle(async (req, res) => {
      if (!req.user!.termsAcceptedAt) throw new AppError(403, "Please accept the terms first (Profile tab).");
      const l = await listings.create(req.user!, toListingInput(parse(listingBody, req.body)));
      await audit(prisma, req, { action: "listing.create", targetType: "listing", targetId: l.id });
      res.status(201).json(ownerListing(l));
    }),
  );

  router.get(
    "/api/my/listings/:id",
    handle(async (req, res) => res.json(ownerListing(await listings.own(req.user!.id, id(req.params.id))))),
  );

  router.put(
    "/api/my/listings/:id",
    handle(async (req, res) => {
      const l = await listings.update(req.user!.id, id(req.params.id), toListingInput(parse(listingBody, req.body)));
      await audit(prisma, req, { action: "listing.update", targetType: "listing", targetId: l.id });
      res.json(ownerListing(l));
    }),
  );

  router.post(
    "/api/my/listings/:id/submit",
    handle(async (req, res) => {
      const l = await listings.submit(req.user!.id, id(req.params.id));
      await audit(prisma, req, { action: "listing.submit", targetType: "listing", targetId: l.id });
      for (const admin of opts.adminEmails) {
        await enqueue(prisma, "send_email", { to: admin, subject: `SecondLife: listing to review — ${l.title}`, text: `A listing is waiting for review in /admin.` });
      }
      res.json(ownerListing(l));
    }),
  );

  router.post(
    "/api/my/listings/:id/remove",
    handle(async (req, res) => {
      const l = await listings.remove(req.user!.id, id(req.params.id));
      await audit(prisma, req, { action: "listing.remove", targetType: "listing", targetId: l.id });
      res.json(ownerListing(l));
    }),
  );

  router.post(
    "/api/my/listings/:id/images",
    (req, res, next) =>
      upload.array("images", opts.maxImages)(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `Each image must be under ${opts.maxImageMb} MB.` : `Up to ${opts.maxImages} images.` });
        }
        if (err) return next(err);
        next();
      }),
    handle(async (req, res) => {
      const l = await listings.own(req.user!.id, id(req.params.id));
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (!files.length) throw new AppError(400, "Choose at least one image.");
      const existing = l.assets.filter((a) => a.kind === "screenshot").length;
      if (existing + files.length > opts.maxImages) throw new AppError(400, `A listing can have up to ${opts.maxImages} screenshots.`);
      const typed = files.map((f) => ({ f, type: sniffImage(f.buffer) }));
      if (typed.some((t) => !t.type)) throw new AppError(415, "Screenshots must be JPG, PNG or WEBP images.");
      let pos = existing;
      for (const { f, type } of typed) {
        const key = await media.save(l.id, f.buffer, type!);
        await prisma.listingAsset.create({ data: { listingId: l.id, kind: "screenshot", reference: key, position: pos++ } });
      }
      res.status(201).json(ownerListing(await listings.own(req.user!.id, l.id)));
    }),
  );

  router.post(
    "/api/my/listings/:id/domains",
    handle(async (req, res) => {
      const { domain } = parse(z.object({ domain: z.string().max(300) }), req.body);
      const l = await listings.addDomain(req.user!.id, id(req.params.id), domain);
      res.status(201).json(ownerListing(l));
    }),
  );

  router.post(
    "/api/my/listings/:id/assets/:assetId/verify",
    handle(async (req, res) => {
      const l = await listings.verifyDomain(req.user!.id, id(req.params.id), id(req.params.assetId));
      await audit(prisma, req, { action: "listing.verify_domain", targetType: "listing_asset", targetId: id(req.params.assetId) });
      res.json(ownerListing(l));
    }),
  );

  router.post(
    "/api/my/listings/:id/repos",
    handle(async (req, res) => {
      const { repo } = parse(z.object({ repo: z.string().max(300) }), req.body);
      const { listing, assetId } = await listings.addRepo(req.user!, id(req.params.id), repo);
      await audit(prisma, req, { action: "listing.verify_repo", targetType: "listing_asset", targetId: assetId });
      await enqueue(prisma, "health_report", { assetId });
      res.status(201).json(ownerListing(listing));
    }),
  );

  router.post(
    "/api/my/listings/:id/assets/:assetId/health",
    handle(async (req, res) => {
      const l = await listings.own(req.user!.id, id(req.params.id));
      const asset = l.assets.find((a) => a.id === req.params.assetId && a.kind === "repo");
      if (!asset) throw new AppError(404, "Repository not found on this listing.");
      await enqueue(prisma, "health_report", { assetId: asset.id });
      res.status(202).json({ ok: true });
    }),
  );

  router.delete(
    "/api/my/listings/:id/assets/:assetId",
    handle(async (req, res) => {
      const { listing, removed } = await listings.removeAsset(req.user!.id, id(req.params.id), id(req.params.assetId));
      if (removed.kind === "screenshot") await media.remove(removed.reference);
      res.json(ownerListing(listing));
    }),
  );

  router.post(
    "/api/listings/:id/report",
    handle(async (req, res) => {
      const { reason } = parse(z.object({ reason: z.string().trim().min(10).max(2000) }), req.body);
      const listing = await prisma.listing.findUnique({ where: { id: id(req.params.id) } });
      if (!listing) throw new AppError(404, "Listing not found.");
      const r = await prisma.report.create({ data: { listingId: listing.id, reporterId: req.user!.id, reason } });
      await audit(prisma, req, { action: "listing.report", targetType: "listing", targetId: listing.id });
      for (const admin of opts.adminEmails) {
        await enqueue(prisma, "send_email", { to: admin, subject: `SecondLife: listing reported — ${listing.title}`, text: `Reason:\n${reason}\n\nReview it in /admin.` });
      }
      res.status(201).json({ id: r.id });
    }),
  );

  return router;
}
