// Builds the app with fake GitHub, DNS, email, npm and AI, plus a worker to run jobs on demand.
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp, createServices, type AppDeps } from "../src/app.js";
import { createPrisma } from "../src/lib/prisma.js";
import { createAuthBackend } from "../src/auth/verifyToken.js";
import { createHandlers } from "../src/jobs/handlers.js";
import { Worker } from "../src/jobs/queue.js";
import { createManualEscrow } from "../src/services/escrow.js";
import { templateSummary } from "../src/services/healthReport.js";
import type { GitHubApi, RepoInfo } from "../src/services/github.js";
import type { Mail } from "../src/services/mailer.js";

export const config = loadConfig();
export const prisma = createPrisma(config.DATABASE_URL);
type App = Parameters<typeof request>[0];

/** A pretend GitHub: "alice" owns alice/todo-app; "bob" owns nothing. */
export function fakeGitHub(): GitHubApi & { tokens: Record<string, string> } {
  const tokens: Record<string, string> = { "code-alice": "tok-alice", "code-bob": "tok-bob" };
  const repo = (fullName: string, admin: boolean): RepoInfo => ({
    fullName, ownerLogin: fullName.split("/")[0], isAdmin: admin, private: false, description: "A todo app", stars: 12, forks: 2,
    sizeKb: 900, defaultBranch: "main", pushedAt: "2025-03-01T00:00:00Z", createdAt: "2023-01-01T00:00:00Z", license: "MIT",
  });
  return {
    tokens,
    authorizeUrl: (state) => `https://github.com/login/oauth/authorize?state=${state}`,
    exchangeCode: async (code) => (tokens[code] ? { token: tokens[code], scope: "read:user" } : null),
    getLogin: async (t) => (t === "tok-alice" ? "alice" : t === "tok-bob" ? "bob" : null),
    getRepo: async (t, name) => (name.toLowerCase() === "alice/todo-app" ? repo("alice/todo-app", t === "tok-alice") : null),
    getLanguages: async () => ({ TypeScript: 9000, CSS: 1000 }),
    getCommitStats: async () => ({ count: 140, lastCommitAt: "2025-03-01T00:00:00Z" }),
    getTree: async () => ["README.md", "package.json", "src/index.ts", "tests/app.test.ts", ".github/workflows/ci.yml", ".env.example", "LICENSE"],
    getFile: async (_t, _n, p) =>
      p === "package.json"
        ? JSON.stringify({ scripts: { test: "vitest" }, dependencies: { express: "^4.18.0", zod: "^3.22.0" } })
        : p === "README.md"
          ? `# Todo app\n\n## Setup\n\n${"word ".repeat(200)}\n\n## Usage\n`
          : null,
  };
}

export function buildApp(over: Partial<AppDeps> = {}) {
  const txt: Record<string, string[][]> = {};
  const mails: Mail[] = [];
  const deps: AppDeps = {
    config,
    prisma,
    auth: createAuthBackend(config),
    github: fakeGitHub(),
    resolveTxt: async (name) => {
      if (!txt[name]) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return txt[name];
    },
    escrow: createManualEscrow(),
    mailer: async (m) => void mails.push(m),
    latestVersion: async (name) => (name === "express" ? "5.1.0" : "3.25.0"),
    summarize: async (r, input) => ({ text: templateSummary(r, input.repo), usedAi: false }),
    ...over,
  };
  const app = createApp(deps);
  const services = createServices(deps);
  const worker = new Worker(prisma, createHandlers({ ...deps, crypto: services.crypto, deals: services.deals }), () => undefined);
  return { app, worker, services, txt, mails, deps };
}

export const as = (email: string) => ({ Authorization: `Bearer dev:${email}` });
export const BOSS = as("boss@example.com");

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    "TRUNCATE handover_tasks, transactions, messages, offers, reports, health_reports, listing_assets, listings, users, jobs, audit_logs RESTART IDENTITY CASCADE",
  );
}

export async function acceptTerms(app: App, email: string) {
  return request(app).post("/api/me/terms").set(as(email)).send({ accept: true }).expect(200);
}

export const sampleListing = {
  type: "codebase",
  title: "Todo app with team sharing",
  summary: "A React + Express todo app with teams, 80% done.",
  description: "Full-stack todo app. Users can create lists, share them with a team, and get reminders. ".repeat(2),
  price: 500,
  techStack: ["React", "Express", "PostgreSQL"],
  whatsMissing: "Billing and mobile layout.",
  traction: "120 sign-ups from a Product Hunt launch",
};

/** Create, submit and approve a listing; returns its id and slug. */
export async function liveListing(app: App, email: string, over: Record<string, unknown> = {}) {
  await acceptTerms(app, email);
  const created = await request(app).post("/api/my/listings").set(as(email)).send({ ...sampleListing, ...over }).expect(201);
  await request(app).post(`/api/my/listings/${created.body.id}/submit`).set(as(email)).expect(200);
  await request(app).post(`/api/admin/listings/${created.body.id}/approve`).set(BOSS).expect(200);
  return created.body as { id: string; slug: string };
}

/** Emails waiting in the job queue (sent by the worker). */
export async function queuedEmails() {
  const jobs = await prisma.job.findMany({ where: { type: "send_email" }, orderBy: { createdAt: "asc" } });
  return jobs.map((j) => j.payload as { to: string; subject: string; text: string });
}
