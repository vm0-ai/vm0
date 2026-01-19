import { eq, and, lte, inArray, desc } from "drizzle-orm";
import { Cron } from "croner";
import { agentSchedules } from "../../db/schema/agent-schedule";
import { agentComposes } from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { scopes } from "../../db/schema/scope";
import { encryptSecretsMap, decryptSecretsMap } from "../crypto";
import { NotFoundError, BadRequestError } from "../errors";
import { logger } from "../logger";
import { runService } from "../run/run-service";
import { generateSandboxToken } from "../auth/sandbox-token";

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
 */
interface DeployScheduleRequest {
  name: string;
  composeId: string;
  cronExpression?: string;
  atTime?: string;
  timezone: string;
  prompt: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
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
 * Schedule Service
 * Handles business logic for schedule management
 */
export class ScheduleService {
  /**
   * Calculate next run time from cron expression and timezone
   */
  private calculateNextRun(
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
  private toResponse(
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
      createdAt: schedule.createdAt.toISOString(),
      updatedAt: schedule.updatedAt.toISOString(),
    };
  }

  /**
   * Verify user owns the compose
   */
  private async verifyComposeOwnership(
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
      throw new NotFoundError("Agent compose not found or not owned by user");
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
  async deploy(
    userId: string,
    request: DeployScheduleRequest,
  ): Promise<{ schedule: ScheduleResponse; created: boolean }> {
    log.debug(
      `Deploying schedule ${request.name} for compose ${request.composeId}`,
    );

    // Verify user owns the compose
    const { compose, scopeSlug } = await this.verifyComposeOwnership(
      userId,
      request.composeId,
    );

    // Validate timezone
    if (!isValidTimezone(request.timezone)) {
      throw new BadRequestError(`Invalid timezone: ${request.timezone}`);
    }

    // Check for existing schedule with same name on this compose
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
        throw new BadRequestError(
          "This agent already has a schedule. Please edit the existing schedule or delete it first.",
        );
      }
    }

    // Encrypt secrets if provided
    const encryptedSecrets = encryptSecretsMap(
      request.secrets ?? null,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );

    // Calculate next run time
    let nextRunAt: Date | null = null;
    if (request.cronExpression) {
      nextRunAt = this.calculateNextRun(
        request.cronExpression,
        request.timezone,
      );
    } else if (request.atTime) {
      nextRunAt = new Date(request.atTime);
    }

    const now = new Date();

    if (existing) {
      // Update existing schedule
      const [updated] = await globalThis.services.db
        .update(agentSchedules)
        .set({
          cronExpression: request.cronExpression ?? null,
          atTime: request.atTime ? new Date(request.atTime) : null,
          timezone: request.timezone,
          prompt: request.prompt,
          vars: request.vars ?? null,
          encryptedSecrets,
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
        schedule: this.toResponse(updated, compose.name, scopeSlug),
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
          vars: request.vars ?? null,
          encryptedSecrets,
          artifactName: request.artifactName ?? null,
          artifactVersion: request.artifactVersion ?? null,
          volumeVersions: request.volumeVersions ?? null,
          enabled: true,
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
        schedule: this.toResponse(created, compose.name, scopeSlug),
        created: true,
      };
    }
  }

