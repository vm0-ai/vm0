import { eq, and, lte, inArray, desc } from "drizzle-orm";
import { Cron } from "croner";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { agentSchedules } from "../../db/schema/agent-schedule";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { connectors } from "../../db/schema/connector";
import { scopes } from "../../db/schema/scope";
import { decryptSecretsMap } from "../crypto";
import { notFound, badRequest, schedulePast } from "../errors";
import { logger } from "../logger";
import { createRun } from "../run/run-service";
import { getSecretValues } from "../secret/secret-service";
import { getVariableValues } from "../variable/variable-service";
import { getUserPreferences } from "../user/user-preferences-service";
import { generateCallbackSecret, getApiUrl } from "../callback";

const log = logger("service:schedule");

/**
 * Schedule data for API responses
 */
export interface ScheduleResponse {
  id: string;
  composeId: string;
  composeName: string;
  scopeSlug: string;
  name: string;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
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
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Run summary for schedule runs list
 */
interface RunSummary {
  id: string;
  status: "queued" | "pending" | "running" | "completed" | "failed" | "timeout";
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
  intervalSeconds?: number;
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
    triggerType: schedule.triggerType as "cron" | "once" | "loop",
    cronExpression: schedule.cronExpression,
    atTime: schedule.atTime?.toISOString() ?? null,
    intervalSeconds: schedule.intervalSeconds,
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
    consecutiveFailures: schedule.consecutiveFailures,
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
 * Validate that all required secrets/vars are available in platform tables.
 */
async function validateRequiredConfig(
  compose: typeof agentComposes.$inferSelect,
): Promise<void> {
  if (!compose.headVersionId) return;

  const [version] = await globalThis.services.db
    .select()
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, compose.headVersionId))
    .limit(1);

  if (!version) return;

  const required = extractRequiredConfiguration(version.content);

  // Fetch platform-managed secrets and vars from compose's scope
  const platformSecrets = await getSecretValues(
    compose.scopeId,
    compose.userId,
    "user",
  );
  const platformSecretNames = Object.keys(platformSecrets);
  log.debug(
    `Fetched ${platformSecretNames.length} platform secret(s) for validation`,
  );

  const platformVars = await getVariableValues(compose.scopeId, compose.userId);
  const platformVarNames = Object.keys(platformVars);
  log.debug(
    `Fetched ${platformVarNames.length} platform variable(s) for validation`,
  );

  // Query connected connectors to exclude their provided secrets
  const userConnectors = await globalThis.services.db
    .select({ type: connectors.type })
    .from(connectors)
    .where(
      and(
        eq(connectors.scopeId, compose.scopeId),
        eq(connectors.userId, compose.userId),
      ),
    );
  const connectorProvidedNames = getConnectorProvidedSecretNames(
    userConnectors.map((c) => c.type),
  );

  const missingSecrets = required.secrets.filter(
    (name) =>
      !platformSecretNames.includes(name) && !connectorProvidedNames.has(name),
  );
  const missingVars = required.vars.filter(
    (name) => !platformVarNames.includes(name),
  );

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

/**
 * Resolve trigger type and initial next-run time from request fields.
 */
function resolveTrigger(request: DeployScheduleRequest): {
  triggerType: "cron" | "once" | "loop";
  nextRunAt: Date | null;
} {
  if (request.cronExpression) {
    return {
      triggerType: "cron",
      nextRunAt: calculateNextRun(request.cronExpression, request.timezone),
    };
  }
  if (request.atTime) {
    return { triggerType: "once", nextRunAt: new Date(request.atTime) };
  }
  // Loop schedules get nextRunAt set on enable, not deploy
  return { triggerType: "loop", nextRunAt: null };
}

/**
 * Deploy (create or update) a schedule
 * Idempotent: creates if doesn't exist, updates if exists
 */
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

  // Validate required secrets/vars against platform tables
  await validateRequiredConfig(compose);

  const { triggerType, nextRunAt } = resolveTrigger(request);

  const now = new Date();

