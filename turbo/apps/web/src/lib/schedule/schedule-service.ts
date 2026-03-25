import { eq, and, lte, inArray, desc } from "drizzle-orm";
import { Cron } from "croner";
import { zeroAgentSchedules } from "../../db/schema/zero-agent-schedule";
import { zeroAgents } from "../../db/schema/zero-agent";
import { agentComposes } from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { decryptSecretsMap } from "../crypto";
import { getOrgData } from "../org/org-cache-service";
import { notFound, badRequest, schedulePast } from "../errors";
import { logger } from "../logger";
import { createZeroRun } from "../zero/zero-run-service";
import { generateCallbackSecret, getApiUrl } from "../callback";
import { generateScheduleDescription } from "../ai/lightweight-model";
import type {
  EmailScheduleCallbackPayload,
  SlackScheduleCallbackPayload,
  ScheduleLoopCallbackPayload,
} from "../callback/callback-payloads";

const log = logger("service:schedule");

/**
 * Schedule data for API responses
 */
export interface ScheduleResponse {
  id: string;
  agentId: string;
  agentName: string;
  orgSlug: string;
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
  artifactName: string | null;
  artifactVersion: string | null;
  volumeVersions: Record<string, string> | null;
  enabled: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackChannelId: string | null;
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
  notifyEmail?: boolean;
  notifySlack?: boolean;
  slackChannelId?: string | null;
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
 * Resolve the agent compose associated with a zero agent ID.
 * Uses a single JOIN query instead of two sequential lookups.
 */
export async function resolveComposeByAgentId(
  agentId: string,
): Promise<typeof agentComposes.$inferSelect | null> {
  const [result] = await globalThis.services.db
    .select({
      compose: agentComposes,
    })
    .from(zeroAgents)
    .innerJoin(
      agentComposes,
      and(
        eq(agentComposes.orgId, zeroAgents.orgId),
        eq(agentComposes.name, zeroAgents.name),
      ),
    )
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return result?.compose ?? null;
}

/**
 * Convert schedule row to API response format
 */
function toResponse(
  schedule: typeof zeroAgentSchedules.$inferSelect,
  agentName: string,
  orgSlug: string,
  composeId?: string,
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
    agentId: composeId ?? schedule.agentId,
    agentName,
    orgSlug,
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
    artifactName: schedule.artifactName,
    artifactVersion: schedule.artifactVersion,
    volumeVersions: schedule.volumeVersions,
    enabled: schedule.enabled,
    notifyEmail: schedule.notifyEmail,
    notifySlack: schedule.notifySlack,
    slackChannelId: schedule.slackChannelId ?? null,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    retryStartedAt: schedule.retryStartedAt?.toISOString() ?? null,
    consecutiveFailures: schedule.consecutiveFailures,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

/**
 * Verify zero agent exists and return it.
 *
 * Resolution strategy:
 * 1. Direct lookup by zero_agents.id (platform / zero API flow)
 * 2. Fallback: treat the id as a composeId, resolve the compose's
 *    (orgId, name), then find-or-create the zero_agents row.
 *    This is required because the CLI receives agentComposeId from
 *    GET /api/zero/agents/:name and sends it as agentId.
 */
async function loadZeroAgent(
  agentId: string,
): Promise<typeof zeroAgents.$inferSelect> {
  // 1. Direct zero_agents lookup
  const [agent] = await globalThis.services.db
    .select()
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);

  if (agent) return agent;

  // 2. Fallback: treat as composeId and resolve via compose
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, agentId))
    .limit(1);

  if (!compose) throw notFound("Agent not found");

  // Find existing zero_agent by (orgId, name) or create one
  const [existing] = await globalThis.services.db
    .select()
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, compose.orgId),
        eq(zeroAgents.name, compose.name),
      ),
    )
    .limit(1);

  if (existing) return existing;

  // Auto-create zero_agents row for CLI-composed agents
  const [created] = await globalThis.services.db
    .insert(zeroAgents)
    .values({
      orgId: compose.orgId,
      name: compose.name,
    })
    .returning();

  if (!created) throw notFound("Agent not found");

  log.debug(`Auto-created zero agent for compose ${compose.name}`);
  return created;
}

