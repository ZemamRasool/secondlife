// Security: headers, rate limits, admin access, bans, reports, config checks, helpers.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { as, BOSS, buildApp, liveListing, prisma, resetDb, sampleListing, acceptTerms } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { commissionCents, normalizeDomain, normalizeRepo, sign, sniffImage, verifySigned } from "../src/lib/util.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("web security", () => {
  it("sends strict headers", async () => {
    const res = await request(buildApp().app).get("/").expect(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("requires login for private areas", async () => {
    const { app } = buildApp();
    for (const p of ["/api/me", "/api/my/listings", "/api/offers", "/api/deals", "/api/admin/overview"]) await request(app).get(p).expect(401);
    await request(app).post("/api/listings/abc/offers").send({ amount: 5 }).expect(401);
  });

  it("closes the admin area to normal users and logs the attempt", async () => {
    const { app } = buildApp();
    await request(app).get("/api/admin/overview").set(as("eve@example.com")).expect(403);
    expect(await prisma.auditLog.count({ where: { action: "admin.denied" } })).toBe(1);
  });

  it("rate-limits message and offer spam", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, "alice@example.com");
    await acceptTerms(app, "bob@example.com");
    let last = 0;
    for (let i = 0; i < 41; i++) last = (await request(app).post(`/api/listings/${l.id}/offers`).set(as("bob@example.com")).send({ amount: 400 })).status;
    expect(last).toBe(429);
  });
});

describe("trust and safety", () => {
  it("lets anyone logged in report a listing, and the admin resolve it", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, "alice@example.com");
    await request(app).post(`/api/listings/${l.id}/report`).set(as("eve@example.com")).send({ reason: "This is my code, not theirs!" }).expect(201);
    const reports = await request(app).get("/api/admin/reports").set(BOSS).expect(200);
    expect(reports.body[0].listing.id).toBe(l.id);
    await request(app).post(`/api/admin/reports/${reports.body[0].id}/resolve`).set(BOSS).expect(200);
  });

  it("bans a user: their listings come down and they can't act", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, "alice@example.com");
    const alice = await prisma.user.findUnique({ where: { email: "alice@example.com" } });
    await request(app).post(`/api/admin/users/${alice!.id}/ban`).set(BOSS).expect(200);
    await request(app).get(`/api/listings/${l.slug}`).expect(404);
    await request(app).get("/api/me").set(as("alice@example.com")).expect(403);
  });

  it("logs important actions", async () => {
    const { app } = buildApp();
    await acceptTerms(app, "alice@example.com");
    await request(app).post("/api/my/listings").set(as("alice@example.com")).send(sampleListing).expect(201);
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user.login_first", "user.accept_terms", "listing.create"]));
  });

  it("exports and deletes an account with no open deals", async () => {
    const { app } = buildApp();
    await liveListing(app, "alice@example.com");
    const exp = await request(app).get("/api/me/export").set(as("alice@example.com")).expect(200);
    expect(exp.body.listings).toHaveLength(1);
    await request(app).delete("/api/me").set(as("alice@example.com")).send({ confirm: "DELETE" }).expect(200);
    expect(await prisma.listing.count()).toBe(0);
  });
});

describe("helpers", () => {
  it("normalises domains and repos", () => {
    expect(normalizeDomain("https://WWW.Example.co.uk/path?q=1")).toBe("example.co.uk");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeRepo("https://github.com/Owner/My.Repo.git")).toBe("Owner/My.Repo");
    expect(normalizeRepo("../../etc")).toBeNull();
  });

  it("signs values that can't be forged or reused after expiry", () => {
    const s = sign("user1", "secret", 60);
    expect(verifySigned(s, "secret")).toBe("user1");
    expect(verifySigned(s, "other")).toBeNull();
    expect(verifySigned(s.replace(/.$/, "x"), "secret")).toBeNull();
    expect(verifySigned(s, "secret", Date.now() + 120_000)).toBeNull();
  });

  it("works out commission in whole cents", () => {
    expect(commissionCents(123456, 10)).toBe(12346);
    expect(commissionCents(50000, 10)).toBe(5000);
  });

  it("recognises real images only", () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a....................."))).toBeNull();
  });

  it("refuses unsafe production settings", () => {
    const base = { DATABASE_URL: "postgres://x", ENCRYPTION_KEY: "a".repeat(64) };
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ ...base, NODE_ENV: "test", COMMISSION_PERCENT: "50" })).toThrow(/COMMISSION_PERCENT/);
    expect(() => loadConfig({ ...base, NODE_ENV: "test", ESCROW_PROVIDER: "escrowcom" })).toThrow(/ESCROWCOM/);
  });
});
