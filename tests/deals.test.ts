// Milestones 3–4: offers, messages by email, escrow, handover checklist, release and commission.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { acceptTerms, as, BOSS, buildApp, liveListing, prisma, queuedEmails, resetDb } from "./helpers.js";
import { mapEscrowComStatus } from "../src/services/escrow.js";

const SELLER = "alice@example.com";
const BUYER = "bob@example.com";
const OTHER = "eve@example.com";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function withOffer(amount = 450) {
  const ctx = buildApp();
  const l = await liveListing(ctx.app, SELLER);
  await acceptTerms(ctx.app, BUYER);
  const o = await request(ctx.app).post(`/api/listings/${l.id}/offers`).set(as(BUYER)).send({ amount, message: "Hi! Is the code tested?" }).expect(201);
  return { ...ctx, listing: l, offerId: o.body.id as string };
}

async function acceptedDeal() {
  const ctx = await withOffer(1000);
  const deal = await request(ctx.app).post(`/api/offers/${ctx.offerId}/accept`).set(as(SELLER)).expect(200);
  return { ...ctx, dealId: deal.body.id as string, deal: deal.body };
}

describe("offers", () => {
  it("emails the seller about a new offer, without showing anyone's email address", async () => {
    await withOffer();
    const mails = await queuedEmails();
    const toSeller = mails.find((m) => m.to === SELLER && /New offer/.test(m.subject))!;
    expect(toSeller.subject).toMatch(/New offer/);
    expect(toSeller.text).toContain("$450.00");
    expect(toSeller.text).toContain("Is the code tested?");
    expect(toSeller.text).not.toContain(BUYER);
  });

  it("blocks offers on your own listing, on drafts, and silly-low offers", async () => {
    const { app, listing } = await withOffer();
    await request(app).post(`/api/listings/${listing.id}/offers`).set(as(SELLER)).send({ amount: 400 }).expect(400);
    await request(app).post(`/api/listings/${listing.id}/offers`).set(as(BUYER)).send({ amount: 10 }).expect(400);
    await acceptTerms(app, SELLER);
    const draft = await request(app).post("/api/my/listings").set(as(SELLER)).send({ type: "domain", title: "draft.com domain", summary: "a draft domain listing", description: "x".repeat(50), price: 100 });
    await request(app).post(`/api/listings/${draft.body.id}/offers`).set(as(BUYER)).send({ amount: 90 }).expect(404);
  });

  it("keeps the conversation between buyer and seller only", async () => {
    const { app, offerId } = await withOffer();
    await request(app).post(`/api/offers/${offerId}/messages`).set(as(SELLER)).send({ body: "Yes, 60% coverage." }).expect(201);
    const buyerView = await request(app).get("/api/offers").set(as(BUYER)).expect(200);
    expect(buyerView.body[0].messages.map((m: { body: string }) => m.body)).toEqual(["Hi! Is the code tested?", "Yes, 60% coverage."]);
    await request(app).post(`/api/offers/${offerId}/messages`).set(as(OTHER)).send({ body: "let me in" }).expect(404);
    expect((await request(app).get("/api/offers").set(as(OTHER))).body).toEqual([]);
    expect((await queuedEmails()).some((m) => m.to === BUYER && m.text.includes("60% coverage"))).toBe(true);
  });

  it("lets only the seller accept or decline, and only the buyer withdraw", async () => {
    const { app, offerId } = await withOffer();
    await request(app).post(`/api/offers/${offerId}/accept`).set(as(BUYER)).expect(403);
    await request(app).post(`/api/offers/${offerId}/withdraw`).set(as(SELLER)).expect(403);
    await request(app).post(`/api/offers/${offerId}/decline`).set(as(SELLER)).expect(200);
    await request(app).post(`/api/offers/${offerId}/accept`).set(as(SELLER)).expect(409);
  });
});