/**
 * Load org slug by ID.
 */
async function getOrgSlug(orgId: string): Promise<string> {
  const orgData = await getOrgData(orgId);
  return orgData.slug;
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
  agentName: string;
  orgSlug: string;
  composeId: string | undefined;
}> {
  const agent = await loadZeroAgent(agentId);
  const resolvedId = agent.id;

  const [[schedule], orgSlug, compose] = await Promise.all([
    globalThis.services.db
      .select()
      .from(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.agentId, resolvedId),
          eq(zeroAgentSchedules.name, name),
          eq(zeroAgentSchedules.orgId, orgId),
          eq(zeroAgentSchedules.userId, userId),
        ),
      )
      .limit(1),
    getOrgSlug(orgId),
    resolveComposeByAgentId(resolvedId),
  ]);

  if (!schedule) {
    throw notFound(`Schedule '${name}' not found`);
  }

  return { schedule, agentName: agent.name, orgSlug, composeId: compose?.id };
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
      artifactName: request.artifactName ?? null,
      artifactVersion: request.artifactVersion ?? null,
      volumeVersions: request.volumeVersions ?? null,
      ...(request.notifyEmail !== undefined && {
        notifyEmail: request.notifyEmail,
      }),
      ...(request.notifySlack !== undefined && {
        notifySlack: request.notifySlack,
      }),
      ...(request.slackChannelId !== undefined && {
        slackChannelId: request.slackChannelId,
      }),
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
      artifactName: request.artifactName ?? null,
      artifactVersion: request.artifactVersion ?? null,
      volumeVersions: request.volumeVersions ?? null,
      enabled: request.enabled ?? false,
      notifyEmail: request.notifyEmail ?? true,
      notifySlack: request.notifySlack ?? true,
      slackChannelId: request.slackChannelId ?? null,
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

  const agent = await loadZeroAgent(request.agentId);
  // Normalize request to use the resolved agentId (handles composeId fallback from CLI)
  request = { ...request, agentId: agent.id };
  const [orgSlug, compose] = await Promise.all([
    getOrgSlug(orgId),
    resolveComposeByAgentId(agent.id),
  ]);
  const composeId = compose?.id;

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

  if (existing) {
    const updated = await updateExistingSchedule(
      existing.id,
      request,
      triggerType,
      nextRunAt,
    );
    log.debug(`Updated schedule ${request.name} (${existing.id})`);
    return {
      schedule: toResponse(updated, agent.name, orgSlug, composeId),
      created: false,
    };
  }

  const created = await insertNewSchedule(
    userId,
    orgId,
    request,
    agent.id,
    triggerType,
    nextRunAt,
  );
  log.debug(`Created schedule ${request.name} (${created.id})`);
  return {
    schedule: toResponse(created, agent.name, orgSlug, composeId),
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

  // Load zero agent data for all schedules, joined with composes to get composeId
  const agentIds = [...new Set(userSchedules.map((s) => s.agentId))];
  const agentRows = await globalThis.services.db
    .select({
      agent: zeroAgents,
      composeId: agentComposes.id,
    })
    .from(zeroAgents)
    .leftJoin(
      agentComposes,
      and(
        eq(agentComposes.orgId, zeroAgents.orgId),
        eq(agentComposes.name, zeroAgents.name),
      ),
    )
    .where(inArray(zeroAgents.id, agentIds));
  const agentMap = new Map(agentRows.map((r) => [r.agent.id, r]));

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
      return agentMap.has(schedule.agentId);
    })
    .map((schedule) => {
      const row = agentMap.get(schedule.agentId)!;
      const orgSlug = orgDataMap.get(schedule.orgId)?.slug ?? "";
      return toResponse(
        schedule,
        row.agent.name,
        orgSlug,
        row.composeId ?? undefined,
      );
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

  const { schedule, agentName, orgSlug, composeId } =
    await verifyScheduleOwnership(userId, orgId, agentId, name);

  return toResponse(schedule, agentName, orgSlug, composeId);
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

  const { schedule, agentName, orgSlug, composeId } =
    await verifyScheduleOwnership(userId, orgId, agentId, name);

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

  return toResponse(updated, agentName, orgSlug, composeId);
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

  const { schedule, agentName, orgSlug, composeId } =
    await verifyScheduleOwnership(userId, orgId, agentId, name);

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

  return toResponse(updated, agentName, orgSlug, composeId);
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
  schedule: typeof zeroAgentSchedules.$inferSelect,
  lastRunId?: string,
): Promise<void> {
  const now = new Date();
  if (schedule.triggerType === "loop") {
    // Loop: don't advance nextRunAt here — the loop callback handles it on completion
    await globalThis.services.db
      .update(zeroAgentSchedules)
      .set({
        ...(lastRunId !== undefined && { lastRunId }),
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt: null, // Will be set by loop callback on run completion
      })
      .where(eq(zeroAgentSchedules.id, schedule.id));
  } else if (schedule.triggerType === "cron") {
    if (!schedule.cronExpression) {
      throw new Error(
        `Cron schedule ${schedule.name} (${schedule.id}) missing cronExpression`,
      );
    }
    const nextRunAt = calculateNextRun(
      schedule.cronExpression,
      schedule.timezone,
    );
    await globalThis.services.db
      .update(zeroAgentSchedules)
      .set({
        ...(lastRunId !== undefined && { lastRunId }),
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt,
      })
      .where(eq(zeroAgentSchedules.id, schedule.id));
  } else {
    // One-time (once): disable after execution
    if (schedule.triggerType !== "once") {
      log.warn(
        `advanceScheduleState reached one-time branch for schedule ${schedule.name} (${schedule.id}) with triggerType=${schedule.triggerType}`,
      );
    }
    await globalThis.services.db
      .update(zeroAgentSchedules)
      .set({
        enabled: false,
        ...(lastRunId !== undefined && { lastRunId }),
        lastRunAt: now,
        retryStartedAt: null,
        nextRunAt: null,
      })
      .where(eq(zeroAgentSchedules.id, schedule.id));
  }
}

/**
 * Execute a single schedule and return the created run ID.
 */
export async function executeSchedule(
  schedule: typeof zeroAgentSchedules.$inferSelect,
): Promise<string> {
  log.debug(`Executing schedule ${schedule.name} (${schedule.id})`);

  // Resolve compose via zero agent (single JOIN query)
  const compose = await resolveComposeByAgentId(schedule.agentId);

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

  // Build callbacks for run completion notifications
  const callbacks: Array<{
    url: string;
    secret: string;
    payload:
      | EmailScheduleCallbackPayload
      | SlackScheduleCallbackPayload
      | ScheduleLoopCallbackPayload;
  }> = [];

  // Email schedule notification callback
  // Schedule-level setting overrides global user preference
  if (globalThis.services.env.RESEND_API_KEY && schedule.notifyEmail) {
    const emailPayload: EmailScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      agentName: compose.name,
      userId: schedule.userId,
    };
    callbacks.push({
      url: `${getApiUrl()}/api/zero/email/callbacks/schedule`,
      secret: generateCallbackSecret(),
      payload: emailPayload,
    });
  }

  // Slack schedule notification callback
  // Schedule-level setting overrides global user preference
  if (schedule.notifySlack) {
    const slackPayload: SlackScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      agentName: compose.name,
      userId: schedule.userId,
      orgId: schedule.orgId,
      slackChannelId: schedule.slackChannelId,
    };
    callbacks.push({
      url: `${getApiUrl()}/api/internal/callbacks/slack/org/schedule`,
      secret: generateCallbackSecret(),
      payload: slackPayload,
    });
  }

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

  // Delegate run creation, validation, and dispatch to startRun()
  let runId: string;
  try {
    const result = await createZeroRun({
      userId: schedule.userId,
      prompt: schedule.prompt,
      appendSystemPrompt: schedule.appendSystemPrompt ?? undefined,
      agentId: schedule.agentId,
      scheduleId: schedule.id,
      triggerSource: "schedule",
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
  return runId;
}
