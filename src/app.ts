// Builds the web app: security headers, rate limits, routes and pages.
// Everything it needs is passed in, so tests can swap GitHub, DNS, email, AI and escrow for fakes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Config } from "./config.js";
import type { Db } from "./lib/prisma.js";
import { Encryptor } from "./lib/crypto.js";
import type { AuthBackend } from "./auth/verifyToken.js";
import { requireAdmin, requireAuth } from "./middleware/requireAuth.js";
import { ListingService, type TxtResolver } from "./services/listings.js";
import { DealService } from "./services/deals.js";
import { MediaStore } from "./services/media.js";
import type { GitHubApi } from "./services/github.js";
import type { EscrowProvider } from "./services/escrow.js";
import type { Mailer } from "./services/mailer.js";
import type { LatestVersion, Summarizer } from "./services/healthReport.js";
import { publicRouter } from "./routes/public.js";
import { meRouter } from "./routes/me.js";
import { sellRouter } from "./routes/sell.js";
import { dealsRouter } from "./routes/deals.js";
import { adminRouter } from "./routes/admin.js";

export interface AppDeps {
  config: Config;
  prisma: Db;
  auth: AuthBackend;
  github: GitHubApi;
  resolveTxt: TxtResolver;
  escrow: EscrowProvider;
  mailer: Mailer;
  latestVersion: LatestVersion;
  summarize: Summarizer;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

export function createServices(d: AppDeps) {
  const crypto = new Encryptor(d.config.ENCRYPTION_KEY);
  const media = new MediaStore(d.config.UPLOAD_DIR);
  const listings = new ListingService(d.prisma, crypto, d.github, d.resolveTxt, Math.round(d.config.MIN_PRICE_USD * 100));
  const deals = new DealService(d.prisma, d.escrow, d.config);
  return { crypto, media, listings, deals };
}

export function createApp(deps: AppDeps) {
  const { config, prisma, auth } = deps;
  const { crypto, media, listings, deals } = createServices(deps);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://www.gstatic.com", "https://apis.google.com"],
          connectSrc: ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com"],
          frameSrc: ["https://*.firebaseapp.com", "https://accounts.google.com"],
          imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
          styleSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      hsts: config.NODE_ENV === "production",
    }),
  );

  const limiter = (windowMinutes: number, limit: number, byUser = false) =>
    rateLimit({
      windowMs: windowMinutes * 60_000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => (byUser && req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
      message: { error: "Too many requests. Please wait a little and try again." },
    });
  const needAuth = requireAuth(prisma, auth);

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) =>
    res.json({
      authMode: config.AUTH_MODE,
      firebase: { apiKey: config.FIREBASE_WEB_API_KEY, authDomain: config.FIREBASE_WEB_AUTH_DOMAIN, projectId: config.FIREBASE_PROJECT_ID },
      commissionPercent: config.COMMISSION_PERCENT,
      confirmWindowDays: config.CONFIRM_WINDOW_DAYS,
      escrowProvider: config.ESCROW_PROVIDER,
    }),
  );

  app.use("/api", limiter(15, 900), express.json({ limit: "200kb" }));

  // Logged-in areas.
  for (const p of ["/api/me", "/api/my", "/api/offers", "/api/deals", "/api/admin"]) app.use(p, needAuth);
  app.post(/^\/api\/listings\/[^/]+\/(offers|report)$/, needAuth);
  app.use("/api/admin", requireAdmin(prisma, config.ADMIN_EMAILS));
  // Extra limits on actions that send email to other people or call GitHub.
  app.post(/^\/api\/(listings\/[^/]+\/(offers|report)|offers\/[^/]+\/messages)$/, limiter(60, 40, true));
  app.post(/^\/api\/my\/listings\/[^/]+\/(repos|domains|assets\/[^/]+\/(verify|health))$/, limiter(60, 60, true));

  app.use(publicRouter(prisma, listings, media));
  app.use(meRouter(prisma, config, crypto, deps.github, media, auth));
  app.use(sellRouter(prisma, listings, media, { maxImageMb: config.MAX_IMAGE_MB, maxImages: config.MAX_IMAGES, adminEmails: config.ADMIN_EMAILS }));
  app.use(dealsRouter(prisma, deals));
  app.use("/api/admin", adminRouter(prisma, config, crypto, listings, deals));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Pretty URLs for the public pages.
  app.get("/l/:slug", (_req, res) => res.sendFile(path.join(publicDir, "listing.html")));
  app.get("/u/:id", (_req, res) => res.sendFile(path.join(publicDir, "seller.html")));
  app.use(express.static(publicDir, { extensions: ["html"] }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string };
    if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (e?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
