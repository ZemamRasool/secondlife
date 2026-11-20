// A small background job queue stored in PostgreSQL.
//
// Why: sending email, reading a GitHub repo and checking escrow take seconds. The website adds
// a job and answers at once; a worker does the slow part in the background.
// SPEC.md suggests BullMQ + Redis; a Postgres queue does the same job for this size
// with one less server to run. Workers use "FOR UPDATE SKIP LOCKED", so two workers
// never take the same job. Failed jobs are retried with a growing delay.
import type { Db } from "../lib/prisma.js";

export type JobType = "send_email" | "health_report" | "escrow_sync" | "auto_release";

export interface JobPayloads {
  send_email: { to: string; subject: string; text: string };
  health_report: { assetId: string };
  escrow_sync: Record<string, never>;
  auto_release: Record<string, never>;
}

export interface RunningJob<T extends JobType = JobType> {
  id: string;
  type: T;
  payload: JobPayloads[T];
  attempts: number;
  maxAttempts: number;
}

export type Handlers = { [T in JobType]: (job: RunningJob<T>) => Promise<void> };

// All times in SQL are UTC, matching how Prisma stores DateTime.
const NOW = `(now() AT TIME ZONE 'UTC')`;

export async function enqueue<T extends JobType>(prisma: Db, type: T, payload: JobPayloads[T], opts: { delaySeconds?: number } = {}) {
  const runAt = new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000);
  return prisma.job.create({ data: { type, payload: payload as object, runAt } });
}

/** Take the next due job, or null if there is none. */
export async function claimNext(prisma: Db): Promise<RunningJob | null> {
  const rows = await prisma.$queryRawUnsafe<
    { id: string; type: JobType; payload: unknown; attempts: number; max_attempts: number }[]
  >(`
    UPDATE jobs SET status = 'running', locked_at = ${NOW}, attempts = attempts + 1, updated_at = ${NOW}
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= ${NOW}
      ORDER BY run_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, max_attempts`);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, type: row.type, payload: row.payload as never, attempts: row.attempts, maxAttempts: row.max_attempts };
}

/** Jobs stuck in "running" (worker crashed) go back to the queue. */
export async function requeueStale(prisma: Db, olderThanMinutes = 15): Promise<number> {
  return prisma.$executeRawUnsafe(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ${NOW}
     WHERE status = 'running' AND locked_at < ${NOW} - ($1 || ' minutes')::interval`,
    String(olderThanMinutes),
  );
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly prisma: Db,
    private readonly handlers: Handlers,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  /** Run one job. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await claimNext(this.prisma);
    if (!job) return false;
    try {
      const handler = this.handlers[job.type] as (j: RunningJob) => Promise<void>;
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job);
      await this.prisma.job.update({ where: { id: job.id }, data: { status: "done", lockedAt: null, lastError: null } });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const final = job.attempts >= job.maxAttempts;
      // Wait 30s, 60s, 120s… before trying again.
      const delay = 30 * 2 ** (job.attempts - 1);
      await this.prisma.job.update({
        where: { id: job.id },
        data: final
          ? { status: "failed", lockedAt: null, lastError: message }
          : { status: "queued", lockedAt: null, lastError: message, runAt: new Date(Date.now() + delay * 1000) },
      });
      this.log(`job ${job.type} ${job.id} ${final ? "failed" : "will retry"}: ${message}`);
    }
    return true;
  }

  /** Run jobs until the queue is empty (used by tests and after a burst). */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  start(intervalMs = 2000) {
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await requeueStale(this.prisma);
        await this.drain(50);
      } catch (err) {
        this.log(`worker error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.busy = false;
      }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    void tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
