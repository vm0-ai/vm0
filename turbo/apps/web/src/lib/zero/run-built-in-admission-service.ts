import { runBuiltInAdmissions } from "@vm0/db/schema/run-built-in-admission";
import { and, count, eq, lte, sql } from "drizzle-orm";

import type { Database } from "../../types/global";

const RUN_BUILT_IN_MAX_IN_FLIGHT = 3;
const RUN_BUILT_IN_MAX_STARTED = 50;
const RUN_BUILT_IN_ADMISSION_TTL_MS = 30 * 60 * 1000;

type RunBuiltInGenerationKind = "image" | "video" | "presentation" | "voice";

interface RunBuiltInAdmission {
  readonly id: string;
}

function runBuiltInAdmissionError(message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status: 429 });
}

export async function startRunBuiltInAdmission(
  db: Database,
  args: {
    readonly runId: string | undefined;
    readonly kind: RunBuiltInGenerationKind;
  },
): Promise<RunBuiltInAdmission | Response | null> {
  if (!args.runId) {
    return null;
  }

  const runId = args.runId;
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('run_builtin_' || ${runId}))`,
    );

    const now = new Date();
    await tx
      .update(runBuiltInAdmissions)
      .set({ status: "expired", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(runBuiltInAdmissions.runId, runId),
          eq(runBuiltInAdmissions.status, "active"),
          lte(runBuiltInAdmissions.expiresAt, now),
        ),
      );

    const [activeResult] = await tx
      .select({ total: count() })
      .from(runBuiltInAdmissions)
      .where(
        and(
          eq(runBuiltInAdmissions.runId, runId),
          eq(runBuiltInAdmissions.status, "active"),
        ),
      );
    if (Number(activeResult?.total ?? 0) >= RUN_BUILT_IN_MAX_IN_FLIGHT) {
      return runBuiltInAdmissionError(
        "This run has too many built-in generations in progress. Wait for one to finish and try again.",
        "BUILT_IN_RUN_CONCURRENCY_LIMIT",
      );
    }

    const [startedResult] = await tx
      .select({ total: count() })
      .from(runBuiltInAdmissions)
      .where(eq(runBuiltInAdmissions.runId, runId));
    if (Number(startedResult?.total ?? 0) >= RUN_BUILT_IN_MAX_STARTED) {
      return runBuiltInAdmissionError(
        "This run has reached the built-in generation limit. Start a new run to continue.",
        "BUILT_IN_RUN_USAGE_LIMIT",
      );
    }

    const expiresAt = new Date(now.getTime() + RUN_BUILT_IN_ADMISSION_TTL_MS);
    const [row] = await tx
      .insert(runBuiltInAdmissions)
      .values({
        runId,
        kind: args.kind,
        status: "active",
        expiresAt,
      })
      .returning({ id: runBuiltInAdmissions.id });
    if (!row) {
      throw new Error("run built-in admission insert returned no row");
    }

    return row;
  });
}

export async function completeRunBuiltInAdmission(
  db: Database,
  args: {
    readonly admission: RunBuiltInAdmission | null;
    readonly status: "completed" | "failed";
  },
): Promise<void> {
  if (!args.admission) {
    return;
  }

  const now = new Date();
  await db
    .update(runBuiltInAdmissions)
    .set({
      status: args.status,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(runBuiltInAdmissions.id, args.admission.id),
        eq(runBuiltInAdmissions.status, "active"),
      ),
    );
}
