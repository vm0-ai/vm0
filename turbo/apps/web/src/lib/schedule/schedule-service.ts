import { eq, and, lte, inArray, desc } from "drizzle-orm";
import { Cron } from "croner";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { agentSchedules } from "../../db/schema/agent-schedule";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { scopes } from "../../db/schema/scope";
import { decryptSecretsMap } from "../crypto";
import {
  notFound,
  badRequest,
  schedulePast,
  isConcurrentRunLimit,
  type ConcurrentRunLimitError,
} from "../errors";
import { logger } from "../logger";
import {
  checkRunConcurrencyLimit,
  buildExecutionContext,
  prepareAndDispatchRun,
} from "../run/run-service";
import { generateSandboxToken } from "../auth/sandbox-token";
import { getUserScopeByClerkId } from "../scope/scope-service";
import { getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";

const log = logger("service:schedule");

// Retry configuration for concurrency failures
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Schedule data for API responses
 */
export interface ScheduleResponse {
  id: string;
  composeId: string;
  composeName: string;
  scopeSlug: string;
  name: string;
  cronExpression: string | null;
  atTime: string | null;
  timezone: string;
  prompt: string;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
  artifactName: string | null;
  artifactVersion: string | null;
  volumeVersions: Record<string, string> | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  retryStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Run summary for schedule runs list
 */
interface RunSummary {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout";
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

/**
 * Deploy schedule request data
 * Note: vars and secrets are no longer accepted - they must be managed via platform tables
 */
interface DeployScheduleRequest {
  name: string;
  composeId: string;
  cronExpression?: string;
  atTime?: string;
  timezone: string;
  prompt: string;
  // vars and secrets removed - now managed via platform tables
  artifactName?: string;
  artifactVersion?: string;
  volumeVersions?: Record<string, string>;
}

/**
 * Validate timezone using Intl API
 */
function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract required configuration from compose content
 */
function extractRequiredConfiguration(composeContent: unknown): {
  secrets: string[];
  vars: string[];
  credentials: string[];
} {
  const result = {
    secrets: [] as string[],
    vars: [] as string[],
    credentials: [] as string[],
  };
  if (!composeContent) return result;

  const refs = extractVariableReferences(composeContent);
  const grouped = groupVariablesBySource(refs);

  result.secrets = grouped.secrets.map((r) => r.name);
  result.vars = grouped.vars.map((r) => r.name);
  result.credentials = grouped.credentials.map((r) => r.name);

  return result;
}

/**
 * Build error message for missing configuration
 */
function buildMissingConfigError(missing: {
  secrets: string[];
  vars: string[];
  credentials: string[];
}): string {
  const parts: string[] = [];

  if (missing.secrets.length > 0) {
    parts.push(`Secrets: ${missing.secrets.join(", ")}`);
  }
  if (missing.vars.length > 0) {
    parts.push(`Vars: ${missing.vars.join(", ")}`);
  }
  if (missing.credentials.length > 0) {
    parts.push(`Credentials: ${missing.credentials.join(", ")}`);
  }

  return `Missing required configuration:\n  ${parts.join("\n  ")}`;
}

/**
 * Calculate next run time from cron expression and timezone
 */
function calculateNextRun(
  cronExpression: string,
  timezone: string,
): Date | null {
  const cron = new Cron(cronExpression, { timezone });
  const nextRun = cron.nextRun();
  return nextRun;
}

/**
 * Convert schedule row to API response format
 */
function toResponse(
  schedule: typeof agentSchedules.$inferSelect,
  composeName: string,
  scopeSlug: string,
): ScheduleResponse {
  // Extract secret names from encrypted secrets (values are never returned)
  let secretNames: string[] | null = null;
  if (schedule.encryptedSecrets) {
    const secrets = decryptSecretsMap(
      schedule.encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );
    if (secrets) {
      secretNames = Object.keys(secrets);
    }
  }

  return {
    id: schedule.id,
    composeId: schedule.composeId,
    composeName,
    scopeSlug,
    name: schedule.name,
    cronExpression: schedule.cronExpression,
    atTime: schedule.atTime?.toISOString() ?? null,
    timezone: schedule.timezone,
    prompt: schedule.prompt,
    vars: schedule.vars,
    secretNames,
    artifactName: schedule.artifactName,
    artifactVersion: schedule.artifactVersion,
    volumeVersions: schedule.volumeVersions,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    retryStartedAt: schedule.retryStartedAt?.toISOString() ?? null,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

/**
 * Verify user owns the compose
 */
async function verifyComposeOwnership(
  userId: string,
  composeId: string,
): Promise<{
  compose: typeof agentComposes.$inferSelect;
  scopeSlug: string;
}> {
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(
      and(eq(agentComposes.id, composeId), eq(agentComposes.userId, userId)),
    )
    .limit(1);

  if (!compose) {
    throw notFound("Agent compose not found or not owned by user");
  }

  // Get scope slug for response
  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, compose.scopeId))
    .limit(1);

  return {
    compose,
    scopeSlug: scope?.slug ?? "default",
  };
}

/**
 * Deploy (create or update) a schedule
 * Idempotent: creates if doesn't exist, updates if exists
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
export async function deploySchedule(
  userId: string,
  request: DeployScheduleRequest,
): Promise<{ schedule: ScheduleResponse; created: boolean }> {
  log.debug(
    `Deploying schedule ${request.name} for compose ${request.composeId}`,
  );

  // Verify user owns the compose
  const { compose, scopeSlug } = await verifyComposeOwnership(
    userId,
    request.composeId,
  );

  // Validate timezone
  if (!isValidTimezone(request.timezone)) {
    throw badRequest(`Invalid timezone: ${request.timezone}`);
  }

  // Check for existing schedule with same name on this compose (needed for validation)
  const [existing] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, request.composeId),
        eq(agentSchedules.name, request.name),
      ),
    )
    .limit(1);

  // Initial version: enforce 1:1 constraint (one schedule per agent)
  if (!existing) {
    const existingSchedules = await globalThis.services.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.composeId, request.composeId))
      .limit(1);

    if (existingSchedules.length > 0) {
      throw badRequest(
        "This agent already has a schedule. Please edit the existing schedule or delete it first.",
      );
    }
  }

  // Validate required secrets/vars against platform tables
  // Secrets and vars are now managed via platform (vm0 secret set / vm0 var set),
  // not passed via schedule creation
  if (compose.headVersionId) {
    const [version] = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version) {
      const required = extractRequiredConfiguration(version.content);

      // Fetch platform-managed secrets and vars
      const userScope = await getUserScopeByClerkId(userId);
      let platformSecretNames: string[] = [];
      let platformVarNames: string[] = [];

      if (userScope) {
        const platformSecrets = await getSecretValues(userScope.id, "user");
        platformSecretNames = Object.keys(platformSecrets);
        log.debug(
          `Fetched ${platformSecretNames.length} platform secret(s) for validation`,
        );

        const platformVars = await getVariableValues(userScope.id);
        platformVarNames = Object.keys(platformVars);
        log.debug(
          `Fetched ${platformVarNames.length} platform variable(s) for validation`,
        );
      }

      const missingSecrets = required.secrets.filter(
        (name) => !platformSecretNames.includes(name),
      );
      const missingVars = required.vars.filter(
        (name) => !platformVarNames.includes(name),
      );
      // Credentials are not provided via schedule setup (they come from platform)
      // so we don't validate them here

      if (missingSecrets.length > 0 || missingVars.length > 0) {
        throw badRequest(
          buildMissingConfigError({
            secrets: missingSecrets,
            vars: missingVars,
            credentials: [],
          }),
        );
      }
    }
  }

  // Note: vars and encryptedSecrets are no longer stored in schedule table
  // They are now managed via platform tables (secrets, variables)
  // We set them to null for new schedules to maintain schema compatibility

  // Calculate next run time
  let nextRunAt: Date | null = null;
  if (request.cronExpression) {
    nextRunAt = calculateNextRun(request.cronExpression, request.timezone);
  } else if (request.atTime) {
    nextRunAt = new Date(request.atTime);
  }

  const now = new Date(Date.now());

  if (existing) {
    // Update existing schedule
    const [updated] = await globalThis.services.db
      .update(agentSchedules)
      .set({
        cronExpression: request.cronExpression ?? null,
        atTime: request.atTime ? new Date(request.atTime) : null,
        timezone: request.timezone,
        prompt: request.prompt,
        vars: null, // Vars now come from platform tables
        encryptedSecrets: null, // Secrets now come from platform tables
        artifactName: request.artifactName ?? null,
        artifactVersion: request.artifactVersion ?? null,
        volumeVersions: request.volumeVersions ?? null,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, existing.id))
      .returning();

    if (!updated) {
      throw new Error(`Failed to update schedule ${request.name}`);
    }

    log.debug(`Updated schedule ${request.name} (${existing.id})`);

    return {
      schedule: toResponse(updated, compose.name, scopeSlug),
      created: false,
    };
  } else {
    // Create new schedule
    const [created] = await globalThis.services.db
      .insert(agentSchedules)
      .values({
        composeId: request.composeId,
        name: request.name,
        cronExpression: request.cronExpression ?? null,
        atTime: request.atTime ? new Date(request.atTime) : null,
        timezone: request.timezone,
        prompt: request.prompt,
        vars: null, // Vars now come from platform tables
        encryptedSecrets: null, // Secrets now come from platform tables
        artifactName: request.artifactName ?? null,
        artifactVersion: request.artifactVersion ?? null,
        volumeVersions: request.volumeVersions ?? null,
        enabled: false,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!created) {
      throw new Error(`Failed to create schedule ${request.name}`);
    }

    log.debug(`Created schedule ${request.name} (${created.id})`);

    return {
      schedule: toResponse(created, compose.name, scopeSlug),
      created: true,
    };
  }
}

/**
 * List all schedules for a user
 */
export async function listSchedules(
  userId: string,
): Promise<ScheduleResponse[]> {
  log.debug(`Listing schedules for user ${userId}`);

  // Get all composes owned by user
  const composesQuery = globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId));

  const userComposes = await composesQuery;

  if (userComposes.length === 0) {
    return [];
  }

  // Get scopes for all composes
  const scopeIds = [...new Set(userComposes.map((c) => c.scopeId))];
  const scopeRows = await globalThis.services.db
    .select()
    .from(scopes)
    .where(inArray(scopes.id, scopeIds));

  const scopeMap = new Map(scopeRows.map((s) => [s.id, s.slug]));

  // Get schedules for user's composes
  const composeIds = userComposes.map((c) => c.id);
  const schedules = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(inArray(agentSchedules.composeId, composeIds));

  // Build response with compose names
  const composeMap = new Map(userComposes.map((c) => [c.id, c]));
  return schedules.map((schedule) => {
    const compose = composeMap.get(schedule.composeId);
    return toResponse(
      schedule,
      compose?.name ?? "unknown",
      scopeMap.get(compose?.scopeId ?? "") ?? "default",
    );
  });
}

/**
 * Get schedule by name and compose ID
 */
export async function getScheduleByName(
  userId: string,
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Getting schedule ${name} for compose ${composeId}`);

  // Verify user owns the compose
  const { compose, scopeSlug } = await verifyComposeOwnership(
    userId,
    composeId,
  );

  const [schedule] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, composeId),
        eq(agentSchedules.name, name),
      ),
    )
    .limit(1);

  if (!schedule) {
    throw notFound(`Schedule '${name}' not found`);
  }

  return toResponse(schedule, compose.name, scopeSlug);
}

/**
 * Get recent runs for a schedule
 */
export async function getScheduleRecentRuns(
  userId: string,
  composeId: string,
  scheduleName: string,
  limit: number,
): Promise<RunSummary[]> {
  log.debug(
    `Getting recent runs for schedule ${scheduleName} (limit: ${limit})`,
  );

  // Verify ownership
  await verifyComposeOwnership(userId, composeId);

  // Get schedule
  const [schedule] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, composeId),
        eq(agentSchedules.name, scheduleName),
      ),
    )
    .limit(1);

  if (!schedule) {
    throw notFound(`Schedule '${scheduleName}' not found`);
  }

  // Query runs for this schedule
  const runs = await globalThis.services.db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      completedAt: agentRuns.completedAt,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .where(eq(agentRuns.scheduleId, schedule.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);

  return runs.map((run) => ({
    id: run.id,
    status: run.status as RunSummary["status"],
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    error: run.error,
  }));
}

/**
 * Delete schedule by name and compose ID
 */
export async function deleteSchedule(
  userId: string,
  composeId: string,
  name: string,
): Promise<void> {
  log.debug(`Deleting schedule ${name} for compose ${composeId}`);

  // Verify user owns the compose
  await verifyComposeOwnership(userId, composeId);

  const result = await globalThis.services.db
    .delete(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, composeId),
        eq(agentSchedules.name, name),
      ),
    )
    .returning();

  if (result.length === 0) {
    throw notFound(`Schedule '${name}' not found`);
  }

  log.debug(`Deleted schedule ${name}`);
}

/**
 * Enable a schedule
 */
export async function enableSchedule(
  userId: string,
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Enabling schedule ${name} for compose ${composeId}`);

  const { compose, scopeSlug } = await verifyComposeOwnership(
    userId,
    composeId,
  );

  const [schedule] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, composeId),
        eq(agentSchedules.name, name),
      ),
    )
    .limit(1);

  if (!schedule) {
    throw notFound(`Schedule '${name}' not found`);
  }

  // Recalculate next run time
  let nextRunAt: Date | null = null;
  if (schedule.cronExpression) {
    nextRunAt = calculateNextRun(schedule.cronExpression, schedule.timezone);
  } else if (schedule.atTime) {
    // For one-time schedules, check if atTime is in the future
    if (schedule.atTime > new Date(Date.now())) {
      nextRunAt = schedule.atTime;
    } else {
      // Refuse to enable past one-time schedules
      throw schedulePast(
        `Cannot enable schedule: scheduled time ${schedule.atTime.toISOString()} has already passed`,
      );
    }
  }

  const [updated] = await globalThis.services.db
    .update(agentSchedules)
    .set({
      enabled: true,
      nextRunAt,
      retryStartedAt: null, // Clear any stale retry state
      updatedAt: new Date(Date.now()),
    })
    .where(eq(agentSchedules.id, schedule.id))
    .returning();

  if (!updated) {
    throw new Error(`Failed to enable schedule ${name}`);
  }

  log.debug(`Enabled schedule ${name}`);

  return toResponse(updated, compose.name, scopeSlug);
}