  /**
   * List all schedules for a user
   */
  async list(userId: string): Promise<ScheduleResponse[]> {
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
      return this.toResponse(
        schedule,
        compose?.name ?? "unknown",
        scopeMap.get(compose?.scopeId ?? "") ?? "default",
      );
    });
  }

  /**
   * Get schedule by name and compose ID
   */
  async getByName(
    userId: string,
    composeId: string,
    name: string,
  ): Promise<ScheduleResponse> {
    log.debug(`Getting schedule ${name} for compose ${composeId}`);

    // Verify user owns the compose
    const { compose, scopeSlug } = await this.verifyComposeOwnership(
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
      throw new NotFoundError(`Schedule '${name}' not found`);
    }

    return this.toResponse(schedule, compose.name, scopeSlug);
  }

  /**
   * Get recent runs for a schedule
   */
  async getRecentRuns(
    userId: string,
    composeId: string,
    scheduleName: string,
    limit: number,
  ): Promise<RunSummary[]> {
    log.debug(
      `Getting recent runs for schedule ${scheduleName} (limit: ${limit})`,
    );

    // Verify ownership
    await this.verifyComposeOwnership(userId, composeId);

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
      throw new NotFoundError(`Schedule '${scheduleName}' not found`);
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
  async delete(userId: string, composeId: string, name: string): Promise<void> {
    log.debug(`Deleting schedule ${name} for compose ${composeId}`);

    // Verify user owns the compose
    await this.verifyComposeOwnership(userId, composeId);

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
      throw new NotFoundError(`Schedule '${name}' not found`);
    }

    log.debug(`Deleted schedule ${name}`);
  }

  /**
   * Enable a schedule
   */
  async enable(
    userId: string,
    composeId: string,
    name: string,
  ): Promise<ScheduleResponse> {
    log.debug(`Enabling schedule ${name} for compose ${composeId}`);

    const { compose, scopeSlug } = await this.verifyComposeOwnership(
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
      throw new NotFoundError(`Schedule '${name}' not found`);
    }

    // Recalculate next run time
    let nextRunAt: Date | null = null;
    if (schedule.cronExpression) {
      nextRunAt = this.calculateNextRun(
        schedule.cronExpression,
        schedule.timezone,
      );
    } else if (schedule.atTime) {
      // For one-time schedules, check if atTime is in the future
      if (schedule.atTime > new Date()) {
        nextRunAt = schedule.atTime;
      }
    }

    const [updated] = await globalThis.services.db
      .update(agentSchedules)
      .set({
        enabled: true,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(agentSchedules.id, schedule.id))
      .returning();

    if (!updated) {
      throw new Error(`Failed to enable schedule ${name}`);
    }

    log.debug(`Enabled schedule ${name}`);

    return this.toResponse(updated, compose.name, scopeSlug);
  }

  /**
   * Disable a schedule
   */
  async disable(
    userId: string,
    composeId: string,
    name: string,
  ): Promise<ScheduleResponse> {
    log.debug(`Disabling schedule ${name} for compose ${composeId}`);

    const { compose, scopeSlug } = await this.verifyComposeOwnership(
      userId,
      composeId,
    );

    const [updated] = await globalThis.services.db
      .update(agentSchedules)
      .set({
        enabled: false,
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
      throw new NotFoundError(`Schedule '${name}' not found`);
    }

    log.debug(`Disabled schedule ${name}`);

    return this.toResponse(updated, compose.name, scopeSlug);
  }

  /**
   * Execute due schedules
   * Called by cron job every minute
   */
  async executeDueSchedules(): Promise<{ executed: number; skipped: number }> {
    const now = new Date();
    log.debug(`Checking for due schedules at ${now.toISOString()}`);

    // Find enabled schedules where nextRunAt <= now
    const dueSchedules = await globalThis.services.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.enabled, true),
          lte(agentSchedules.nextRunAt, now),
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
        await this.executeSchedule(schedule);
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
   * Execute a single schedule
   */
  private async executeSchedule(
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

    // Decrypt secrets
    const secrets = decryptSecretsMap(
      schedule.encryptedSecrets,
      globalThis.services.env.SECRETS_ENCRYPTION_KEY,
    );

    // Create run record first
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId: compose.userId,
        agentComposeVersionId: compose.headVersionId,
        scheduleId: schedule.id,
        status: "pending",
        prompt: schedule.prompt,
        vars: schedule.vars,
        secretNames: secrets ? Object.keys(secrets) : null,
        createdAt: new Date(),
      })
      .returning();

    if (!run) {
      log.error(`Failed to create run for schedule ${schedule.name}`);
      return;
    }

    // Generate sandbox token with the run ID
    const sandboxToken = await generateSandboxToken(compose.userId, run.id);

    // Build execution context and dispatch
    const context = await runService.buildExecutionContext({
      runId: run.id,
      agentComposeVersionId: compose.headVersionId,
      prompt: schedule.prompt,
      sandboxToken,
      userId: compose.userId,
      vars: schedule.vars ?? undefined,
      secrets: secrets ?? undefined,
      artifactName: schedule.artifactName ?? undefined,
      artifactVersion: schedule.artifactVersion ?? undefined,
      volumeVersions: schedule.volumeVersions ?? undefined,
      agentName: compose.name,
    });

    await runService.prepareAndDispatch(context);

    // Calculate next run time
    let nextRunAt: Date | null = null;
    if (schedule.cronExpression) {
      nextRunAt = this.calculateNextRun(
        schedule.cronExpression,
        schedule.timezone,
      );
    } else {
      // One-time schedule: disable after execution
      await globalThis.services.db
        .update(agentSchedules)
        .set({
          enabled: false,
          lastRunAt: new Date(),
          lastRunId: run.id,
          nextRunAt: null,
        })
        .where(eq(agentSchedules.id, schedule.id));
      log.debug(`One-time schedule ${schedule.name} executed and disabled`);
      return;
    }

    // Update schedule with next run time
    await globalThis.services.db
      .update(agentSchedules)
      .set({
        lastRunAt: new Date(),
        lastRunId: run.id,
        nextRunAt,
      })
      .where(eq(agentSchedules.id, schedule.id));

    log.debug(
      `Schedule ${schedule.name} executed, next run at ${nextRunAt?.toISOString()}`,
    );
  }
}

// Export singleton instance
export const scheduleService = new ScheduleService();
