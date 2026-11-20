// The logged-in user's own account.
//   GET    /api/me                   profile + what's set up
//   PATCH  /api/me                   display name, bio, website, how to get paid
//   POST   /api/me/terms             accept the terms (needed to buy or sell)
//   GET    /api/me/github/connect    a GitHub link to connect the account (read-only use)
//   DELETE /api/me/github            forget the GitHub connection
//   GET    /api/me/export            all my data as JSON
//   DELETE /api/me                   delete my account
// Plus GET /auth/github/callback (GitHub sends the user back here).
import { createHmac } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import type { Encryptor } from "../lib/crypto.js";
import type { AuthBackend } from "../auth/verifyToken.js";
import type { User } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { sign, verifySigned } from "../lib/util.js";
import type { GitHubApi } from "../services/github.js";
import type { MediaStore } from "../services/media.js";
import { handle, parse } from "./common.js";

export function meView(u: User, config: Config, crypto: Encryptor) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    bio: u.bio,
    website: u.website,
    github: u.githubLogin,
    githubPrivateAccess: Boolean(u.githubScope?.split(/[ ,]/).includes("repo")),
    payoutInfo: u.payoutInfoEnc ? crypto.decryptText(u.payoutInfoEnc) : null,
    termsAccepted: Boolean(u.termsAcceptedAt && u.termsVersion === config.TERMS_VERSION),
    termsVersion: config.TERMS_VERSION,
    commissionPercent: config.COMMISSION_PERCENT,
    isAdmin: config.ADMIN_EMAILS.includes(u.email),
    githubEnabled: Boolean(config.GITHUB_CLIENT_ID),
    createdAt: u.createdAt,
  };
}

const profileBody = z.object({
  displayName: z.string().trim().min(2).max(60).optional(),
  bio: z.string().trim().max(1000).optional(),
  website: z.union([z.string().trim().url().max(200), z.literal("")]).optional(),
  payoutInfo: z.string().trim().max(300).optional(),
});

