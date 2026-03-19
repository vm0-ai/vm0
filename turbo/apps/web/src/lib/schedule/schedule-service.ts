import { eq, and, lte, inArray, desc } from "drizzle-orm";
import { Cron } from "croner";
import { agentSchedules } from "../../db/schema/agent-schedule";
import { agentComposes } from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { decryptSecretsMap } from "../crypto";
import { getOrgData } from "../org/org-cache-service";
import { notFound, badRequest, schedulePast } from "../errors";
import { logger } from "../logger";
import { startRun } from "../run/run-service";
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
  orgSlug: string;
  userId: string;
  name: string;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string;
  prompt: string;
  appendSystemPrompt: string | null;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
  artifactName: string | null;
  artifactVersion: string | null;
  volumeVersions: Record<string, string> | null;
  enabled: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
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
 * Note: vars and secrets are no longer accepted - they must be managed via server-side tables
 */
interface DeployScheduleRequest {
  name: string;
  composeId: string;
  cronExpression?: string;
  atTime?: string;
  intervalSeconds?: number;
  timezone: string;
  prompt: string;
  appendSystemPrompt?: string;
  enabled?: boolean;
  notifyEmail?: boolean;
  notifySlack?: boolean;
  // vars and secrets removed - now managed via server-side tables
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
  orgSlug: string,
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
    orgSlug,
    userId: schedule.userId,
    name: schedule.name,
    triggerType: schedule.triggerType as "cron" | "once" | "loop",
    cronExpression: schedule.cronExpression,
    atTime: schedule.atTime?.toISOString() ?? null,
    intervalSeconds: schedule.intervalSeconds,
    timezone: schedule.timezone,
    prompt: schedule.prompt,
    appendSystemPrompt: schedule.appendSystemPrompt,
    vars: schedule.vars,
    secretNames,
    artifactName: schedule.artifactName,
    artifactVersion: schedule.artifactVersion,
    volumeVersions: schedule.volumeVersions,
    enabled: schedule.enabled,
    notifyEmail: schedule.notifyEmail,
    notifySlack: schedule.notifySlack,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    retryStartedAt: schedule.retryStartedAt?.toISOString() ?? null,
    consecutiveFailures: schedule.consecutiveFailures,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

/**
 * Verify compose exists and return it (no ownership check — caller handles access)
 */
async function loadCompose(
  composeId: string,
): Promise<typeof agentComposes.$inferSelect> {
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    throw notFound("Agent compose not found");
  }

  return compose;
}

/**
 * Load org slug by ID
 */
async function getOrgSlug(orgId: string): Promise<string> {
  const orgData = await getOrgData(orgId);
  return orgData.slug;
}

/**
 * Verify the user owns this schedule (by composeId + name + orgId + userId)
 */
async function verifyScheduleOwnership(
  userId: string,
  orgId: string,
  composeId: string,
  name: string,
): Promise<{
  schedule: typeof agentSchedules.$inferSelect;
  compose: typeof agentComposes.$inferSelect;
  orgSlug: string;
}> {
  const [schedule] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, composeId),
        eq(agentSchedules.name, name),
        eq(agentSchedules.orgId, orgId),
        eq(agentSchedules.userId, userId),
      ),
    )
    .limit(1);

  if (!schedule) {
    throw notFound(`Schedule '${name}' not found`);
  }

  const compose = await loadCompose(composeId);
  const orgSlug = await getOrgSlug(orgId);

  return { schedule, compose, orgSlug };
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
  // Loop schedules: trigger immediately when created as enabled
  return {
    triggerType: "loop",
    nextRunAt: request.enabled ? new Date() : null,
  };
}

/**
 * Reject enabled one-time schedules whose atTime is in the past.
 */
function validateAtTimeNotPast(request: DeployScheduleRequest): void {
  if (!request.atTime || !request.enabled) {
    return;
  }
  const atDate = new Date(request.atTime);
  if (atDate <= new Date()) {
    throw schedulePast(
      `Cannot create enabled schedule: scheduled time ${atDate.toISOString()} has already passed`,
    );
  }
}

/**
 * Update an existing schedule row.
 */
