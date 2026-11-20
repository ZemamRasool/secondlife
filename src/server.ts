// Starts the website. By default it also runs the background worker (WORKER_INLINE=true).
// For more traffic, set WORKER_INLINE=false and run `npm run worker` separately.
import { bootstrap } from "./bootstrap.js";
import { createApp } from "./app.js";

const { config, prisma, deps, worker, tick } = await bootstrap();
const app = createApp(deps);

if (config.AUTH_MODE === "dev") console.warn("⚠  AUTH_MODE=dev: anyone can log in as any email. Local testing only.");
if (config.MAIL_PROVIDER === "console") console.warn("⚠  MAIL_PROVIDER=console: emails are printed here, not sent.");
if (!config.GITHUB_CLIENT_ID) console.warn("⚠  GITHUB_CLIENT_ID is empty: sellers can't verify repositories yet.");
if (config.ADMIN_EMAILS.length === 0) console.warn("⚠  ADMIN_EMAILS is empty: nobody can open /admin or approve listings.");

if (config.WORKER_INLINE) {
  worker.start();
  void tick();
  setInterval(tick, 10 * 60 * 1000).unref();
}

const server = app.listen(config.PORT, () => console.log(`SecondLife running on port ${config.PORT} (${config.PUBLIC_BASE_URL})`));

const shutdown = async () => {
  worker.stop();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
