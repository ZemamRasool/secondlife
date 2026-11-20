// Offers, messages and deals for the logged-in user.
//   POST /api/listings/:id/offers           make an offer (+ optional first message)
//   GET  /api/offers                         offers I made or received, with messages
//   POST /api/offers/:id/messages            send a message (emailed to the other side)
//   POST /api/offers/:id/accept | decline    seller
//   POST /api/offers/:id/withdraw            buyer
//   GET  /api/deals                          my deals (buying and selling)
//   GET  /api/deals/:id
//   POST /api/deals/:id/tasks/:taskId/done       seller ticks a handover step
//   POST /api/deals/:id/tasks/:taskId/confirm    buyer confirms a step
//   POST /api/deals/:id/confirm                  buyer: everything received → release
//   POST /api/deals/:id/dispute                  buyer: something is wrong
import { Router } from "express";
import { z } from "zod";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { serializeDeal, serializeOffer, type DealService } from "../services/deals.js";
import { handle, parse } from "./common.js";

export function dealsRouter(prisma: Db, deals: DealService) {
  const router = Router();
  const p = (v: unknown) => String(v);

  router.post(
    "/api/listings/:id/offers",
    handle(async (req, res) => {
      const b = parse(z.object({ amount: z.number().positive().max(10_000_000), message: z.string().trim().max(3000).optional() }), req.body);
      const offer = await deals.makeOffer(req.user!, p(req.params.id), Math.round(b.amount * 100), b.message);
      await audit(prisma, req, { action: "offer.create", targetType: "offer", targetId: offer.id });
      res.status(201).json({ id: offer.id, status: offer.status });
    }),
  );

  router.get(
    "/api/offers",
    handle(async (req, res) => {
      const list = await deals.listOffers(req.user!.id);
      res.json(list.map((o) => serializeOffer(o, req.user!.id)));
    }),
  );

  router.post(
    "/api/offers/:id/messages",
    handle(async (req, res) => {
      const { body } = parse(z.object({ body: z.string().trim().min(1).max(3000) }), req.body);
      const m = await deals.sendMessage(req.user!, p(req.params.id), body);
      res.status(201).json({ id: m.id });
    }),
  );

  for (const action of ["accept", "decline", "withdraw"] as const) {
    router.post(
      `/api/offers/:id/${action}`,
      handle(async (req, res) => {
        const id = p(req.params.id);
        const result =
          action === "accept" ? await deals.accept(req.user!, id) : action === "decline" ? await deals.decline(req.user!.id, id) : await deals.withdraw(req.user!.id, id);
        await audit(prisma, req, { action: `offer.${action}`, targetType: "offer", targetId: id });
        res.json(action === "accept" ? serializeDeal(result as Awaited<ReturnType<DealService["accept"]>>, req.user!.id) : { ok: true });
      }),
    );
  }

  router.get(
    "/api/deals",
    handle(async (req, res) => {
      const list = await deals.listDeals(req.user!.id);
      res.json(list.map((t) => serializeDeal(t, req.user!.id)));
    }),
  );

  router.get(
    "/api/deals/:id",
    handle(async (req, res) => res.json(serializeDeal(await deals.dealFor(req.user!.id, p(req.params.id)), req.user!.id))),
  );

  router.post(
    "/api/deals/:id/tasks/:taskId/done",
    handle(async (req, res) => {
      const tx = await deals.markTaskDone(req.user!.id, p(req.params.id), p(req.params.taskId));
      await audit(prisma, req, { action: "deal.task_done", targetType: "transaction", targetId: tx.id });
      res.json(serializeDeal(tx, req.user!.id));
    }),
  );

  router.post(
    "/api/deals/:id/tasks/:taskId/confirm",
    handle(async (req, res) => {
      const tx = await deals.confirmTask(req.user!.id, p(req.params.id), p(req.params.taskId));
      res.json(serializeDeal(tx, req.user!.id));
    }),
  );

  router.post(
    "/api/deals/:id/confirm",
    handle(async (req, res) => {
      const tx = await deals.confirmAll(req.user!.id, p(req.params.id));
      await audit(prisma, req, { action: "deal.confirm", targetType: "transaction", targetId: tx.id });
      res.json(serializeDeal(tx, req.user!.id));
    }),
  );

  router.post(
    "/api/deals/:id/dispute",
    handle(async (req, res) => {
      const { reason } = parse(z.object({ reason: z.string().trim().min(10).max(3000) }), req.body);
      const tx = await deals.openDispute(req.user!.id, p(req.params.id), reason);
      await audit(prisma, req, { action: "deal.dispute", targetType: "transaction", targetId: tx.id });
      res.json(serializeDeal(tx, req.user!.id));
    }),
  );

  return router;
}
