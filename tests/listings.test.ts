// Milestone 1: profiles, listings, review, public pages, search and filters.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { acceptTerms, as, BOSS, buildApp, liveListing, prisma, resetDb, sampleListing } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f80f00000101000518d84e0000000049454e44ae426082", "hex");
const ALICE = "alice@example.com";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("profile", () => {
  it("creates the account on first login and saves the profile", async () => {
    const { app } = buildApp();
    const me = await request(app).get("/api/me").set(as(ALICE)).expect(200);
    expect(me.body).toMatchObject({ email: ALICE, termsAccepted: false, commissionPercent: 10 });
    const updated = await request(app).patch("/api/me").set(as(ALICE)).send({ displayName: "Alice", bio: "I build things", payoutInfo: "Payoneer: alice@example.com" }).expect(200);
    expect(updated.body).toMatchObject({ displayName: "Alice", payoutInfo: "Payoneer: alice@example.com" });
    const row = await prisma.user.findUnique({ where: { email: ALICE } });
    expect(row!.payoutInfoEnc).not.toContain("Payoneer"); // encrypted at rest
  });
});

describe("creating listings", () => {
  it("needs the terms accepted first", async () => {
    const { app } = buildApp();
    await request(app).post("/api/my/listings").set(as(ALICE)).send(sampleListing).expect(403);
  });

  it("checks the fields", async () => {
    const { app } = buildApp();
    await acceptTerms(app, ALICE);
    await request(app).post("/api/my/listings").set(as(ALICE)).send({ ...sampleListing, title: "x" }).expect(400);
    await request(app).post("/api/my/listings").set(as(ALICE)).send({ ...sampleListing, price: 2 }).expect(400);
    await request(app).post("/api/my/listings").set(as(ALICE)).send({ ...sampleListing, type: "car" }).expect(400);
  });

  it("goes draft → review → live, and only live listings are public", async () => {
    const { app } = buildApp();
    await acceptTerms(app, ALICE);
    const c = await request(app).post("/api/my/listings").set(as(ALICE)).send(sampleListing).expect(201);
    expect(c.body).toMatchObject({ status: "draft", price: 500, techStack: ["react", "express", "postgresql"], verified: false });
    await request(app).get(`/api/listings/${c.body.slug}`).expect(404);

    await request(app).post(`/api/my/listings/${c.body.id}/submit`).set(as(ALICE)).expect(200);
    expect((await request(app).get("/api/listings")).body.total).toBe(0);
    await request(app).post(`/api/admin/listings/${c.body.id}/approve`).set(BOSS).expect(200);

    const pub = await request(app).get(`/api/listings/${c.body.slug}`).expect(200);
    expect(pub.body).toMatchObject({ title: sampleListing.title, status: "published" });
    expect(JSON.stringify(pub.body)).not.toContain(ALICE); // seller email never public
  });

  it("lets the admin send a listing back with a reason, and the seller resubmit", async () => {
    const { app } = buildApp();
    await acceptTerms(app, ALICE);
    const c = await request(app).post("/api/my/listings").set(as(ALICE)).send(sampleListing).expect(201);
    await request(app).post(`/api/my/listings/${c.body.id}/submit`).set(as(ALICE)).expect(200);
    await request(app).post(`/api/admin/listings/${c.body.id}/reject`).set(BOSS).send({ reason: "Add screenshots please" }).expect(200);
    const mine = await request(app).get(`/api/my/listings/${c.body.id}`).set(as(ALICE)).expect(200);
    expect(mine.body).toMatchObject({ status: "rejected", rejectReason: "Add screenshots please" });
    await request(app).post(`/api/my/listings/${c.body.id}/submit`).set(as(ALICE)).expect(200);
  });

  it("sends a live listing back to review when what's sold changes, but not for a price change", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, ALICE);
    const priced = await request(app).put(`/api/my/listings/${l.id}`).set(as(ALICE)).send({ ...sampleListing, price: 450 }).expect(200);
    expect(priced.body.status).toBe("published");
    const changed = await request(app).put(`/api/my/listings/${l.id}`).set(as(ALICE)).send({ ...sampleListing, price: 450, title: "Totally different product" }).expect(200);
    expect(changed.body.status).toBe("pending_review");
  });

  it("never lets one seller see or change another seller's listing", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, ALICE);
    await acceptTerms(app, "mallory@example.com");
    await request(app).get(`/api/my/listings/${l.id}`).set(as("mallory@example.com")).expect(404);
    await request(app).put(`/api/my/listings/${l.id}`).set(as("mallory@example.com")).send(sampleListing).expect(404);
    await request(app).post(`/api/my/listings/${l.id}/remove`).set(as("mallory@example.com")).expect(404);
    expect((await request(app).get("/api/my/listings").set(as("mallory@example.com"))).body).toEqual([]);
  });

  it("stores screenshots checked by content, and serves them", async () => {
    const { app } = buildApp();
    await acceptTerms(app, ALICE);
    const c = await request(app).post("/api/my/listings").set(as(ALICE)).send(sampleListing).expect(201);
    await request(app)
      .post(`/api/my/listings/${c.body.id}/images`)
      .set(as(ALICE))
      .attach("images", Buffer.from("MZ not an image at all"), { filename: "shot.png", contentType: "image/png" })
      .expect(415);
    const up = await request(app).post(`/api/my/listings/${c.body.id}/images`).set(as(ALICE)).attach("images", PNG, { filename: "a.png", contentType: "image/png" }).expect(201);
    const url = up.body.screenshots[0] as string;
    const img = await request(app).get(url).expect(200);
    expect(img.headers["content-type"]).toBe("image/png");
    await request(app).get("/media/../../etc/passwd").expect(404);
  });
});

