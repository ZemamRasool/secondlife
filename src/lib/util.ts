// Small helpers used across the app.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** "My Cool App!!" → "my-cool-app" (plus a short random suffix so slugs never clash). */
export function slugify(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "listing"}-${randomBytes(3).toString("hex")}`;
}

/** Normalise tech tags: lower case, trimmed, unique, max 12. */
export function cleanTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const v = t.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 30);
    if (/^[a-z0-9.+#-]+$/.test(v)) out.add(v);
  }
  return [...out].slice(0, 12);
}

/** "https://www.Example.com/path" → "example.com". Returns null if it isn't a domain. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}

/** "https://github.com/Owner/Repo.git" or "owner/repo" → "owner/repo". */
export function normalizeRepo(input: string): string | null {
  const s = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s) ? s : null;
}

export const randomToken = (bytes = 16) => randomBytes(bytes).toString("hex");

/** Signed, expiring value (used for the GitHub OAuth "state"). */
export function sign(value: string, secret: string, ttlSeconds: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ v: value, exp })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySigned(token: string, secret: string, now = Date.now()): string | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { v, exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof v !== "string" || typeof exp !== "number" || exp * 1000 < now) return null;
    return v;
  } catch {
    return null;
  }
}

export function money(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Commission in whole cents (10% of $1,234.56 = $123.46). */
export function commissionCents(amountCents: number, percent: number): number {
  return Math.round((amountCents * percent) / 100);
}

/** Checks what an uploaded image really is from its first bytes. */
export function sniffImage(data: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