/**
 * Disable a schedule
 */
export async function disableSchedule(
  userId: string,
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Disabling schedule ${name} for compose ${composeId}`);

  const { compose, scopeSlug } = await verifyComposeOwnership(
    userId,
    composeId,
  );

  const [updated] = await globalThis.services.db
    .update(agentSchedules)
    .set({
      enabled: false,
      retryStartedAt: null, // Clear retry state
      updatedAt: new Date(Date.now()),
    })
    .where(
      and(
        eq(agentSchedules.composeId, composeId),
        eq(agentSchedules.name, name),
      ),
    )
    .returning();

  if (!updated) {
    throw notFound(`Schedule '${name}' not found`);
  }

  log.debug(`Disabled schedule ${name}`);

  return toResponse(updated, compose.name, scopeSlug);
}

/**
 * Execute due schedules
 * Called by cron job every minute
 */
export async function executeDueSchedules(): Promise<{
  executed: number;
  skipped: number;
}> {
  const now = new Date(Date.now());
  log.debug(`Checking for due schedules at ${now.toISOString()}`);

  // Find enabled schedules where nextRunAt <= now
  const dueSchedules = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(eq(agentSchedules.enabled, true), lte(agentSchedules.nextRunAt, now)),
    )
    .limit(10); // Process in batches

  let executed = 0;
  let skipped = 0;

  for (const schedule of dueSchedules) {
    // Skip if previous run is still active
    if (schedule.lastRunId) {
      const [lastRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, schedule.lastRunId))
        .limit(1);

      if (
        lastRun &&
        (lastRun.status === "pending" || lastRun.status === "running")
      ) {
        log.debug(
          `Skipping schedule ${schedule.name}: previous run still active`,
        );
        skipped++;
        continue;
      }
    }

    try {
      await executeSchedule(schedule);
      executed++;
    } catch (error) {
      log.error(`Failed to execute schedule ${schedule.name}:`, error);
      skipped++;
    }
  }

  log.debug(`Executed ${executed} schedules, skipped ${skipped}`);
  return { executed, skipped };
}

/**
 * Handle concurrency limit failure with retry logic.
 * Returns true if retry was scheduled (don't re-throw), false if should advance to next occurrence.
 */
async function handleConcurrencyFailure(
  schedule: typeof agentSchedules.$inferSelect,
  compose: { userId: string; headVersionId: string },
  error: ConcurrentRunLimitError,
): Promise<boolean> {
  const now = new Date(Date.now());

  // Create failed run record
  const [failedRun] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: compose.userId,
      agentComposeVersionId: compose.headVersionId,
      scheduleId: schedule.id,
      status: "failed",
      prompt: schedule.prompt,
      vars: schedule.vars,
      error: error.message,
      completedAt: now,
      createdAt: now,
    })
    .returning();

  // Determine retry window start (use existing or start new window)
  const retryStartedAt = schedule.retryStartedAt ?? now;
  const windowElapsed = now.getTime() - retryStartedAt.getTime();

  if (windowElapsed < MAX_RETRY_WINDOW_MS) {
    // Within retry window: schedule retry in 5 minutes
    const nextRetryAt = new Date(now.getTime() + RETRY_INTERVAL_MS);

    await globalThis.services.db
      .update(agentSchedules)
      .set({
        lastRunId: failedRun?.id ?? schedule.lastRunId,
        retryStartedAt,
        nextRunAt: nextRetryAt,
      })
      .where(eq(agentSchedules.id, schedule.id));

    log.debug(
      `Schedule ${schedule.name} retry scheduled at ${nextRetryAt.toISOString()} ` +
        `(${Math.round(windowElapsed / 60000)} min into retry window)`,
    );

    return true; // Retry scheduled, don't re-throw
  }

  // Retry window expired: clear state and advance to next occurrence
  log.debug(
    `Schedule ${schedule.name} retry window expired after ${Math.round(windowElapsed / 60000)} min`,
  );

  if (schedule.cronExpression) {
    // Cron schedule: advance to next occurrence
    const nextRunAt = calculateNextRun(
      schedule.cronExpression,
      schedule.timezone,
    );
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        lastRunId: failedRun?.id ?? schedule.lastRunId,
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt,
      })
      .where(eq(agentSchedules.id, schedule.id));
    log.debug(
      `Cron schedule ${schedule.name} retry window expired, next run at ${nextRunAt?.toISOString()}`,
    );
  } else {
    // One-time schedule: disable after retry window expires
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        enabled: false,
        lastRunId: failedRun?.id ?? schedule.lastRunId,
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt: null,
      })
      .where(eq(agentSchedules.id, schedule.id));
    log.debug(
      `One-time schedule ${schedule.name} retry window expired and disabled`,
    );
  }

  return true; // Already handled, don't re-throw
}

/**
 * Execute a single schedule
 */
async function executeSchedule(
  schedule: typeof agentSchedules.$inferSelect,
): Promise<void> {
  log.debug(`Executing schedule ${schedule.name} (${schedule.id})`);

  // Get compose and verify it still exists
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, schedule.composeId))
    .limit(1);

  if (!compose) {
    log.error(
      `Compose ${schedule.composeId} not found for schedule ${schedule.name}`,
    );
    // Disable schedule if compose is deleted
    await globalThis.services.db
      .update(agentSchedules)
      .set({ enabled: false })
      .where(eq(agentSchedules.id, schedule.id));
    return;
  }

  if (!compose.headVersionId) {
    log.error(`Compose ${compose.name} has no versions`);
    return;
  }

  // Check concurrent run limit before creating run
  try {
    await checkRunConcurrencyLimit(compose.userId);
  } catch (error) {
    if (isConcurrentRunLimit(error)) {
      log.debug(`Schedule ${schedule.name} blocked by concurrent run limit`);

      const retryScheduled = await handleConcurrencyFailure(
        schedule,
        { userId: compose.userId, headVersionId: compose.headVersionId },
        error,
      );

      if (retryScheduled) {
        return; // Retry scheduled, don't continue
      }
      // Retry window expired, re-throw to advance to next occurrence
      throw error;
    }
    throw error;
  }

  // Note: vars and secrets are no longer stored in schedule table
  // They are fetched from platform tables by buildExecutionContext

  // Create run record first
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: compose.userId,
      agentComposeVersionId: compose.headVersionId,
      scheduleId: schedule.id,
      status: "pending",
      prompt: schedule.prompt,
      vars: null, // Vars come from platform tables
      secretNames: null, // Secret names come from platform tables
      createdAt: new Date(Date.now()),
    })
    .returning();

  if (!run) {
    log.error(`Failed to create run for schedule ${schedule.name}`);
    return;
  }

  // Update lastRunId immediately to prevent duplicate runs
  // This ensures skip-if-active check works even if subsequent steps fail
  await globalThis.services.db
    .update(agentSchedules)
    .set({ lastRunId: run.id })
    .where(eq(agentSchedules.id, schedule.id));

  try {
    // Generate sandbox token with the run ID
    const sandboxToken = await generateSandboxToken(compose.userId, run.id);

    // Build execution context and dispatch
    // Note: vars and secrets are fetched from platform tables by buildExecutionContext
    const context = await buildExecutionContext({
      runId: run.id,
      agentComposeVersionId: compose.headVersionId,
      prompt: schedule.prompt,
      sandboxToken,
      userId: compose.userId,
      // vars: undefined - fetched from platform tables by buildExecutionContext
      // secrets: undefined - fetched from platform tables by buildExecutionContext
      artifactName: schedule.artifactName ?? undefined,
      artifactVersion: schedule.artifactVersion ?? undefined,
      volumeVersions: schedule.volumeVersions ?? undefined,
      agentName: compose.name,
    });

    await prepareAndDispatchRun(context);
  } catch (error) {
    // Mark run as failed with error message
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    log.error(`Run ${run.id} failed during preparation: ${errorMessage}`);

    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "failed",
        completedAt: new Date(Date.now()),
        error: errorMessage,
      })
      .where(eq(agentRuns.id, run.id));

    // Update schedule state (disable one-time, advance cron)
    if (schedule.cronExpression) {
      const nextRunAt = calculateNextRun(
        schedule.cronExpression,
        schedule.timezone,
      );
      await globalThis.services.db
        .update(agentSchedules)
        .set({
          lastRunAt: new Date(Date.now()),
          nextRunAt,
          retryStartedAt: null, // Clear retry state on non-concurrency failure
        })
        .where(eq(agentSchedules.id, schedule.id));
      log.debug(
        `Cron schedule ${schedule.name} failed, next run at ${nextRunAt?.toISOString()}`,
      );
    } else {
      // One-time schedule: disable after failed execution (non-concurrency errors)
      await globalThis.services.db
        .update(agentSchedules)
        .set({
          enabled: false,
          lastRunAt: new Date(Date.now()),
          nextRunAt: null,
          retryStartedAt: null, // Clear retry state
        })
        .where(eq(agentSchedules.id, schedule.id));
      log.debug(`One-time schedule ${schedule.name} failed and disabled`);
    }

    throw error; // Re-throw so executeDueSchedules counts it as skipped
  }

  // Calculate next run time for success path
  let nextRunAt: Date | null = null;
  if (schedule.cronExpression) {
    nextRunAt = calculateNextRun(schedule.cronExpression, schedule.timezone);
  } else {
    // One-time schedule: disable after successful execution
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        enabled: false,
        lastRunAt: new Date(Date.now()),
        nextRunAt: null,
        retryStartedAt: null, // Clear retry state
      })
      .where(eq(agentSchedules.id, schedule.id));
    log.debug(`One-time schedule ${schedule.name} executed and disabled`);
    return;
  }

  // Update schedule with next run time (lastRunId already set above)
  await globalThis.services.db
    .update(agentSchedules)
    .set({
      lastRunAt: new Date(Date.now()),
      nextRunAt,
      retryStartedAt: null, // Clear retry state on success
    })
    .where(eq(agentSchedules.id, schedule.id));

  log.debug(
    `Schedule ${schedule.name} executed, next run at ${nextRunAt?.toISOString()}`,
  );
}