describe("search and filters", () => {
  async function seed() {
    const ctx = buildApp();
    await liveListing(ctx.app, ALICE, { title: "Recipe planner for families", summary: "Meal planning app built with Flutter", techStack: ["flutter", "firebase"], price: 300 });
    await liveListing(ctx.app, ALICE, { title: "Invoice tool for freelancers", summary: "Send invoices, track payments", techStack: ["react", "node"], price: 1200 });
    await liveListing(ctx.app, "bob@example.com", { type: "domain", title: "invoicely.io domain", summary: "Short brandable domain for an invoicing product", techStack: [], price: 900 });
    return ctx;
  }

  it("finds listings by words, best match first", async () => {
    const { app } = await seed();
    const r = await request(app).get("/api/listings").query({ q: "invoice" }).expect(200);
    expect(r.body.total).toBe(2);
    expect(r.body.results.map((x: { title: string }) => x.title)).toContain("Invoice tool for freelancers");
    expect((await request(app).get("/api/listings").query({ q: "meal planning" })).body.results[0].title).toBe("Recipe planner for families");
  });

  it("filters by type, tech, price and sorts by price", async () => {
    const { app } = await seed();
    expect((await request(app).get("/api/listings").query({ type: "domain" })).body.total).toBe(1);
    expect((await request(app).get("/api/listings").query({ tech: "flutter" })).body.total).toBe(1);
    expect((await request(app).get("/api/listings").query({ min: 500, max: 1000 })).body.total).toBe(1);
    const asc = await request(app).get("/api/listings").query({ sort: "price_asc" });
    expect(asc.body.results.map((x: { price: number }) => x.price)).toEqual([300, 900, 1200]);
    expect((await request(app).get("/api/listings").query({ verified: "1" })).body.total).toBe(0);
  });

  it("treats search text safely", async () => {
    const { app } = await seed();
    const r = await request(app).get("/api/listings").query({ q: "'; DROP TABLE listings; --" }).expect(200);
    expect(r.body.total).toBe(0);
    expect(await prisma.listing.count()).toBe(3);
  });

  it("shows popular tech tags and a seller's public page", async () => {
    const { app } = await seed();
    const tags = await request(app).get("/api/tags").expect(200);
    expect(tags.body.map((t: { tag: string }) => t.tag)).toContain("react");
    const alice = await prisma.user.findUnique({ where: { email: ALICE } });
    const page = await request(app).get(`/api/sellers/${alice!.id}`).expect(200);
    expect(page.body.listings).toHaveLength(2);
    expect(JSON.stringify(page.body)).not.toContain(ALICE);
  });
});

describe("cold start: admin lists a project for a seller", () => {
  it("publishes it at once, and the seller takes it over by logging in", async () => {
    const { app } = buildApp();
    const r = await request(app)
      .post("/api/admin/listings")
      .set(BOSS)
      .send({ ...sampleListing, sellerEmail: "carol@example.com", sellerName: "Carol", permissionNote: "Carol agreed by email on 6 Nov" })
      .expect(201);
    await request(app).get(`/api/listings/${r.body.slug}`).expect(200);
    const mine = await request(app).get("/api/my/listings").set(as("carol@example.com")).expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].createdByAdmin).toBe(true);
    expect(await prisma.user.count({ where: { email: "carol@example.com" } })).toBe(1);
  });
});
