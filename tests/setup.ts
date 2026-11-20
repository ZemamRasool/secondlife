// Test settings: separate test database, dev login, temp upload folder, test keys.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "dev";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://secondlife:secondlife@127.0.0.1:5432/secondlife_test?schema=public";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "sl-uploads-"));
process.env.GEMINI_API_KEY = "";
process.env.ADMIN_EMAILS = "boss@example.com";
process.env.GITHUB_CLIENT_ID = "test-client";
process.env.GITHUB_CLIENT_SECRET = "test-secret";
process.env.MAIL_PROVIDER = "console";
process.env.ESCROW_PROVIDER = "manual";
process.env.COMMISSION_PERCENT = "10";
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
