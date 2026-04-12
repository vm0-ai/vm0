import { eq, and, lte, inArray, desc } from "drizzle-orm";
import { Cron } from "croner";
import { zeroAgentSchedules } from "../../../db/schema/zero-agent-schedule";
import { agentComposes } from "../../../db/schema/agent-compose";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { agentRuns } from "../../../db/schema/agent-run";
import { zeroRuns } from "../../../db/schema/zero-run";
import { decryptSecretsMap } from "../../shared/crypto";
import { notFound, badRequest, schedulePast } from "../../shared/errors";
import { logger } from "../../shared/logger";
import { createZeroRun } from "../zero-run-service";
import { buildIntegrationPrompt } from "../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../infra/callback";
import { generateScheduleDescription } from "../ai/lightweight-model";
import type {
  ScheduleLoopCallbackPayload,
  ScheduleCronCallbackPayload,
} from "../../infra/callback/callback-payloads";

const log = logger("service:schedule");

// Auto-disable after this many consecutive pre-run failures
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Schedule data for API responses
 */
export interface ScheduleResponse {
  id: string;
  agentId: string;
  displayName: string | null;
  userId: string;
  name: string;
  triggerType: "cron" | "once" | "loop";
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string;
  prompt: string;
  description: string | null;
  appendSystemPrompt: string | null;
  vars: Record<string, string> | null;
  secretNames: string[] | null;
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
 * Note: vars and secrets are no longer accepted - they must be managed via server-side tables
 */
interface DeployScheduleRequest {
  name: string;
  agentId: string;
  cronExpression?: string;
  atTime?: string;
  intervalSeconds?: number;
  timezone: string;
  prompt: string;
  description?: string;
  appendSystemPrompt?: string;
  enabled?: boolean;
  // vars and secrets removed - now managed via server-side tables
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
export function calculateNextRun(
  cronExpression: string,
  timezone: string,
): Date | null {
  const cron = new Cron(cronExpression, { timezone });
  const nextRun = cron.nextRun();
  return nextRun;
}

/**
 * Convert schedule row to API response format.
 * agentId in the schedule IS the composeId (single UUID).
 */
function toResponse(
  schedule: typeof zeroAgentSchedules.$inferSelect,
  displayName: string | null,
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
    agentId: schedule.agentId,
    displayName,
    userId: schedule.userId,
    name: schedule.name,
    triggerType: schedule.triggerType as "cron" | "once" | "loop",
    cronExpression: schedule.cronExpression,
    atTime: schedule.atTime?.toISOString() ?? null,
    intervalSeconds: schedule.intervalSeconds,
    timezone: schedule.timezone,
    prompt: schedule.prompt,
    description: schedule.description,
    appendSystemPrompt: schedule.appendSystemPrompt,
    vars: schedule.vars,
    secretNames,
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
 * Verify the user owns this schedule (by agentId + name + orgId + userId).
 */
async function verifyScheduleOwnership(
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<{
  schedule: typeof zeroAgentSchedules.$inferSelect;
  displayName: string | null;
}> {
  const [agent] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.id, agentId))
    .limit(1);

  if (!agent) throw notFound("Agent not found");

  const [schedule] = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(
      and(
        eq(zeroAgentSchedules.agentId, agentId),
        eq(zeroAgentSchedules.name, name),
        eq(zeroAgentSchedules.orgId, orgId),
        eq(zeroAgentSchedules.userId, userId),
      ),
    )
    .limit(1);

  if (!schedule) {
    throw notFound(`Schedule '${name}' not found`);
  }

  return { schedule, displayName: agent.displayName ?? null };
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
): Promise<typeof zeroAgentSchedules.$inferSelect> {
  const [updated] = await globalThis.services.db
    .update(zeroAgentSchedules)
    .set({
      triggerType,
      cronExpression: request.cronExpression ?? null,
      atTime: request.atTime ? new Date(request.atTime) : null,
      intervalSeconds: request.intervalSeconds ?? null,
      timezone: request.timezone,
      prompt: request.prompt,
      description: request.description ?? null,
      appendSystemPrompt: request.appendSystemPrompt ?? null,
      vars: null,
      encryptedSecrets: null,
      volumeVersions: request.volumeVersions ?? null,
      nextRunAt,
      consecutiveFailures: 0,
      updatedAt: new Date(),
    })
    .where(eq(zeroAgentSchedules.id, existingId))
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
  agentId: string,
  triggerType: "cron" | "once" | "loop",
  nextRunAt: Date | null,
): Promise<typeof zeroAgentSchedules.$inferSelect> {
  const now = new Date();
  const [created] = await globalThis.services.db
    .insert(zeroAgentSchedules)
    .values({
      agentId,
      userId,
      orgId,
      name: request.name,
      triggerType,
      cronExpression: request.cronExpression ?? null,
      atTime: request.atTime ? new Date(request.atTime) : null,
      intervalSeconds: request.intervalSeconds ?? null,
      timezone: request.timezone,
      prompt: request.prompt,
      description: request.description ?? null,
      appendSystemPrompt: request.appendSystemPrompt ?? null,
      vars: null,
      encryptedSecrets: null,
      volumeVersions: request.volumeVersions ?? null,
      enabled: request.enabled ?? false,
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
 * Build a template-based description fallback.
 */
function buildTemplateDescription(
  request: DeployScheduleRequest,
  agentName: string,
): string {
  const triggerLabel = request.cronExpression
    ? "recurring"
    : request.atTime
      ? "one-time"
      : "loop";
  return `${agentName} ${triggerLabel} task: ${request.prompt.slice(0, 100)}`;
}

/**
 * Generate a concise schedule description using the lightweight model.
 * Falls back to a template-based description if the model returns null
 * (e.g., model unavailable or empty response).
 */
async function generateDescription(
  request: DeployScheduleRequest,
  agentName: string,
): Promise<string> {
  const triggerSummary = request.cronExpression
    ? `cron: ${request.cronExpression}`
    : request.atTime
      ? `once at ${request.atTime}`
      : request.intervalSeconds !== undefined
        ? `loop every ${request.intervalSeconds}s`
        : "unknown trigger";

  const text = await generateScheduleDescription(
    agentName,
    request.name,
    triggerSummary,
    request.prompt,
  );

  return text ?? buildTemplateDescription(request, agentName);
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
  log.debug(`Deploying schedule ${request.name} for agent ${request.agentId}`);

  const [agent] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.id, request.agentId))
    .limit(1);

  if (!agent) throw notFound("Agent not found");

  // Validate timezone
  if (!isValidTimezone(request.timezone)) {
    throw badRequest(`Invalid timezone: ${request.timezone}`);
  }

  // Reject one-time schedules with past atTime when enabled
  validateAtTimeNotPast(request);

  // Auto-generate description if not provided (undefined/null means not provided;
  // empty string means the user explicitly cleared it — skip auto-generation)
  if (request.description == null) {
    request = {
      ...request,
      description: await generateDescription(request, agent.name),
    };
  }

  // Check for existing schedule with same name for this user on this agent
  const [existing] = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(
      and(
        eq(zeroAgentSchedules.agentId, request.agentId),
        eq(zeroAgentSchedules.name, request.name),
        eq(zeroAgentSchedules.orgId, orgId),
        eq(zeroAgentSchedules.userId, userId),
      ),
    )
    .limit(1);

  const { triggerType, nextRunAt } = resolveTrigger(request);
  const displayName = agent.displayName ?? null;

  if (existing) {
    const updated = await updateExistingSchedule(
      existing.id,
      request,
      triggerType,
      nextRunAt,
    );
    log.debug(`Updated schedule ${request.name} (${existing.id})`);
    return {
      schedule: toResponse(updated, displayName),
      created: false,
    };
  }

  const created = await insertNewSchedule(
    userId,
    orgId,
    request,
    request.agentId,
    triggerType,
    nextRunAt,
  );
  log.debug(`Created schedule ${request.name} (${created.id})`);
  return {
    schedule: toResponse(created, displayName),
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
  const conditions = [eq(zeroAgentSchedules.userId, userId)];
  if (orgId) {
    conditions.push(eq(zeroAgentSchedules.orgId, orgId));
  }

  const userSchedules = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(and(...conditions));

  if (userSchedules.length === 0) {
    return [];
  }

  // Load agent compose data (with displayName) for all schedules
  const agentIds = [
    ...new Set(
      userSchedules.map((s) => {
        return s.agentId;
      }),
    ),
  ];
  const agentRows = await globalThis.services.db
    .select({
      id: agentComposes.id,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(inArray(agentComposes.id, agentIds));
  const agentMap = new Map(
    agentRows.map((r) => {
      return [r.id, r];
    }),
  );

  return userSchedules
    .filter((schedule) => {
      // FK constraints with CASCADE should guarantee these exist.
      // Skip orphaned rows rather than masking with fallback values.
      return agentMap.has(schedule.agentId);
    })
    .map((schedule) => {
      const agent = agentMap.get(schedule.agentId)!;
      return toResponse(schedule, agent.displayName ?? null);
    });
}

/**
 * Get schedule by name, agent ID, and org+user
 */
export async function getScheduleByName(
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Getting schedule ${name} for agent ${agentId}`);

  const { schedule, displayName } = await verifyScheduleOwnership(
    userId,
    orgId,
    agentId,
    name,
  );

  return toResponse(schedule, displayName);
}

/**
 * Get recent runs for a schedule
 */
export async function getScheduleRecentRuns(
  userId: string,
  orgId: string,
  agentId: string,
  scheduleName: string,
  limit: number,
): Promise<RunSummary[]> {
  log.debug(
    `Getting recent runs for schedule ${scheduleName} (limit: ${limit})`,
  );

  const { schedule } = await verifyScheduleOwnership(
    userId,
    orgId,
    agentId,
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
    .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.scheduleId, schedule.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);

  return runs.map((run) => {
    return {
      id: run.id,
      status: run.status as RunSummary["status"],
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      error: run.error,
    };
  });
}

/**
 * Delete schedule by name, agent ID, and org+user
 */
export async function deleteSchedule(
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<void> {
  log.debug(`Deleting schedule ${name} for agent ${agentId}`);

  const { schedule } = await verifyScheduleOwnership(
    userId,
    orgId,
    agentId,
    name,
  );

  await globalThis.services.db
    .delete(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, schedule.id));

  log.debug(`Deleted schedule ${name}`);
}

/**
 * Enable a schedule
 */
export async function enableSchedule(
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Enabling schedule ${name} for agent ${agentId}`);

  const { schedule, displayName } = await verifyScheduleOwnership(
    userId,
    orgId,
    agentId,
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
    .update(zeroAgentSchedules)
    .set({
      enabled: true,
      nextRunAt,
      retryStartedAt: null, // Clear any stale retry state
      consecutiveFailures: 0, // Reset failure counter on enable
      updatedAt: new Date(),
    })
    .where(eq(zeroAgentSchedules.id, schedule.id))
    .returning();

  if (!updated) {
    throw new Error(`Failed to enable schedule ${name}`);
  }

  log.debug(`Enabled schedule ${name}`);

  return toResponse(updated, displayName);
}

/**
 * Disable a schedule
 */
export async function disableSchedule(
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<ScheduleResponse> {
  log.debug(`Disabling schedule ${name} for agent ${agentId}`);

  const { schedule, displayName } = await verifyScheduleOwnership(
    userId,
    orgId,
    agentId,
    name,
  );

  const [updated] = await globalThis.services.db
    .update(zeroAgentSchedules)
    .set({
      enabled: false,
      retryStartedAt: null, // Clear retry state
      updatedAt: new Date(),
    })
    .where(eq(zeroAgentSchedules.id, schedule.id))
    .returning();

  if (!updated) {
    throw notFound(`Schedule '${name}' not found`);
  }

  log.debug(`Disabled schedule ${name}`);

  return toResponse(updated, displayName);
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
    .from(zeroAgentSchedules)
    .where(
      and(
        eq(zeroAgentSchedules.enabled, true),
        lte(zeroAgentSchedules.nextRunAt, now),
      ),
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

    // Atomic CAS claim: advance schedule state to prevent duplicate execution.
    // If another invocation already claimed this schedule (changed nextRunAt),
    // the WHERE condition won't match and we skip it.
    const [claimed] = await globalThis.services.db
      .update(zeroAgentSchedules)
      .set({
        nextRunAt: null,
        lastRunAt: now,
        retryStartedAt: null,
        ...(schedule.triggerType === "once" && { enabled: false }),
      })
      .where(
        and(
          eq(zeroAgentSchedules.id, schedule.id),
          eq(zeroAgentSchedules.nextRunAt, schedule.nextRunAt!),
        ),
      )
      .returning();

    if (!claimed) {
      log.debug(
        `Skipping schedule ${schedule.name}: already claimed by another invocation`,
      );
      skipped++;
      continue;
    }

    try {
      await executeSchedule(schedule);
      executed++;
    } catch (error) {
      log.error(`Failed to execute schedule ${schedule.name}:`, error);

      // Pre-run failure: increment consecutive failures and schedule next attempt
      // (mirrors callback failure handling from #8430)
      const now = new Date();
      const newFailureCount = schedule.consecutiveFailures + 1;
      const shouldDisable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;

      let nextRunAt: Date | null = null;
      if (!shouldDisable) {
        if (schedule.triggerType === "cron" && schedule.cronExpression) {
          nextRunAt = calculateNextRun(
            schedule.cronExpression,
            schedule.timezone,
          );
        } else if (
          schedule.triggerType === "loop" &&
          schedule.intervalSeconds
        ) {
          nextRunAt = new Date(now.getTime() + schedule.intervalSeconds * 1000);
        }
        // "once" triggers: CAS claim already set enabled=false, no recovery needed
      }

      await globalThis.services.db
        .update(zeroAgentSchedules)
        .set({
          consecutiveFailures: newFailureCount,
          ...(shouldDisable && { enabled: false }),
          nextRunAt,
          updatedAt: now,
        })
        .where(eq(zeroAgentSchedules.id, schedule.id));

      if (shouldDisable) {
        log.warn("Schedule auto-disabled after consecutive pre-run failures", {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          consecutiveFailures: newFailureCount,
        });
      }

      skipped++;
    }
  }

  log.debug(`Executed ${executed} schedules, skipped ${skipped}`);
  return { executed, skipped };
}

/**
 * Execute a single schedule and return the created run ID.
 */
export async function executeSchedule(
  schedule: typeof zeroAgentSchedules.$inferSelect,
): Promise<string> {
  log.debug(`Executing schedule ${schedule.name} (${schedule.id})`);

  // Resolve compose directly — schedule.agentId IS the composeId
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, schedule.agentId))
    .limit(1);

  if (!compose) {
    log.error(`Agent or compose for schedule ${schedule.name} not found`);
    await globalThis.services.db
      .update(zeroAgentSchedules)
      .set({ enabled: false })
      .where(eq(zeroAgentSchedules.id, schedule.id));
    throw new Error(`Agent or compose for schedule ${schedule.name} not found`);
  }

  if (!compose.headVersionId) {
    log.error(`Compose ${compose.name} has no versions`);
    throw new Error(`Compose ${compose.name} has no versions`);
  }

  // Build callbacks for run completion
  const callbacks: Array<{
    url: string;
    secret: string;
    payload: ScheduleLoopCallbackPayload | ScheduleCronCallbackPayload;
  }> = [];

  // Loop schedule advancement callback (triggers next iteration on completion)
  if (schedule.triggerType === "loop") {
    const loopPayload: ScheduleLoopCallbackPayload = {
      scheduleId: schedule.id,
      intervalSeconds: schedule.intervalSeconds!,
    };
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/schedule/loop`,
      secret: generateCallbackSecret(),
      payload: loopPayload,
    });
  }

  // Cron/once schedule completion callback (tracks failures, advances next run, generates summary)
  if (schedule.triggerType === "cron" || schedule.triggerType === "once") {
    const cronPayload: ScheduleCronCallbackPayload = {
      scheduleId: schedule.id,
      ...(schedule.cronExpression && {
        cronExpression: schedule.cronExpression,
      }),
      timezone: schedule.timezone,
    };
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/schedule/cron`,
      secret: generateCallbackSecret(),
      payload: cronPayload,
    });
  }

  // Build schedule integration context for the agent
  // (User info is injected centrally by createZeroRunRecord)
  const integrationContext = buildIntegrationPrompt("Schedule", {
    scheduleDescription: schedule.description ?? undefined,
    triggerType: schedule.triggerType,
  });

  const baseAppendPrompt = schedule.appendSystemPrompt ?? undefined;
  const appendSystemPrompt = baseAppendPrompt
    ? `${integrationContext}\n\n${baseAppendPrompt}`
    : integrationContext;

  // Delegate run creation, validation, and dispatch to createZeroRun()
  // Note: schedule state (nextRunAt, lastRunAt, enabled) is already advanced
  // by the atomic CAS claim in executeDueSchedules(). We only need to persist
  // lastRunId after successful run creation.
  const result = await createZeroRun({
    userId: schedule.userId,
    prompt: schedule.prompt,
    appendSystemPrompt,
    agentId: schedule.agentId,
    scheduleId: schedule.id,
    triggerSource: "schedule",
    callbacks,
  });

  // Persist lastRunId so the active-run check in executeDueSchedules works
  await globalThis.services.db
    .update(zeroAgentSchedules)
    .set({ lastRunId: result.runId })
    .where(eq(zeroAgentSchedules.id, schedule.id));

  log.debug(`Schedule ${schedule.name} (${schedule.triggerType}) executed`);
  return result.runId;
}