async function updateExistingSchedule(
  existingId: string,
  request: DeployScheduleRequest,
  triggerType: "cron" | "once" | "loop",
  nextRunAt: Date | null,
): Promise<typeof agentSchedules.$inferSelect> {
  const [updated] = await globalThis.services.db
    .update(agentSchedules)
    .set({
      triggerType,
      cronExpression: request.cronExpression ?? null,
      atTime: request.atTime ? new Date(request.atTime) : null,
      intervalSeconds: request.intervalSeconds ?? null,
      timezone: request.timezone,
      prompt: request.prompt,
      appendSystemPrompt: request.appendSystemPrompt ?? null,
      vars: null,
      encryptedSecrets: null,
      artifactName: request.artifactName ?? null,
      artifactVersion: request.artifactVersion ?? null,
      volumeVersions: request.volumeVersions ?? null,
      ...(request.notifyEmail !== undefined && {
        notifyEmail: request.notifyEmail,
      }),
      ...(request.notifySlack !== undefined && {
        notifySlack: request.notifySlack,
      }),
      nextRunAt,
      consecutiveFailures: 0,
      updatedAt: new Date(),
    })
    .where(eq(agentSchedules.id, existingId))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update schedule ${request.name}`);
  }
  return updated;
}

/**
 * Insert a new schedule row.
 */
async function insertNewSchedule(
  userId: string,
  orgId: string,
  request: DeployScheduleRequest,
  triggerType: "cron" | "once" | "loop",
  nextRunAt: Date | null,
): Promise<typeof agentSchedules.$inferSelect> {
  const now = new Date();
  const [created] = await globalThis.services.db
    .insert(agentSchedules)
    .values({
      composeId: request.composeId,
      userId,
      orgId,
      name: request.name,
      triggerType,
      cronExpression: request.cronExpression ?? null,
      atTime: request.atTime ? new Date(request.atTime) : null,
      intervalSeconds: request.intervalSeconds ?? null,
      timezone: request.timezone,
      prompt: request.prompt,
      appendSystemPrompt: request.appendSystemPrompt ?? null,
      vars: null,
      encryptedSecrets: null,
      artifactName: request.artifactName ?? null,
      artifactVersion: request.artifactVersion ?? null,
      volumeVersions: request.volumeVersions ?? null,
      enabled: request.enabled ?? false,
      notifyEmail: request.notifyEmail ?? true,
      notifySlack: request.notifySlack ?? true,
      nextRunAt,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!created) {
    throw new Error(`Failed to create schedule ${request.name}`);
  }
  return created;
}

/**
 * Deploy (create or update) a schedule
 * Idempotent: creates if doesn't exist, updates if exists
 */
export async function deploySchedule(
  userId: string,
  orgId: string,
  request: DeployScheduleRequest,
): Promise<{ schedule: ScheduleResponse; created: boolean }> {
  log.debug(
    `Deploying schedule ${request.name} for compose ${request.composeId}`,
  );

  // Load compose (access control is handled by the caller/route layer)
  const compose = await loadCompose(request.composeId);
  const orgSlug = await getOrgSlug(orgId);

  // Validate timezone
  if (!isValidTimezone(request.timezone)) {
    throw badRequest(`Invalid timezone: ${request.timezone}`);
  }

  // Reject one-time schedules with past atTime when enabled
  validateAtTimeNotPast(request);

  // Check for existing schedule with same name for this user on this compose
  const [existing] = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.composeId, request.composeId),
        eq(agentSchedules.name, request.name),
        eq(agentSchedules.orgId, orgId),
        eq(agentSchedules.userId, userId),
      ),
    )
    .limit(1);

  const { triggerType, nextRunAt } = resolveTrigger(request);

  if (existing) {
    const updated = await updateExistingSchedule(
      existing.id,
      request,
      triggerType,
      nextRunAt,
    );
    log.debug(`Updated schedule ${request.name} (${existing.id})`);
    return {
      schedule: toResponse(updated, compose.name, orgSlug),
      created: false,
    };
  }

  const created = await insertNewSchedule(
    userId,
    orgId,
    request,
    triggerType,
    nextRunAt,
  );
  log.debug(`Created schedule ${request.name} (${created.id})`);
  return {
    schedule: toResponse(created, compose.name, orgSlug),
    created: true,
  };
}

/**
 * List schedules for a user, optionally scoped to an org.
 */
export async function listSchedules(
  userId: string,
  orgId?: string,
): Promise<ScheduleResponse[]> {
  log.debug(
    `Listing schedules for user ${userId}${orgId ? ` in org ${orgId}` : ""}`,
  );

  // Query schedules by userId, optionally filtered by orgId
  const conditions = [eq(agentSchedules.userId, userId)];
  if (orgId) {
    conditions.push(eq(agentSchedules.orgId, orgId));
  }

  const userSchedules = await globalThis.services.db
    .select()
    .from(agentSchedules)
    .where(and(...conditions));

  if (userSchedules.length === 0) {
    return [];
  }

  // Load compose data for all schedules
  const composeIds = [...new Set(userSchedules.map((s) => s.composeId))];
  const composeRows = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(inArray(agentComposes.id, composeIds));
  const composeMap = new Map(composeRows.map((c) => [c.id, c]));

  // Load org slugs via org cache (by orgId from schedule records)
  const uniqueClerkOrgIds = [...new Set(userSchedules.map((s) => s.orgId))];
  const orgDataEntries = await Promise.all(
    uniqueClerkOrgIds.map(async (id) => [id, await getOrgData(id)] as const),
  );
  const orgDataMap = new Map(orgDataEntries);

  return userSchedules
    .filter((schedule) => {
      // FK constraints with CASCADE should guarantee these exist.
      // Skip orphaned rows rather than masking with fallback values.
      return composeMap.has(schedule.composeId);
    })
    .map((schedule) => {
      const compose = composeMap.get(schedule.composeId)!;
      const orgSlug = orgDataMap.get(schedule.orgId)?.slug ?? "";
      return toResponse(schedule, compose.name, orgSlug);
    });
}

/**
 * Get schedule by name, compose ID, and org+user
 */
export async function getScheduleByName(
  userId: string,
  orgId: string,
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Getting schedule ${name} for compose ${composeId}`);

  const { schedule, compose, orgSlug } = await verifyScheduleOwnership(
    userId,
    orgId,
    composeId,
    name,
  );

  return toResponse(schedule, compose.name, orgSlug);
}