describe("deal: escrow and handover", () => {
  it("opens a deal with a 10% commission, closes other offers, and takes the listing off sale", async () => {
    const ctx = await withOffer(1000);
    await acceptTerms(ctx.app, OTHER);
    const rival = await request(ctx.app).post(`/api/listings/${ctx.listing.id}/offers`).set(as(OTHER)).send({ amount: 900 }).expect(201);
    const deal = await request(ctx.app).post(`/api/offers/${ctx.offerId}/accept`).set(as(SELLER)).expect(200);
    expect(deal.body).toMatchObject({ amount: 1000, commission: 100, sellerPayout: 900, escrowStatus: "awaiting_payment", role: "seller" });
    expect(deal.body.tasks).toHaveLength(3);
    expect((await prisma.offer.findUnique({ where: { id: rival.body.id } }))!.status).toBe("declined");
    expect((await request(ctx.app).get("/api/listings")).body.total).toBe(0);
    await request(ctx.app).post(`/api/listings/${ctx.listing.id}/offers`).set(as(OTHER)).send({ amount: 950 }).expect(404);
  });

  it("won't let the seller start the handover before escrow is funded", async () => {
    const { app, dealId, deal } = await acceptedDeal();
    await request(app).post(`/api/deals/${dealId}/tasks/${deal.tasks[0].id}/done`).set(as(SELLER)).expect(409);
  });

  it("runs the full happy path: funded → handover → buyer confirms → released → sold", async () => {
    const { app, dealId, deal, listing } = await acceptedDeal();
    await request(app).post(`/api/admin/deals/${dealId}/funded`).set(BOSS).expect(200);
    await request(app).post(`/api/deals/${dealId}/confirm`).set(as(BUYER)).expect(409); // handover not done yet

    let last;
    for (const t of deal.tasks) last = await request(app).post(`/api/deals/${dealId}/tasks/${t.id}/done`).set(as(SELLER)).expect(200);
    expect(last!.body.handoverDoneAt).toBeTruthy();
    expect(new Date(last!.body.releaseDueAt).getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    await request(app).post(`/api/deals/${dealId}/tasks/${deal.tasks[0].id}/done`).set(as(BUYER)).expect(403);

    const confirmed = await request(app).post(`/api/deals/${dealId}/confirm`).set(as(BUYER)).expect(200);
    expect(confirmed.body.escrowStatus).toBe("release_approved");
    await request(app).post(`/api/admin/deals/${dealId}/released`).set(BOSS).expect(200);
    expect((await request(app).get(`/api/deals/${dealId}`).set(as(BUYER))).body.escrowStatus).toBe("released");
    expect((await request(app).get(`/api/listings/${listing.slug}`)).body.status).toBe("sold");

    const overview = await request(app).get("/api/admin/overview").set(BOSS).expect(200);
    expect(overview.body.commissionEarned).toEqual({ USD: 100 });
    expect(overview.body.salesVolume).toEqual({ USD: 1000 });
  });

  it("releases automatically after 7 days if the buyer says nothing", async () => {
    const { app, dealId, deal, services } = await acceptedDeal();
    await request(app).post(`/api/admin/deals/${dealId}/funded`).set(BOSS).expect(200);
    for (const t of deal.tasks) await request(app).post(`/api/deals/${dealId}/tasks/${t.id}/done`).set(as(SELLER));
    expect(await services.deals.autoRelease(new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(await services.deals.autoRelease(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect((await prisma.transaction.findUnique({ where: { id: dealId } }))!.escrowStatus).toBe("release_approved");
  });

  it("lets the buyer dispute, freezes the money, and the admin can refund", async () => {
    const { app, dealId, listing } = await acceptedDeal();
    await request(app).post(`/api/deals/${dealId}/dispute`).set(as(BUYER)).send({ reason: "Too early to tell, sorry" }).expect(409); // not funded yet
    await request(app).post(`/api/admin/deals/${dealId}/funded`).set(BOSS).expect(200);
    await request(app).post(`/api/deals/${dealId}/dispute`).set(as(SELLER)).send({ reason: "I am the seller" }).expect(403);
    const d = await request(app).post(`/api/deals/${dealId}/dispute`).set(as(BUYER)).send({ reason: "The repo transferred is empty" }).expect(200);
    expect(d.body.escrowStatus).toBe("disputed");
    expect((await queuedEmails()).some((m) => m.to === "boss@example.com" && m.subject.includes("Dispute"))).toBe(true);

    await request(app).post(`/api/deals/${dealId}/confirm`).set(as(BUYER)).expect(409);
    await request(app).post(`/api/admin/deals/${dealId}/refund`).set(BOSS).expect(200);
    expect((await prisma.transaction.findUnique({ where: { id: dealId } }))!.escrowStatus).toBe("refunded");
    expect((await request(app).get(`/api/listings/${listing.slug}`)).body.status).toBe("published");
  });

  it("keeps deals private to the buyer and seller", async () => {
    const { app, dealId } = await acceptedDeal();
    await request(app).get(`/api/deals/${dealId}`).set(as(OTHER)).expect(404);
    expect((await request(app).get("/api/deals").set(as(OTHER))).body).toEqual([]);
    await request(app).post(`/api/admin/deals/${dealId}/funded`).set(as(OTHER)).expect(403);
  });

  it("blocks account deletion during an open deal", async () => {
    const { app } = await acceptedDeal();
    await request(app).delete("/api/me").set(as(BUYER)).send({ confirm: "DELETE" }).expect(409);
  });
});

describe("Escrow.com status mapping", () => {
  it("reads funded, released and cancelled from Escrow.com's flags", () => {
    const tx = (status: object, sched: object) => ({ items: [{ type: "general_merchandise", status, schedule: [{ status: sched }] }, { type: "broker_fee" }] });
    expect(mapEscrowComStatus(tx({}, {}))).toBe("awaiting_payment");
    expect(mapEscrowComStatus(tx({}, { secured: true }))).toBe("funded");
    expect(mapEscrowComStatus(tx({}, { secured: true, disbursed_to_beneficiary: true }))).toBe("released");
    expect(mapEscrowComStatus(tx({ canceled: true }, {}))).toBe("cancelled");
  });
});