  if (existing) {
    // Update existing schedule
    const [updated] = await globalThis.services.db
      .update(agentSchedules)
      .set({
        triggerType,
        cronExpression: request.cronExpression ?? null,
        atTime: request.atTime ? new Date(request.atTime) : null,
        intervalSeconds: request.intervalSeconds ?? null,
        timezone: request.timezone,
        prompt: request.prompt,
        vars: null, // Vars now come from platform tables
        encryptedSecrets: null, // Secrets now come from platform tables
        artifactName: request.artifactName ?? null,
        artifactVersion: request.artifactVersion ?? null,
        volumeVersions: request.volumeVersions ?? null,
        nextRunAt,
        consecutiveFailures: 0,
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
        triggerType,
        cronExpression: request.cronExpression ?? null,
        atTime: request.atTime ? new Date(request.atTime) : null,
        intervalSeconds: request.intervalSeconds ?? null,
        timezone: request.timezone,
        prompt: request.prompt,
        vars: null, // Vars now come from platform tables
        encryptedSecrets: null, // Secrets now come from platform tables
        artifactName: request.artifactName ?? null,
        artifactVersion: request.artifactVersion ?? null,
        volumeVersions: request.volumeVersions ?? null,
        enabled: false,
        nextRunAt,
        consecutiveFailures: 0,
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
  if (schedule.triggerType === "loop") {
    // Loop schedules: trigger immediately on enable
    nextRunAt = new Date();
  } else if (schedule.cronExpression) {
    nextRunAt = calculateNextRun(schedule.cronExpression, schedule.timezone);
  } else if (schedule.atTime) {
    // For one-time schedules, check if atTime is in the future
    if (schedule.atTime > new Date()) {
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
      consecutiveFailures: 0, // Reset failure counter on enable
      updatedAt: new Date(),
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
      updatedAt: new Date(),
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
  const now = new Date();
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
 * Advance schedule to next occurrence (cron), disable (one-time), or wait for callback (loop).
 * Shared by retry-window-expired, failure, and success paths.
 *
 * Loop schedules do NOT set nextRunAt here — their next run is scheduled
 * by the completion callback, which provides completion-based timing.
 */
async function advanceScheduleState(
  schedule: typeof agentSchedules.$inferSelect,
  lastRunId?: string,
): Promise<void> {
  const now = new Date();
  if (schedule.triggerType === "loop") {
    // Loop: don't advance nextRunAt here — the loop callback handles it on completion
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        ...(lastRunId !== undefined && { lastRunId }),
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt: null, // Will be set by loop callback on run completion
      })
      .where(eq(agentSchedules.id, schedule.id));
  } else if (schedule.cronExpression) {
    const nextRunAt = calculateNextRun(
      schedule.cronExpression,
      schedule.timezone,
    );
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        ...(lastRunId !== undefined && { lastRunId }),
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt,
      })
      .where(eq(agentSchedules.id, schedule.id));
  } else {
    // One-time: disable after execution
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        enabled: false,
        ...(lastRunId !== undefined && { lastRunId }),
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt: null,
      })
      .where(eq(agentSchedules.id, schedule.id));
  }
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

  // Build callbacks for run completion notifications
  const callbacks: Array<{ url: string; secret: string; payload: unknown }> =
    [];
  const callbackPayload = {
    scheduleId: schedule.id,
    composeId: schedule.composeId,
    composeName: compose.name,
    userId: compose.userId,
  };

  const prefs = await getUserPreferences(compose.userId);

  // Email schedule notification callback (only if Resend is configured AND user opted in)
  if (globalThis.services.env.RESEND_API_KEY && prefs.notifyEmail) {
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/email/schedule`,
      secret: generateCallbackSecret(),
      payload: callbackPayload,
    });
  }

  // Slack schedule DM notification callback (only if user opted in)
  if (prefs.notifySlack) {
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/slack/schedule`,
      secret: generateCallbackSecret(),
      payload: callbackPayload,
    });
  }

  // Loop schedule advancement callback (triggers next iteration on completion)
  if (schedule.triggerType === "loop") {
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/schedule/loop`,
      secret: generateCallbackSecret(),
      payload: {
        scheduleId: schedule.id,
        intervalSeconds: schedule.intervalSeconds,
      },
    });
  }

  // Delegate run creation, validation, and dispatch to createRun()
  let runId: string;
  try {
    const result = await createRun({
      userId: compose.userId,
      agentComposeVersionId: compose.headVersionId,
      prompt: schedule.prompt,
      composeId: compose.id,
      scheduleId: schedule.id,
      artifactName: schedule.artifactName ?? undefined,
      artifactVersion: schedule.artifactVersion ?? undefined,
      volumeVersions: schedule.volumeVersions ?? undefined,
      agentName: compose.name,
      callbacks,
    });
    runId = result.runId;
  } catch (error) {
    // Update schedule state (disable one-time, advance cron) on any failure
    await advanceScheduleState(schedule);
    log.debug(`Schedule ${schedule.name} (${schedule.triggerType}) failed`);

    throw error; // Re-throw so executeDueSchedules counts it as skipped
  }

  // Advance schedule state (also persists lastRunId):
  // - cron: calculate next cron time
  // - once: disable
  // - loop: clear nextRunAt (callback will set it on completion)
  await advanceScheduleState(schedule, runId);
  log.debug(`Schedule ${schedule.name} (${schedule.triggerType}) executed`);
}