/**
 * Get recent runs for a schedule
 */
export async function getScheduleRecentRuns(
  userId: string,
  orgId: string,
  composeId: string,
  scheduleName: string,
  limit: number,
): Promise<RunSummary[]> {
  log.debug(
    `Getting recent runs for schedule ${scheduleName} (limit: ${limit})`,
  );

  const { schedule } = await verifyScheduleOwnership(
    userId,
    orgId,
    composeId,
    scheduleName,
  );

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
 * Delete schedule by name, compose ID, and org+user
 */
export async function deleteSchedule(
  userId: string,
  orgId: string,
  composeId: string,
  name: string,
): Promise<void> {
  log.debug(`Deleting schedule ${name} for compose ${composeId}`);

  const { schedule } = await verifyScheduleOwnership(
    userId,
    orgId,
    composeId,
    name,
  );

  await globalThis.services.db
    .delete(agentSchedules)
    .where(eq(agentSchedules.id, schedule.id));

  log.debug(`Deleted schedule ${name}`);
}

/**
 * Enable a schedule
 */
export async function enableSchedule(
  userId: string,
  orgId: string,
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Enabling schedule ${name} for compose ${composeId}`);

  const { schedule, compose, orgSlug } = await verifyScheduleOwnership(
    userId,
    orgId,
    composeId,
    name,
  );

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

  return toResponse(updated, compose.name, orgSlug);
}

/**
 * Disable a schedule
 */
export async function disableSchedule(
  userId: string,
  orgId: string,
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Disabling schedule ${name} for compose ${composeId}`);

  const { schedule, compose, orgSlug } = await verifyScheduleOwnership(
    userId,
    orgId,
    composeId,
    name,
  );

  const [updated] = await globalThis.services.db
    .update(agentSchedules)
    .set({
      enabled: false,
      retryStartedAt: null, // Clear retry state
      updatedAt: new Date(),
    })
    .where(eq(agentSchedules.id, schedule.id))
    .returning();

  if (!updated) {
    throw notFound(`Schedule '${name}' not found`);
  }

  log.debug(`Disabled schedule ${name}`);

  return toResponse(updated, compose.name, orgSlug);
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

  // Load org tier and slug from org_cache (Clerk as source of truth)
  const orgData = await getOrgData(schedule.orgId);

  // Build callbacks for run completion notifications
  const callbacks: Array<{ url: string; secret: string; payload: unknown }> =
    [];
  const callbackPayload = {
    scheduleId: schedule.id,
    composeId: schedule.composeId,
    composeName: compose.name,
    userId: schedule.userId,
  };

  const prefs = await getUserPreferences(orgData.orgId, schedule.userId);

  // Email schedule notification callback (only if Resend is configured AND user + schedule opted in)
  if (
    globalThis.services.env.RESEND_API_KEY &&
    prefs.notifyEmail &&
    schedule.notifyEmail
  ) {
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/email/schedule`,
      secret: generateCallbackSecret(),
      payload: callbackPayload,
    });
  }

  // Slack schedule DM notification callback (only if user + schedule opted in)
  if (prefs.notifySlack && schedule.notifySlack) {
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

  // Delegate run creation, validation, and dispatch to startRun()
  let runId: string;
  try {
    const result = await startRun({
      userId: schedule.userId,
      prompt: schedule.prompt,
      appendSystemPrompt: schedule.appendSystemPrompt ?? undefined,
      composeId: compose.id,
      scheduleId: schedule.id,
      artifactName: schedule.artifactName ?? undefined,
      artifactVersion: schedule.artifactVersion ?? undefined,
      volumeVersions: schedule.volumeVersions ?? undefined,
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
