// Milestone 2: GitHub connection, repo and domain ownership proof, project health report.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { as, buildApp, config, fakeGitHub, liveListing, prisma, resetDb } from "./helpers.js";
import { sign } from "../src/lib/util.js";
import { analyze } from "../src/services/healthReport.js";

const ALICE = "alice@example.com";
const stateSecret = createHmac("sha256", config.ENCRYPTION_KEY).update("github-oauth-state").digest("hex");

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function connectGitHub(app: Parameters<typeof request>[0], email: string, code: string) {
  const me = await request(app).get("/api/me").set(as(email));
  const state = sign(me.body.id, stateSecret, 600);
  return request(app).get("/auth/github/callback").query({ code, state });
}

describe("GitHub connection", () => {
  it("gives a GitHub link with a signed state", async () => {
    const { app } = buildApp();
    const r = await request(app).get("/api/me/github/connect").set(as(ALICE)).expect(200);
    expect(r.body.url).toMatch(/state=/);
  });

  it("saves the GitHub login and stores the token encrypted", async () => {
    const { app } = buildApp();
    const r = await connectGitHub(app, ALICE, "code-alice");
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain("github=connected");
    const u = await prisma.user.findUnique({ where: { email: ALICE } });
    expect(u).toMatchObject({ githubLogin: "alice" });
    expect(u!.githubTokenEnc).not.toContain("tok-alice");
  });

  it("refuses a forged or expired state", async () => {
    const { app } = buildApp();
    const me = await request(app).get("/api/me").set(as(ALICE));
    const forged = sign(me.body.id, "wrong-secret", 600);
    expect((await request(app).get("/auth/github/callback").query({ code: "code-alice", state: forged })).headers.location).toContain("failed");
    const expired = sign(me.body.id, stateSecret, 600, Date.now() - 3600_000);
    expect((await request(app).get("/auth/github/callback").query({ code: "code-alice", state: expired })).headers.location).toContain("failed");
    expect((await prisma.user.findUnique({ where: { email: ALICE } }))!.githubLogin).toBeNull();
  });
});

describe("repo ownership", () => {
  it("needs GitHub connected first", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, ALICE);
    await request(app).post(`/api/my/listings/${l.id}/repos`).set(as(ALICE)).send({ repo: "alice/todo-app" }).expect(412);
  });

  it("rejects a repo the seller doesn't own", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, "bob@example.com");
    await connectGitHub(app, "bob@example.com", "code-bob");
    const r = await request(app).post(`/api/my/listings/${l.id}/repos`).set(as("bob@example.com")).send({ repo: "https://github.com/alice/todo-app" }).expect(403);
    expect(r.body.error).toMatch(/isn't an owner/);
  });

  it("verifies the owner's repo, shows its facts, and builds a health report", async () => {
    const { app, worker } = buildApp();
    const l = await liveListing(app, ALICE);
    await connectGitHub(app, ALICE, "code-alice");
    const r = await request(app).post(`/api/my/listings/${l.id}/repos`).set(as(ALICE)).send({ repo: "https://github.com/alice/todo-app.git" }).expect(201);
    expect(r.body.verified).toBe(true);
    expect(r.body.proofs[0]).toMatchObject({ kind: "repo", reference: "alice/todo-app", verified: true });
    expect(r.body.proofs[0].facts).toMatchObject({ stars: 12, commits: 140 });

    await worker.drain();
    const pub = await request(app).get(`/api/listings/${l.slug}`).expect(200);
    expect(pub.body.verified).toBe(true);
    expect(pub.body.healthReport.score).toBeGreaterThan(60);
    expect(pub.body.healthReport.summary).toContain("alice/todo-app");
    expect(pub.body.healthReport.report.metrics.outdated).toEqual([{ name: "express", wanted: "^4.18.0", latest: "5.1.0" }]);
  });
});

describe("domain ownership (DNS TXT)", () => {
  it("gives the record to add, fails until it exists, then verifies", async () => {
    const { app, txt } = buildApp();
    const l = await liveListing(app, ALICE, { type: "domain", title: "invoicely.io premium domain" });
    const added = await request(app).post(`/api/my/listings/${l.id}/domains`).set(as(ALICE)).send({ domain: "https://www.Invoicely.io/" }).expect(201);
    const asset = added.body.assets.find((a: { kind: string }) => a.kind === "domain");
    expect(asset.reference).toBe("invoicely.io");
    expect(asset.dnsRecord).toMatchObject({ type: "TXT", name: "_secondlife.invoicely.io" });

    await request(app).post(`/api/my/listings/${l.id}/assets/${asset.id}/verify`).set(as(ALICE)).expect(422);
    txt["_secondlife.invoicely.io"] = [["some-other-record"], [asset.dnsRecord.value]];
    const ok = await request(app).post(`/api/my/listings/${l.id}/assets/${asset.id}/verify`).set(as(ALICE)).expect(200);
    expect(ok.body.verified).toBe(true);

    const pub = await request(app).get(`/api/listings/${l.slug}`).expect(200);
    expect(JSON.stringify(pub.body)).not.toContain(asset.dnsRecord.value); // the proof value stays private
  });

  it("refuses things that aren't domains", async () => {
    const { app } = buildApp();
    const l = await liveListing(app, ALICE, { type: "domain" });
    await request(app).post(`/api/my/listings/${l.id}/domains`).set(as(ALICE)).send({ domain: "not a domain" }).expect(400);
  });

  it("drops the Verified badge if an unproven claim is added", async () => {
    const { app, txt } = buildApp();
    const l = await liveListing(app, ALICE, { type: "website" });
    const a = await request(app).post(`/api/my/listings/${l.id}/domains`).set(as(ALICE)).send({ domain: "site-one.com" });
    const one = a.body.assets[0];
    txt["_secondlife.site-one.com"] = [[one.dnsRecord.value]];
    expect((await request(app).post(`/api/my/listings/${l.id}/assets/${one.id}/verify`).set(as(ALICE))).body.verified).toBe(true);
    const b = await request(app).post(`/api/my/listings/${l.id}/domains`).set(as(ALICE)).send({ domain: "site-two.com" });
    expect(b.body.verified).toBe(false);
  });
});

describe("health report scoring", () => {
  it("scores a bare repo low and lists the gaps", async () => {
    const gh = fakeGitHub();
    const repo = (await gh.getRepo("tok-alice", "alice/todo-app"))!;
    const r = await analyze(
      { repo: { ...repo, license: null }, languages: { JavaScript: 100 }, commits: { count: 3, lastCommitAt: "2024-01-01T00:00:00Z" }, files: ["index.js", ".env"], readme: null, packageJson: null },
      async () => null,
      new Date("2026-11-06"),
    );
    expect(r.score).toBeLessThan(30);
    expect(r.checks.find((c) => c.key === "secrets")!.ok).toBe(false);
    expect(r.metrics.monthsSinceLastCommit).toBeGreaterThan(30);
  });
});
