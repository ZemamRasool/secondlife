// Wires the real pieces together. Used by server.ts and worker.ts.
import { loadConfig } from "./config.js";
import { createPrisma } from "./lib/prisma.js";
import { createAuthBackend } from "./auth/verifyToken.js";
import { createGitHubApi } from "./services/github.js";
import { dnsTxt } from "./services/listings.js";
import { createEscrowComProvider, createManualEscrow } from "./services/escrow.js";
import { createConsoleMailer, createPostmarkMailer, safeMailer } from "./services/mailer.js";
import { createGeminiSummarizer, npmLatest } from "./services/healthReport.js";
import { createHandlers } from "./jobs/handlers.js";
import { enqueue, Worker } from "./jobs/queue.js";
import { createServices, type AppDeps } from "./app.js";

export async function bootstrap() {
  const config = loadConfig();
  const prisma = createPrisma(config.DATABASE_URL);
  const deps: AppDeps = {
    config,
    prisma,
    auth: createAuthBackend(config),
    github: createGitHubApi(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET),
    resolveTxt: dnsTxt,
    escrow:
      config.ESCROW_PROVIDER === "escrowcom"
        ? createEscrowComProvider({ email: config.ESCROWCOM_EMAIL, apiKey: config.ESCROWCOM_API_KEY, apiUrl: config.ESCROWCOM_API_URL, commissionPercent: config.COMMISSION_PERCENT })
        : createManualEscrow(),
    // Emails are sent by the worker; a failure there is retried by the job queue.
    mailer: config.MAIL_PROVIDER === "postmark" ? createPostmarkMailer(config.POSTMARK_SERVER_TOKEN, config.MAIL_FROM) : safeMailer(createConsoleMailer()),
    latestVersion: npmLatest,
    summarize: createGeminiSummarizer(config.GEMINI_API_KEY, config.GEMINI_MODEL),
  };
  const services = createServices(deps);
  const worker = new Worker(prisma, createHandlers({ ...deps, crypto: services.crypto, deals: services.deals }));

  // Every 10 minutes: check escrow status and release deals whose confirmation window ended.
  const tick = async () => {
    await enqueue(prisma, "auto_release", {});
    if (config.ESCROW_PROVIDER === "escrowcom") await enqueue(prisma, "escrow_sync", {});
  };

  return { config, prisma, deps, services, worker, tick };
}
