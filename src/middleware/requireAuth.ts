// Protects API routes: a request without a valid login gets 401; a banned user gets 403.
// On success it finds (or creates, on first login) the user's row and puts it on req.user.
// A listing an admin created for a seller (cold start) is claimed automatically when that
// seller first logs in with the same email.
import type { NextFunction, Request, Response } from "express";
import type { AuthBackend } from "../auth/verifyToken.js";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import type { User } from "../generated/prisma/client.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function requireAuth(prisma: Db, auth: AuthBackend) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return res.status(401).json({ error: "Log in to continue." });

    const identity = await auth.verify(token);
    if (!identity) return res.status(401).json({ error: "Your session has expired. Log in again." });

    let user = await prisma.user.findUnique({ where: { firebaseUid: identity.uid } });
    if (!user) {
      user = await prisma.user.upsert({
        where: { email: identity.email },
        update: { firebaseUid: identity.uid },
        create: { firebaseUid: identity.uid, email: identity.email },
      });
      await audit(prisma, { user, ip: req.ip }, { action: "user.login_first", targetType: "user", targetId: user.id });
    }
    if (user.banned) return res.status(403).json({ error: "This account has been suspended. Contact support." });
    req.user = user;
    next();
  };
}

export function requireAdmin(prisma: Db, adminEmails: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !adminEmails.includes(req.user.email)) {
      await audit(prisma, req, { action: "admin.denied", meta: { path: req.originalUrl } });
      return res.status(403).json({ error: "Admins only." });
    }
    await audit(prisma, req, { action: `admin.${req.method.toLowerCase()}`, meta: { path: req.originalUrl } });
    next();
  };
}
