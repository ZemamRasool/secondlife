// "Log who accessed what" (SPEC.md security basics).
// Every sensitive action and every admin page view writes one row to audit_logs.
import type { Db } from "./prisma.js";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

/** Who did it: an Express request works here, or { user, ip } directly. */
export interface Actor {
  user?: { id: string; email: string };
  ip?: string;
}

export async function audit(prisma: Db, req: Actor | null, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: req?.user?.id ?? null,
        actorEmail: req?.user?.email ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ip: req?.ip ?? null,
        meta: (entry.meta ?? undefined) as object | undefined,
      },
    });
  } catch (err) {
    // Logging must never break the user's request, but we want to hear about it.
    console.error("audit log write failed", err);
  }
}
