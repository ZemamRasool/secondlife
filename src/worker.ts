// Background worker on its own (npm run worker): emails, health reports, escrow checks, auto-release.
import { bootstrap } from "./bootstrap.js";

const { prisma, worker, tick } = await bootstrap();
worker.start(1000);
void tick();
setInterval(tick, 10 * 60 * 1000);
console.log("SecondLife worker started");

const shutdown = async () => {
  worker.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
