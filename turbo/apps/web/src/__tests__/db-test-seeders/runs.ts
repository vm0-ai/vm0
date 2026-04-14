import { eq } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { zeroRuns } from "../../db/schema/zero-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { initServices } from "../../lib/init-services";
import { uniqueId } from "../test-helpers";

/**
 * Resolve orgId from a compose version ID.
 *
 * @why-db-direct No API endpoint exposes orgId lookups by compose version.
 * Used internally by seeders that insert agent_runs records.
 */
export async function getOrgIdFromVersion(versionId: string): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.id, agentComposeVersions.composeId),
    )
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  if (!row) {
    throw new Error(`Compose version ${versionId} not found`);
  }
  return row.orgId;
}

/**
 * Create a run record directly in the database.
 * Internal helper used by seedTestRun.
 */
async function createRunDirect(
  userId: string,
  versionId: string,
  orgId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    scheduleId?: string;
    triggerSource?: string;
    createdAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
    result?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: options?.status ?? "running",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      ...(options?.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options?.startedAt ? { startedAt: options.startedAt } : {}),
      ...(options?.completedAt ? { completedAt: options.completedAt } : {}),
      ...(options?.result ? { result: options.result } : {}),
    })
    .returning({ id: agentRuns.id });

  await globalThis.services.db.insert(zeroRuns).values({
    id: run!.id,
    triggerSource: options?.triggerSource ?? "cli",
    scheduleId: options?.scheduleId ?? null,
  });

  return run!;
}

/**
 * Seed a run record directly in the database, bypassing the API route and dispatch.
 *
 * @why-db-direct PostgreSQL defaultNow() controls createdAt/startedAt/completedAt
 * timestamps at the DB level. vi.setSystemTime() does not affect DB defaults.
 * Tests for date-range logic (cron aggregation, usage boundaries, cleanup TTLs)
 * need runs placed at specific historical dates. Additionally, the API always
 * triggers dispatch (runner_job_queue inserts, Ably notifications) which many
 * tests do not need or want as side effects.
 */
export async function seedTestRun(
  userId: string,
  agentComposeId: string,
  options?: {
    status?: string;
    prompt?: string;
    continuedFromSessionId?: string;
    scheduleId?: string;
    triggerSource?: string;
    createdAt?: Date;
    orgId?: string;
    startedAt?: Date;
    completedAt?: Date;
    result?: Record<string, unknown>;
  },
): Promise<{ runId: string }> {
  initServices();

  // Look up orgId from compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Create a version for the run
  const versionId = uniqueId("version");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: agentComposeId,
    content: { name: "test-agent", model: "claude-3-5-sonnet-20241022" },
    createdBy: userId,
  });
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, agentComposeId));

  // Create run directly (use provided orgId or fall back to compose orgId)
  const run = await createRunDirect(
    userId,
    versionId,
    options?.orgId ?? compose.orgId,
    {
      status: options?.status ?? "pending",
      prompt: options?.prompt ?? "test prompt",
      continuedFromSessionId: options?.continuedFromSessionId,
      scheduleId: options?.scheduleId,
      triggerSource: options?.triggerSource,
      createdAt: options?.createdAt,
      startedAt: options?.startedAt,
      completedAt: options?.completedAt,
      result: options?.result,
    },
  );
  return { runId: run.id };
}

/**
 * Seed a completed agent run with controlled timestamps.
 *
 * @why-db-direct PostgreSQL defaultNow() controls createdAt which cannot be
 * set through the API or JavaScript fake timers. Tests for date-range logic
 * (cron aggregation, usage API boundaries) need runs placed at specific
 * historical dates.
 */
export async function seedCompletedTestRun(options: {
  composeVersionId: string;
  userId: string;
  createdAt: Date;
  startedAt: Date;
  completedAt: Date;
}): Promise<string> {
  initServices();

  const orgId = await getOrgIdFromVersion(options.composeVersionId);

  const [row] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: options.userId,
      orgId,
      agentComposeVersionId: options.composeVersionId,
      status: "completed",
      prompt: "test",
      createdAt: options.createdAt,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
    })
    .returning({ id: agentRuns.id });
  return row!.id;
}

/**
 * Seed a stale pending run directly into the database.
 *
 * @why-db-direct The API immediately transitions runs to "running" or "failed"
 * during dispatch. A run stuck in "pending" state past the cleanup TTL cannot
 * be reproduced through normal API flows. The stale lastHeartbeatAt timestamp
 * is also a DB-controlled value that cannot be set via the API.
 */
export async function seedStalePendingRun(
  userId: string,
  agentComposeVersionId: string,
  ageMs: number = 20 * 60 * 1000,
): Promise<string> {
  initServices();

  const orgId = await getOrgIdFromVersion(agentComposeVersionId);

  const staleCreatedAt = new Date(Date.now() - ageMs);
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId,
      status: "pending",
      prompt: "Stale pending run",
      createdAt: staleCreatedAt,
      lastHeartbeatAt: staleCreatedAt,
    })
    .returning({ id: agentRuns.id });

  if (!run) {
    throw new Error("Failed to insert stale pending run");
  }

  return run.id;
}

/**
 * Create a run with no compose version (simulates deleted compose).
 *
 * @why-db-direct The API requires a valid compose version to create a run.
 * A run whose compose has been deleted (agentComposeVersionId: null) cannot
 * be reproduced through normal API flows. Tests for orphan-run graceful
 * handling need this DB-direct seeder.
 */
export async function seedOrphanTestRun(
  userId: string,
  orgId: string,
  options?: { status?: string; prompt?: string },
): Promise<{ runId: string }> {
  initServices();

  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: null,
      status: options?.status ?? "completed",
      prompt: options?.prompt ?? "orphan run prompt",
    })
    .returning({ id: agentRuns.id });
  return { runId: run!.id };
}