export function meRouter(prisma: Db, config: Config, crypto: Encryptor, github: GitHubApi, media: MediaStore, auth: AuthBackend) {
  const router = Router();
  const stateSecret = createHmac("sha256", config.ENCRYPTION_KEY).update("github-oauth-state").digest("hex");
  const redirectUri = `${config.PUBLIC_BASE_URL}/auth/github/callback`;

  router.get("/api/me", (req, res) => res.json(meView(req.user!, config, crypto)));

  router.patch(
    "/api/me",
    handle(async (req, res) => {
      const b = parse(profileBody, req.body);
      const u = await prisma.user.update({
        where: { id: req.user!.id },
        data: {
          ...(b.displayName !== undefined ? { displayName: b.displayName } : {}),
          ...(b.bio !== undefined ? { bio: b.bio || null } : {}),
          ...(b.website !== undefined ? { website: b.website || null } : {}),
          ...(b.payoutInfo !== undefined ? { payoutInfoEnc: b.payoutInfo ? crypto.encryptText(b.payoutInfo) : null } : {}),
        },
      });
      res.json(meView(u, config, crypto));
    }),
  );

  router.post(
    "/api/me/terms",
    handle(async (req, res) => {
      parse(z.object({ accept: z.literal(true) }), req.body);
      const u = await prisma.user.update({ where: { id: req.user!.id }, data: { termsAcceptedAt: new Date(), termsVersion: config.TERMS_VERSION } });
      await audit(prisma, req, { action: "user.accept_terms", targetType: "user", targetId: u.id, meta: { version: config.TERMS_VERSION } });
      res.json(meView(u, config, crypto));
    }),
  );

  router.get("/api/me/github/connect", (req, res) => {
    if (!config.GITHUB_CLIENT_ID) return res.status(503).json({ error: "GitHub connection isn't set up on this server yet." });
    const state = sign(req.user!.id, stateSecret, 600);
    res.json({ url: github.authorizeUrl(state, redirectUri, req.query.private === "1") });
  });

  router.delete(
    "/api/me/github",
    handle(async (req, res) => {
      const u = await prisma.user.update({ where: { id: req.user!.id }, data: { githubLogin: null, githubTokenEnc: null, githubScope: null } });
      await audit(prisma, req, { action: "user.github_disconnect", targetType: "user", targetId: u.id });
      res.json(meView(u, config, crypto));
    }),
  );

  router.get(
    "/api/me/export",
    handle(async (req, res) => {
      const id = req.user!.id;
      const [listings, offers, messages, deals] = await Promise.all([
        prisma.listing.findMany({ where: { sellerId: id }, include: { assets: { select: { kind: true, reference: true, verifiedAt: true } } } }),
        prisma.offer.findMany({ where: { buyerId: id } }),
        prisma.message.findMany({ where: { senderId: id } }),
        prisma.transaction.findMany({ where: { OR: [{ buyerId: id }, { sellerId: id }] }, include: { tasks: true } }),
      ]);
      await audit(prisma, req, { action: "user.export", targetType: "user", targetId: id });
      res.setHeader("Content-Disposition", 'attachment; filename="secondlife-export.json"');
      res.json({
        account: meView(req.user!, config, crypto),
        listings,
        offers,
        messages,
        deals,
      });
    }),
  );

  router.delete(
    "/api/me",
    handle(async (req, res) => {
      parse(z.object({ confirm: z.literal("DELETE") }), req.body);
      const u = req.user!;
      const open = await prisma.transaction.count({
        where: { OR: [{ buyerId: u.id }, { sellerId: u.id }], escrowStatus: { in: ["awaiting_payment", "funded", "release_approved", "disputed"] } },
      });
      if (open) return res.status(409).json({ error: "Finish or cancel your open deals before deleting your account." });
      const closedDeals = await prisma.transaction.count({ where: { OR: [{ buyerId: u.id }, { sellerId: u.id }] } });
      const myListings = await prisma.listing.findMany({ where: { sellerId: u.id }, select: { id: true } });
      for (const l of myListings) await media.removeListing(l.id);
      if (closedDeals) {
        // Completed deals are kept for accounting; the person behind them is anonymised.
        await prisma.listing.updateMany({ where: { sellerId: u.id, status: { not: "sold" } }, data: { status: "removed" } });
        await prisma.user.update({
          where: { id: u.id },
          data: {
            email: `deleted-${u.id}@deleted.invalid`,
            firebaseUid: `deleted:${u.id}`,
            displayName: "Deleted user",
            bio: null,
            website: null,
            githubLogin: null,
            githubTokenEnc: null,
            githubScope: null,
            payoutInfoEnc: null,
            banned: true,
          },
        });
      } else {
        await prisma.user.delete({ where: { id: u.id } });
      }
      await auth.deleteUser(u.firebaseUid);
      await audit(prisma, req, { action: "user.delete_account", targetType: "user", targetId: u.id });
      res.json({ ok: true });
    }),
  );

  // GitHub sends the browser here after the user approves. No login header on this request,
  // so the signed, expiring "state" tells us which user started it.
  router.get(
    "/auth/github/callback",
    handle(async (req, res) => {
      const userId = typeof req.query.state === "string" ? verifySigned(req.query.state, stateSecret) : null;
      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!userId || !code) return res.redirect("/app#profile?github=failed");
      const result = await github.exchangeCode(code, redirectUri);
      const login = result ? await github.getLogin(result.token) : null;
      if (!result || !login) return res.redirect("/app#profile?github=failed");
      await prisma.user.update({
        where: { id: userId },
        data: { githubLogin: login, githubTokenEnc: crypto.encryptText(result.token), githubScope: result.scope },
      });
      await audit(prisma, { user: { id: userId, email: "" }, ip: req.ip }, { action: "user.github_connect", targetType: "user", targetId: userId, meta: { login, scope: result.scope } });
      res.redirect("/app#profile?github=connected");
    }),
  );

  return router;
}
