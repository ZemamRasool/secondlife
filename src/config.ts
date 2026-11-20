// Reads settings from environment variables (.env) and checks them once at startup.
// If something required is missing or unsafe, the server refuses to start with a clear message.
import "dotenv/config";
import { z } from "zod";

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    // 32 random bytes as 64 hex characters. Encrypts GitHub tokens and payout details.
    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 random bytes)"),

    GEMINI_API_KEY: z.string().default(""),
    GEMINI_MODEL: z.string().default("gemini-3.5-flash"),

    AUTH_MODE: z.enum(["firebase", "dev"]).default("firebase"),
    FIREBASE_PROJECT_ID: z.string().default(""),
    FIREBASE_CLIENT_EMAIL: z.string().default(""),
    FIREBASE_PRIVATE_KEY: z.string().default(""),
    FIREBASE_WEB_API_KEY: z.string().default(""),
    FIREBASE_WEB_AUTH_DOMAIN: z.string().default(""),

    ADMIN_EMAILS: z.string().default("").transform((v) => csv(v).map((e) => e.toLowerCase())),

    // GitHub OAuth app (github.com/settings/developers). Callback: PUBLIC_BASE_URL/auth/github/callback
    GITHUB_CLIENT_ID: z.string().default(""),
    GITHUB_CLIENT_SECRET: z.string().default(""),

    // Email notifications (offers, messages, deals). "console" prints them; "postmark" sends them.
    MAIL_PROVIDER: z.enum(["console", "postmark"]).default("console"),
    POSTMARK_SERVER_TOKEN: z.string().default(""),
    MAIL_FROM: z.string().default("SecondLife <hello@secondlife.example>"),

    // Escrow: "manual" = you run each deal on Escrow.com's website and record it in /admin.
    //         "escrowcom" = deals are created through the Escrow.com API (needs an Escrow.com account).
    ESCROW_PROVIDER: z.enum(["manual", "escrowcom"]).default("manual"),
    ESCROWCOM_EMAIL: z.string().default(""),
    ESCROWCOM_API_KEY: z.string().default(""),
    ESCROWCOM_API_URL: z.string().url().default("https://api.escrow-sandbox.com/2017-09-01"),

    COMMISSION_PERCENT: z.coerce.number().min(0).max(30).default(10),
    // Days the buyer has to report a problem after the seller finishes the handover.
    CONFIRM_WINDOW_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    MIN_PRICE_USD: z.coerce.number().min(1).default(10),
    TERMS_VERSION: z.string().default("2026-11-06"),

    UPLOAD_DIR: z.string().default("./uploads"),
    MAX_IMAGE_MB: z.coerce.number().positive().max(10).default(5),
    MAX_IMAGES: z.coerce.number().int().min(1).max(20).default(8),

    WORKER_INLINE: z
      .string()
      .default("true")
      .transform((v) => v !== "false"),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.AUTH_MODE === "dev" && env.NODE_ENV === "production") issue("AUTH_MODE", "AUTH_MODE=dev is not allowed in production");
    if (env.AUTH_MODE === "firebase" && env.NODE_ENV !== "test") {
      for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const) {
        if (!env[key]) issue(key, `${key} is required when AUTH_MODE=firebase`);
      }
    }
    if (env.NODE_ENV === "production") {
      if (!env.PUBLIC_BASE_URL.startsWith("https://")) issue("PUBLIC_BASE_URL", "Must be https:// in production");
      if (env.MAIL_PROVIDER === "console") issue("MAIL_PROVIDER", "Use postmark in production so people get their emails");
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) issue("GITHUB_CLIENT_ID", "GitHub OAuth is required in production (ownership proof)");
    }
    if (env.MAIL_PROVIDER === "postmark" && !env.POSTMARK_SERVER_TOKEN) issue("POSTMARK_SERVER_TOKEN", "Required when MAIL_PROVIDER=postmark");
    if (env.ESCROW_PROVIDER === "escrowcom" && (!env.ESCROWCOM_EMAIL || !env.ESCROWCOM_API_KEY)) {
      issue("ESCROWCOM_API_KEY", "ESCROWCOM_EMAIL and ESCROWCOM_API_KEY are required when ESCROW_PROVIDER=escrowcom");
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
