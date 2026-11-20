// Admin dashboard API. Only ADMIN_EMAILS get in; every request is audit-logged.
//   GET  /api/admin/overview
//   GET  /api/admin/review                        listings waiting for review
//   POST /api/admin/listings/:id/approve | reject { reason } | remove
//   POST /api/admin/listings                      create a listing for a seller (with their permission)
//   GET  /api/admin/reports ; POST /api/admin/reports/:id/resolve
//   GET  /api/admin/deals?status=
//   POST /api/admin/deals/:id/funded | released | refund | cancel
//   POST /api/admin/users/:id/ban | unban
//   GET  /api/admin/jobs ; POST /api/admin/jobs/:id/retry
//   GET  /api/admin/audit
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import type { Encryptor } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { money } from "../lib/util.js";
import { enqueue } from "../jobs/queue.js";
import type { DealService } from "../services/deals.js";
import { AppError, ownerListing, type ListingService } from "../services/listings.js";
import { handle, listingBody, parse, toListingInput } from "./common.js";

const DEAL_STATUSES = ["awaiting_payment", "funded", "release_approved", "released", "disputed", "refunded", "cancelled"] as const;

export function adminRouter(prisma: Db, config: Config, crypto: Encryptor, listings: ListingService, deals: DealService) {
  const router = Router();
  const p = (v: unknown) => String(v);
  const mail = (to: string, subject: string, text: string) => enqueue(prisma, "send_email", { to, subject: `SecondLife: ${subject}`, text });

  router.get(
    "/overview",
    handle(async (_req, res) => {
      const [users, byStatus, verified, offersPending, dealsBy, released, openReports, failedJobs] = await Promise.all([
        prisma.user.count({ where: { banned: false } }),
        prisma.listing.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.listing.count({ where: { status: "published", verified: true } }),
        prisma.offer.count({ where: { status: "pending" } }),
        prisma.transaction.groupBy({ by: ["escrowStatus"], _count: { _all: true } }),
        prisma.transaction.findMany({ where: { escrowStatus: "released" }, select: { amountCents: true, commissionCents: true, currency: true } }),
        prisma.report.count({ where: { resolved: false } }),
        prisma.job.count({ where: { status: "failed" } }),
      ]);
      const sum = (rows: typeof released, key: "amountCents" | "commissionCents") =>
        rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.currency]: (acc[r.currency] ?? 0) + r[key] / 100 }), {});
      const pipeline = await prisma.transaction.findMany({ where: { escrowStatus: { in: ["awaiting_payment", "funded", "release_approved", "disputed"] } }, select: { commissionCents: true, currency: true } });
      res.json({
        users,
        listings: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
        verifiedLive: verified,
        offersPending,
        deals: Object.fromEntries(dealsBy.map((r) => [r.escrowStatus, r._count._all])),
        salesVolume: sum(released, "amountCents"),
        commissionEarned: sum(released, "commissionCents"),
        commissionPending: pipeline.reduce<Record<string, number>>((a, r) => ({ ...a, [r.currency]: (a[r.currency] ?? 0) + r.commissionCents / 100 }), {}),
        openReports,
        failedJobs,
        coldStartGoal: { liveListings: byStatus.find((r) => r.status === "published")?._count._all ?? 0, target: 30 },
      });
    }),
  );

  router.get(
    "/review",
    handle(async (_req, res) => {
      const rows = await prisma.listing.findMany({
        where: { status: "pending_review" },
        include: { assets: true, seller: { select: { id: true, displayName: true, githubLogin: true, createdAt: true, email: true } }, healthReports: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { updatedAt: "asc" },
      });
      res.json(rows.map((l) => ({ ...ownerListing(l), sellerEmail: l.seller.email })));
    }),
  );

  router.post(
    "/listings/:id/approve",
    handle(async (req, res) => {
      const r = await prisma.listing.updateMany({ where: { id: p(req.params.id), status: "pending_review" }, data: { status: "published", publishedAt: new Date(), rejectReason: null } });
      if (!r.count) throw new AppError(409, "Only listings waiting for review can be approved.");
      const l = await prisma.listing.findUniqueOrThrow({ where: { id: p(req.params.id) }, include: { seller: true } });
      await audit(prisma, req, { action: "admin.listing_approve", targetType: "listing", targetId: l.id });
      await mail(l.seller.email, `Your listing is live: ${l.title}`, `Buyers can now see it: ${config.PUBLIC_BASE_URL}/l/${l.slug}`);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/listings/:id/reject",
    handle(async (req, res) => {
      const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(1000) }), req.body);
      const r = await prisma.listing.updateMany({ where: { id: p(req.params.id), status: "pending_review" }, data: { status: "rejected", rejectReason: reason } });
      if (!r.count) throw new AppError(409, "Only listings waiting for review can be rejected.");
      const l = await prisma.listing.findUniqueOrThrow({ where: { id: p(req.params.id) }, include: { seller: true } });
      await audit(prisma, req, { action: "admin.listing_reject", targetType: "listing", targetId: l.id, meta: { reason } });
      await mail(l.seller.email, `Changes needed: ${l.title}`, `Your listing needs changes before it can go live:\n\n${reason}\n\nEdit and resubmit: ${config.PUBLIC_BASE_URL}/app`);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/listings/:id/remove",
    handle(async (req, res) => {
      const r = await prisma.listing.updateMany({ where: { id: p(req.params.id), status: { in: ["published", "pending_review", "draft", "rejected"] } }, data: { status: "removed" } });
      if (!r.count) throw new AppError(409, "This listing can't be removed now (a deal may be in progress).");
      await prisma.offer.updateMany({ where: { listingId: p(req.params.id), status: "pending" }, data: { status: "declined" } });
      await audit(prisma, req, { action: "admin.listing_remove", targetType: "listing", targetId: p(req.params.id) });
      res.json({ ok: true });
    }),
  );

  // Cold start (SPEC.md): list a seller's project for them, with their permission.
  // The seller's account is created now; they take it over by logging in with that email.
  router.post(
    "/listings",
    handle(async (req, res) => {
      const b = parse(listingBody.extend({ sellerEmail: z.string().trim().toLowerCase().email(), sellerName: z.string().trim().min(2).max(60), permissionNote: z.string().trim().min(5).max(500) }), req.body);
      const seller = await prisma.user.upsert({
        where: { email: b.sellerEmail },
        update: {},
        create: { email: b.sellerEmail, firebaseUid: `pending:${b.sellerEmail}`, displayName: b.sellerName },
      });
      const l = await listings.create(seller, toListingInput(b), { byAdmin: true });
      await prisma.listing.update({ where: { id: l.id }, data: { status: "published", publishedAt: new Date() } });
      await audit(prisma, req, { action: "admin.listing_create_for_seller", targetType: "listing", targetId: l.id, meta: { seller: b.sellerEmail, permission: b.permissionNote } });
      await mail(
        b.sellerEmail,
        `We listed "${l.title}" for you`,
        `As agreed, we've listed your project on SecondLife: ${config.PUBLIC_BASE_URL}/l/${l.slug}\n\nLog in with this email to manage it, verify ownership (GitHub or DNS) to get the Verified badge, and answer offers: ${config.PUBLIC_BASE_URL}/app`,
      );
      res.status(201).json({ id: l.id, slug: l.slug });
    }),
  );

  router.get(
    "/reports",
    handle(async (_req, res) => {
      const rows = await prisma.report.findMany({
        where: { resolved: false },
        include: { listing: { select: { id: true, title: true, slug: true, status: true } }, reporter: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      });
      res.json(rows.map((r) => ({ id: r.id, reason: r.reason, listing: r.listing, reporter: r.reporter.email, createdAt: r.createdAt })));
    }),
  );

  router.post(
    "/reports/:id/resolve",
    handle(async (req, res) => {
      await prisma.report.update({ where: { id: p(req.params.id) }, data: { resolved: true } });
      await audit(prisma, req, { action: "admin.report_resolve", targetType: "report", targetId: p(req.params.id) });
      res.json({ ok: true });
    }),
  );

  router.get(
    "/deals",
    handle(async (req, res) => {
      const status = DEAL_STATUSES.find((s) => s === req.query.status);
      const rows = await prisma.transaction.findMany({
        where: status ? { escrowStatus: status } : {},
        include: { listing: { select: { title: true, slug: true } }, buyer: { select: { email: true } }, seller: { select: { email: true, payoutInfoEnc: true } }, tasks: true },
        orderBy: { updatedAt: "desc" },
        take: 200,
      });
      res.json(
        rows.map((t) => ({
          id: t.id,
          listing: t.listing,
          buyer: t.buyer.email,
          seller: t.seller.email,
          sellerPayoutInfo: t.seller.payoutInfoEnc ? crypto.decryptText(t.seller.payoutInfoEnc) : null,
          amount: money(t.amountCents, t.currency),
          commission: money(t.commissionCents, t.currency),
          sellerPayout: money(t.sellerPayoutCents, t.currency),
          escrowProvider: t.escrowProvider,
          escrowRef: t.escrowRef,
          escrowStatus: t.escrowStatus,
          tasksDone: t.tasks.filter((x) => x.doneAt).length,
          tasksTotal: t.tasks.length,
          releaseDueAt: t.releaseDueAt,
          disputeReason: t.disputeReason,
          createdAt: t.createdAt,
        })),
      );
    }),
  );

  const dealAction = (action: string, fn: (id: string) => Promise<unknown>) =>
    router.post(
      `/deals/:id/${action}`,
      handle(async (req, res) => {
        await fn(p(req.params.id));
        await audit(prisma, req, { action: `admin.deal_${action}`, targetType: "transaction", targetId: p(req.params.id) });
        res.json({ ok: true });
      }),
    );
  dealAction("funded", (id) => deals.markFunded(id));
  // "released" from a dispute = the admin decided for the seller.
  dealAction("released", (id) => deals.markReleased(id, { force: true }));
  dealAction("refund", (id) => deals.markRefunded(id));
  dealAction("cancel", (id) => deals.cancel(id));

  for (const ban of [true, false]) {
    router.post(
      `/users/:id/${ban ? "ban" : "unban"}`,
      handle(async (req, res) => {
        const target = await prisma.user.findUnique({ where: { id: p(req.params.id) } });
        if (!target) throw new AppError(404, "User not found.");
        if (config.ADMIN_EMAILS.includes(target.email)) throw new AppError(400, "Admins can't be banned here.");
        await prisma.user.update({ where: { id: target.id }, data: { banned: ban } });
        if (ban) await prisma.listing.updateMany({ where: { sellerId: target.id, status: { in: ["published", "pending_review"] } }, data: { status: "removed" } });
        await audit(prisma, req, { action: `admin.user_${ban ? "ban" : "unban"}`, targetType: "user", targetId: target.id });
        res.json({ ok: true });
      }),
    );
  }

  router.get(
    "/users",
    handle(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const rows = await prisma.user.findMany({
        where: q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { displayName: { contains: q, mode: "insensitive" } }] } : {},
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { _count: { select: { listings: true, sales: true, purchases: true } } },
      });
      res.json(rows.map((u) => ({ id: u.id, email: u.email, name: u.displayName, github: u.githubLogin, banned: u.banned, listings: u._count.listings, sales: u._count.sales, purchases: u._count.purchases, createdAt: u.createdAt })));
    }),
  );

  router.get(
    "/jobs",
    handle(async (_req, res) => {
      const jobs = await prisma.job.findMany({ where: { status: "failed" }, orderBy: { updatedAt: "desc" }, take: 100 });
      res.json(jobs.map((j) => ({ id: j.id, type: j.type, attempts: j.attempts, lastError: j.lastError, updatedAt: j.updatedAt })));
    }),
  );

  router.post(
    "/jobs/:id/retry",
    handle(async (req, res) => {
      const r = await prisma.job.updateMany({ where: { id: p(req.params.id), status: "failed" }, data: { status: "queued", attempts: 0, runAt: new Date(), lastError: null } });
      if (!r.count) throw new AppError(404, "Failed job not found.");
      res.json({ ok: true });
    }),
  );

  router.get(
    "/audit",
    handle(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit }));
    }),
  );

  return router;
}
