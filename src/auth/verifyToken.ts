// Checks who is calling the API.
//
// The browser logs in with Firebase and sends "Authorization: Bearer <ID token>".
// We ask Firebase to verify that token. We never see or store passwords.
//
// In AUTH_MODE=dev (local testing only) the token is "dev:<email>", so you can
// try the app before creating a Firebase project. config.ts blocks dev mode in production.
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { Config } from "../config.js";

export interface AuthUser {
  uid: string;
  email: string;
}

export interface AuthBackend {
  verify(token: string): Promise<AuthUser | null>;
  /** Remove the login itself (used when a user deletes their account). */
  deleteUser(uid: string): Promise<void>;
}

export function createAuthBackend(config: Config): AuthBackend {
  if (config.AUTH_MODE === "dev") {
    return {
      async verify(token) {
        const match = /^dev:([^\s@]+@[^\s@]+\.[^\s@]+)$/.exec(token);
        if (!match) return null;
        const email = match[1].toLowerCase();
        return { uid: `dev:${email}`, email };
      },
      async deleteUser() {},
    };
  }

  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        // .env files store the key on one line with "\n"; turn those back into line breaks
        privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  const auth = getAuth(app);

  return {
    async verify(token) {
      try {
        // true = also reject tokens of users who were disabled or signed out everywhere
        const decoded = await auth.verifyIdToken(token, true);
        if (!decoded.email || decoded.email_verified === false) return null;
        return { uid: decoded.uid, email: decoded.email.toLowerCase() };
      } catch {
        return null;
      }
    },
    async deleteUser(uid) {
      await auth.deleteUser(uid).catch(() => undefined);
    },
  };
}
