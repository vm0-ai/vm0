import { createDecipheriv, randomBytes } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import {
  zeroScheduleRunContract,
  zeroSchedulesMainContract,
  type DeployScheduleResponse,
  ScheduleListResponse,
  ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import type {
  ScheduleCronCallbackPayload,
  ScheduleLoopCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-schedule";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { Cron } from "croner";
import { and, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { isValidTimeZone, safeAsync } from "../utils";
import { visibleJoinedZeroAgentCondition } from "./zero-agent-data.service";
import { createZeroRun$ } from "./zero-runs-create.service";

const log = logger("api:zero:schedules");
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const LIGHTWEIGHT_MODEL = "google/gemini-3.1-flash-lite-preview";
const MAX_CONSECUTIVE_FAILURES = 3;

const secretsMapSchema = z.record(z.string(), z.string());

function decryptSecretsMap(
  encryptedData: string | null,
): Record<string, string> | null {
  if (!encryptedData) {
    return null;
  }

  const key = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  const [ivBase64, authTagBase64, dataBase64] = encryptedData.split(":");
  if (!ivBase64 || !authTagBase64 || !dataBase64) {
    throw new Error("Invalid encrypted secrets format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivBase64, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final(),
  ]);

  return secretsMapSchema.parse(JSON.parse(decrypted.toString("utf8")));
}

function scheduleResponse(
  schedule: typeof zeroAgentSchedules.$inferSelect,
  displayName: string | null,
): ScheduleResponse {
  const secrets = decryptSecretsMap(schedule.encryptedSecrets);
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
    secretNames: secrets ? Object.keys(secrets) : null,
    volumeVersions: schedule.volumeVersions,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    retryStartedAt: schedule.retryStartedAt?.toISOString() ?? null,
    consecutiveFailures: schedule.consecutiveFailures,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };
}

export function calculateNextRun(
  cronExpression: string,
  timezone: string,
  fromDate: Date,
): Date | null {
  return new Cron(cronExpression, { timezone }).nextRun(fromDate);
}

type DeployScheduleBody = z.infer<
  (typeof zeroSchedulesMainContract.deploy)["body"]
>;
type RunScheduleBody = z.infer<(typeof zeroScheduleRunContract.run)["body"]>;

type DeployScheduleResult =
  | {
      readonly kind: "ok";
      readonly status: 200 | 201;
      readonly response: DeployScheduleResponse;
    }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "schedule_past"; readonly message: string };

type RunCreationErrorResponse = {
  readonly status: 400 | 402 | 403 | 404 | 429 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
};

type RunScheduleNowResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | {
      readonly kind: "run_error";
      readonly response: RunCreationErrorResponse;
    };

type ExecuteScheduleFailure = Exclude<RunScheduleNowResult, { kind: "ok" }>;

interface ExecuteDueSchedulesResult {
  readonly executed: number;
  readonly skipped: number;
}

interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface OpenRouterResponse {
  readonly choices: readonly {
    readonly message: {
      readonly content: string;
    };
  }[];
}

interface AgentScheduleTarget {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/(\*{1,3}|_{1,3})(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^["'](.+)["']$/, "$1")
    .trim();
}

async function generateText(
  messages: readonly ChatMessage[],
  maxTokens: number,
): Promise<string | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LIGHTWEIGHT_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => {
      return "unknown error";
    });
    throw new Error(`OpenRouter request failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty content");
  }
  return stripMarkdown(content);
}

function buildTemplateDescription(
  request: DeployScheduleBody,
  agentName: string,
): string {
  const triggerLabel = request.cronExpression
    ? "recurring"
    : request.atTime
      ? "one-time"
      : "loop";
  return `${agentName} ${triggerLabel} task: ${request.prompt.slice(0, 100)}`;
}

function triggerSummary(request: DeployScheduleBody): string {
  if (request.cronExpression) {
    return `cron: ${request.cronExpression}`;
  }
  if (request.atTime) {
    return `once at ${request.atTime}`;
  }
  if (request.intervalSeconds !== undefined) {
    return `loop every ${request.intervalSeconds}s`;
  }
  return "unknown trigger";
}

async function generateScheduleDescription(
  request: DeployScheduleBody,
  agentName: string,
): Promise<string> {
  const result = await safeAsync(() => {
    return generateText(
      [
        {
          role: "system",
          content:
            "Write a one-sentence summary (max 120 chars) for a scheduled task as plain text -- no markdown, no quotes, no special formatting. Return only the summary.",
        },
        {
          role: "user",
          content: `Agent: ${agentName}\nSchedule: ${request.name}\nTrigger: ${triggerSummary(request)}\nPrompt: ${request.prompt.slice(0, 200)}`,
        },
      ],
      30,
    );
  });

  if ("error" in result) {
    log.warn("Schedule description generation failed, using fallback", {
      error:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
      scheduleName: request.name,
    });
    return buildTemplateDescription(request, agentName);
  }

  return result.ok ?? buildTemplateDescription(request, agentName);
}

function resolveTrigger(
  request: DeployScheduleBody,
  currentTime: Date,
): {
  readonly triggerType: "cron" | "once" | "loop";
  readonly nextRunAt: Date | null;
} {
  if (request.cronExpression) {
    return {
      triggerType: "cron",
      nextRunAt: calculateNextRun(
        request.cronExpression,
        request.timezone,
        currentTime,
      ),
    };
  }
  if (request.atTime) {
    return { triggerType: "once", nextRunAt: new Date(request.atTime) };
  }
  return {
    triggerType: "loop",
    nextRunAt: request.enabled ? currentTime : null,
  };
}

function validateAtTimeNotPast(
  request: DeployScheduleBody,
  currentTime: Date,
): DeployScheduleResult | null {
  if (!request.atTime || !request.enabled) {
    return null;
  }
  const atDate = new Date(request.atTime);
  if (atDate > currentTime) {
    return null;
  }
  return {
    kind: "schedule_past",
    message: `Cannot create enabled schedule: scheduled time ${atDate.toISOString()} has already passed`,
  };
}

type OwnershipResult =
  | {
      readonly ok: true;
      readonly schedule: typeof zeroAgentSchedules.$inferSelect;
      readonly displayName: string | null;
    }
  | { readonly ok: false };

async function verifyScheduleOwnership(
  db: Db,
  userId: string,
  orgId: string,
  agentId: string,
  name: string,
): Promise<OwnershipResult> {
  const [agent] = await db
    .select({
      id: agentComposes.id,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.id, agentId))
    .limit(1);
  if (!agent) {
    return { ok: false };
  }

  const [schedule] = await db
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
    return { ok: false };
  }

  return { ok: true, schedule, displayName: agent.displayName ?? null };
}

type DisableScheduleResult =
  | { readonly kind: "ok"; readonly response: ScheduleResponse }
  | { readonly kind: "not_found" };

type DeleteScheduleResult =
  | { readonly kind: "ok" }
  | { readonly kind: "not_found" };

type EnableScheduleResult =
  | { readonly kind: "ok"; readonly response: ScheduleResponse }
  | { readonly kind: "not_found" }
  | { readonly kind: "schedule_past" };

interface ScheduleMutationArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly name: string;
}

async function loadAgentForDeploy(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<AgentScheduleTarget | null> {
  const [agent] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.id, args.agentId),
        visibleJoinedZeroAgentCondition(args.userId),
      ),
    )
    .limit(1);

  return agent ?? null;
}

async function findExistingSchedule(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
  },
): Promise<typeof zeroAgentSchedules.$inferSelect | null> {
  const [existing] = await db
    .select()
    .from(zeroAgentSchedules)
    .where(
      and(
        eq(zeroAgentSchedules.agentId, args.agentId),
        eq(zeroAgentSchedules.name, args.name),
        eq(zeroAgentSchedules.orgId, args.orgId),
        eq(zeroAgentSchedules.userId, args.userId),
      ),
    )
    .limit(1);
  return existing ?? null;
}

async function updateExistingSchedule(
  db: Db,
  args: {
    readonly existingId: string;
    readonly request: DeployScheduleBody;
    readonly triggerType: "cron" | "once" | "loop";
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
  },
): Promise<typeof zeroAgentSchedules.$inferSelect> {
  const [updated] = await db
    .update(zeroAgentSchedules)
    .set({
      triggerType: args.triggerType,
      cronExpression: args.request.cronExpression ?? null,
      atTime: args.request.atTime ? new Date(args.request.atTime) : null,
      intervalSeconds: args.request.intervalSeconds ?? null,
      timezone: args.request.timezone,
      prompt: args.request.prompt,
      description: args.request.description ?? null,
      appendSystemPrompt: args.request.appendSystemPrompt ?? null,
      vars: null,
      encryptedSecrets: null,
      volumeVersions: args.request.volumeVersions ?? null,
      nextRunAt: args.nextRunAt,
      consecutiveFailures: 0,
      updatedAt: args.currentTime,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    })
    .where(eq(zeroAgentSchedules.id, args.existingId))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update schedule ${args.request.name}`);
  }
  return updated;
}

async function insertNewSchedule(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly request: DeployScheduleBody;
    readonly triggerType: "cron" | "once" | "loop";
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
  },
): Promise<typeof zeroAgentSchedules.$inferSelect> {
  const [created] = await db
    .insert(zeroAgentSchedules)
    .values({
      agentId: args.request.agentId,
      userId: args.userId,
      orgId: args.orgId,
      name: args.request.name,
      triggerType: args.triggerType,
      cronExpression: args.request.cronExpression ?? null,
      atTime: args.request.atTime ? new Date(args.request.atTime) : null,
      intervalSeconds: args.request.intervalSeconds ?? null,
      timezone: args.request.timezone,
      prompt: args.request.prompt,
      description: args.request.description ?? null,
      appendSystemPrompt: args.request.appendSystemPrompt ?? null,
      vars: null,
      encryptedSecrets: null,
      volumeVersions: args.request.volumeVersions ?? null,
      enabled: args.request.enabled ?? false,
      nextRunAt: args.nextRunAt,
      consecutiveFailures: 0,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    })
    .returning();

  if (!created) {
    throw new Error(`Failed to create schedule ${args.request.name}`);
  }
  return created;
}

export const deploySchedule$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly body: DeployScheduleBody;
    },
    signal: AbortSignal,
  ): Promise<DeployScheduleResult> => {
    const db = set(writeDb$);
    const agent = await loadAgentForDeploy(db, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.body.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "not_found", message: "Agent not found" };
    }

    if (!isValidTimeZone(args.body.timezone)) {
      return {
        kind: "bad_request",
        message: `Invalid timezone: ${args.body.timezone}`,
      };
    }

    const currentTime = nowDate();
    const schedulePast = validateAtTimeNotPast(args.body, currentTime);
    if (schedulePast) {
      return schedulePast;
    }

    const existing = await findExistingSchedule(db, {
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.body.agentId,
      name: args.body.name,
    });
    signal.throwIfAborted();

    const effectiveBody =
      existing && args.body.enabled === undefined
        ? { ...args.body, enabled: existing.enabled }
        : args.body;
    const bodyWithDescription =
      effectiveBody.description === undefined
        ? {
            ...effectiveBody,
            description: await generateScheduleDescription(
              effectiveBody,
              agent.name,
            ),
          }
        : effectiveBody;
    signal.throwIfAborted();

    const { triggerType, nextRunAt } = resolveTrigger(
      bodyWithDescription,
      currentTime,
    );
    const schedule = existing
      ? await updateExistingSchedule(db, {
          existingId: existing.id,
          request: bodyWithDescription,
          triggerType,
          nextRunAt,
          currentTime,
        })
      : await insertNewSchedule(db, {
          userId: args.userId,
          orgId: args.orgId,
          request: bodyWithDescription,
          triggerType,
          nextRunAt,
          currentTime,
        });
    signal.throwIfAborted();

    return {
      kind: "ok",
      status: existing ? 200 : 201,
      response: {
        schedule: scheduleResponse(schedule, agent.displayName),
        created: !existing,
      },
    };
  },
);

export const disableSchedule$ = command(
  async (
    { set },
    args: ScheduleMutationArgs,
    signal: AbortSignal,
  ): Promise<DisableScheduleResult> => {
    const db = set(writeDb$);
    const ownership = await verifyScheduleOwnership(
      db,
      args.userId,
      args.orgId,
      args.agentId,
      args.name,
    );
    signal.throwIfAborted();
    if (!ownership.ok) {
      return { kind: "not_found" };
    }

    const [updated] = await db
      .update(zeroAgentSchedules)
      .set({
        enabled: false,
        retryStartedAt: null,
        updatedAt: nowDate(),
      })
      .where(eq(zeroAgentSchedules.id, ownership.schedule.id))
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    return {
      kind: "ok",
      response: scheduleResponse(updated, ownership.displayName),
    };
  },
);

export const deleteSchedule$ = command(
  async (
    { set },
    args: ScheduleMutationArgs,
    signal: AbortSignal,
  ): Promise<DeleteScheduleResult> => {
    const db = set(writeDb$);
    const ownership = await verifyScheduleOwnership(
      db,
      args.userId,
      args.orgId,
      args.agentId,
      args.name,
    );
    signal.throwIfAborted();
    if (!ownership.ok) {
      return { kind: "not_found" };
    }

    const [deleted] = await db
      .delete(zeroAgentSchedules)
      .where(eq(zeroAgentSchedules.id, ownership.schedule.id))
      .returning({ id: zeroAgentSchedules.id });
    signal.throwIfAborted();
    if (!deleted) {
      return { kind: "not_found" };
    }

    return { kind: "ok" };
  },
);

export const enableSchedule$ = command(
  async (
    { set },
    args: ScheduleMutationArgs,
    signal: AbortSignal,
  ): Promise<EnableScheduleResult> => {
    const db = set(writeDb$);
    const ownership = await verifyScheduleOwnership(
      db,
      args.userId,
      args.orgId,
      args.agentId,
      args.name,
    );
    signal.throwIfAborted();
    if (!ownership.ok) {
      return { kind: "not_found" };
    }
    const { schedule, displayName } = ownership;

    const now = nowDate();
    let nextRunAt: Date | null = null;
    if (schedule.triggerType === "loop") {
      nextRunAt = now;
    } else if (schedule.cronExpression) {
      nextRunAt = calculateNextRun(
        schedule.cronExpression,
        schedule.timezone,
        now,
      );
    } else if (schedule.atTime) {
      if (schedule.atTime > now) {
        nextRunAt = schedule.atTime;
      } else {
        return { kind: "schedule_past" };
      }
    }

    const [updated] = await db
      .update(zeroAgentSchedules)
      .set({
        enabled: true,
        nextRunAt,
        retryStartedAt: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(zeroAgentSchedules.id, schedule.id))
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    return {
      kind: "ok",
      response: scheduleResponse(updated, displayName),
    };
  },
);

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function isExecuteScheduleFailure(
  error: unknown,
): error is ExecuteScheduleFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    (error.kind === "not_found" ||
      error.kind === "conflict" ||
      error.kind === "run_error")
  );
}

function scheduleFailureMessage(error: unknown): string {
  if (!isExecuteScheduleFailure(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.kind === "run_error") {
    return `${error.response.status} ${error.response.body.error.code}: ${error.response.body.error.message}`;
  }
  return error.message;
}

function isInsufficientCreditsFailure(error: unknown): boolean {
  return (
    isExecuteScheduleFailure(error) &&
    error.kind === "run_error" &&
    error.response.body.error.code === "INSUFFICIENT_CREDITS"
  );
}

function nextRunAfterPreRunFailure(args: {
  readonly schedule: typeof zeroAgentSchedules.$inferSelect;
  readonly failureTime: Date;
  readonly shouldDisable: boolean;
}): Date | null {
  if (args.shouldDisable) {
    return null;
  }
  if (args.schedule.triggerType === "cron" && args.schedule.cronExpression) {
    return calculateNextRun(
      args.schedule.cronExpression,
      args.schedule.timezone,
      args.failureTime,
    );
  }
  if (args.schedule.triggerType === "loop" && args.schedule.intervalSeconds) {
    return new Date(
      args.failureTime.getTime() + args.schedule.intervalSeconds * 1000,
    );
  }
  return null;
}

async function recordSchedulePreRunFailure(
  db: Db,
  schedule: typeof zeroAgentSchedules.$inferSelect,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  const isCreditError = isInsufficientCreditsFailure(error);
  const failureMessage = scheduleFailureMessage(error);
  const failureContext = {
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    orgId: schedule.orgId,
    userId: schedule.userId,
    error: failureMessage,
    stack: error instanceof Error ? error.stack : undefined,
  };
  if (isCreditError) {
    log.warn("Schedule skipped: insufficient credits", failureContext);
  } else {
    log.error("Schedule pre-run failed", failureContext);
  }

  const failureTime = nowDate();
  const newFailureCount = schedule.consecutiveFailures + 1;
  const shouldDisable = newFailureCount >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = nextRunAfterPreRunFailure({
    schedule,
    failureTime,
    shouldDisable,
  });

  await db
    .update(zeroAgentSchedules)
    .set({
      consecutiveFailures: newFailureCount,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: failureTime,
    })
    .where(eq(zeroAgentSchedules.id, schedule.id));
  signal.throwIfAborted();

  if (shouldDisable) {
    log.warn("Schedule auto-disabled after consecutive pre-run failures", {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      orgId: schedule.orgId,
      userId: schedule.userId,
      consecutiveFailures: newFailureCount,
      reason: isCreditError ? "insufficient_credits" : "pre_run_failure",
    });
  }
}

export const executeDueSchedules$ = command(
  async ({ set }, signal: AbortSignal): Promise<ExecuteDueSchedulesResult> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    log.debug("Checking for due schedules", {
      currentTime: currentTime.toISOString(),
    });

    const dueSchedules = await db
      .select()
      .from(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.enabled, true),
          lte(zeroAgentSchedules.nextRunAt, currentTime),
        ),
      )
      .limit(10);
    signal.throwIfAborted();

    let executed = 0;
    let skipped = 0;

    for (const schedule of dueSchedules) {
      if (schedule.lastRunId) {
        const [lastRun] = await db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, schedule.lastRunId))
          .limit(1);
        signal.throwIfAborted();

        if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
          log.debug("Skipping schedule: previous run still active", {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
          });
          skipped++;
          continue;
        }
      }

      const [claimed] = await db
        .update(zeroAgentSchedules)
        .set({
          nextRunAt: null,
          lastRunAt: currentTime,
          retryStartedAt: null,
          updatedAt: currentTime,
          ...(schedule.triggerType === "once" ? { enabled: false } : {}),
        })
        .where(
          and(
            eq(zeroAgentSchedules.id, schedule.id),
            eq(zeroAgentSchedules.nextRunAt, schedule.nextRunAt!),
          ),
        )
        .returning();
      signal.throwIfAborted();

      if (!claimed) {
        log.debug("Skipping schedule: already claimed", {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
        });
        skipped++;
        continue;
      }

      const runResult = await safeAsync(() => {
        return set(
          runScheduleNow$,
          {
            body: { scheduleId: schedule.id },
            orgId: schedule.orgId,
            apiStartTime: now(),
          },
          signal,
        );
      });
      signal.throwIfAborted();
      if ("error" in runResult) {
        await recordSchedulePreRunFailure(
          db,
          schedule,
          runResult.error,
          signal,
        );
        skipped++;
        continue;
      }
      const result = runResult.ok;
      if (result.kind !== "ok") {
        await recordSchedulePreRunFailure(db, schedule, result, signal);
        skipped++;
        continue;
      }
      executed++;
    }

    log.debug("Executed due schedules", { executed, skipped });
    return { executed, skipped };
  },
);

function buildSchedulePrompt(triggerType: string): string {
  return [
    "# Current Integration",
    "You are currently running inside: Schedule",
    `Trigger type: ${triggerType}`,
  ].join("\n");
}

function apiUrl(): string {
  return env("VM0_API_URL");
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildScheduleCallbacks(
  schedule: typeof zeroAgentSchedules.$inferSelect,
) {
  if (schedule.triggerType === "loop") {
    const payload: ScheduleLoopCallbackPayload = { scheduleId: schedule.id };
    return [
      {
        url: `${apiUrl()}/api/internal/callbacks/schedule/loop`,
        secret: generateCallbackSecret(),
        payload,
      },
    ];
  }

  if (schedule.triggerType === "cron" || schedule.triggerType === "once") {
    const payload: ScheduleCronCallbackPayload = {
      scheduleId: schedule.id,
      ...(schedule.cronExpression && {
        cronExpression: schedule.cronExpression,
      }),
      timezone: schedule.timezone,
    };
    return [
      {
        url: `${apiUrl()}/api/internal/callbacks/schedule/cron`,
        secret: generateCallbackSecret(),
        payload,
      },
    ];
  }

  return [];
}

function buildScheduleAppendSystemPrompt(
  schedule: typeof zeroAgentSchedules.$inferSelect,
): string {
  const integrationContext = buildSchedulePrompt(schedule.triggerType);
  const baseAppendPrompt = schedule.appendSystemPrompt ?? undefined;
  return baseAppendPrompt
    ? `${integrationContext}\n\n${baseAppendPrompt}`
    : integrationContext;
}

export const runScheduleNow$ = command(
  async (
    { set },
    args: {
      readonly body: RunScheduleBody;
      readonly orgId: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<RunScheduleNowResult> => {
    const db = set(writeDb$);
    const [schedule] = await db
      .select()
      .from(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.id, args.body.scheduleId),
          eq(zeroAgentSchedules.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!schedule) {
      return { kind: "not_found", message: "Schedule not found" };
    }

    if (schedule.lastRunId) {
      const [lastRun] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, schedule.lastRunId))
        .limit(1);
      signal.throwIfAborted();

      if (
        lastRun &&
        (lastRun.status === "pending" || lastRun.status === "running")
      ) {
        return {
          kind: "conflict",
          message: "Previous run is still active",
        };
      }
    }

    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: schedule.orgId,
          orgRole: "member",
          userId: schedule.userId,
          tokenType: "session",
        },
        body: {
          prompt: schedule.prompt,
          agentId: schedule.agentId,
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "schedule",
        appendSystemPrompt: buildScheduleAppendSystemPrompt(schedule),
        callbacks: buildScheduleCallbacks(schedule),
        zeroRunMetadata: { scheduleId: schedule.id },
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await db
      .update(zeroAgentSchedules)
      .set({ lastRunId: result.body.runId })
      .where(eq(zeroAgentSchedules.id, schedule.id));
    signal.throwIfAborted();

    return { kind: "ok", runId: result.body.runId };
  },
);

export function zeroScheduleList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ScheduleListResponse>> {
  return computed(async (get): Promise<ScheduleListResponse> => {
    const db = get(db$);
    const schedules = await db
      .select()
      .from(zeroAgentSchedules)
      .where(
        and(
          eq(zeroAgentSchedules.userId, args.userId),
          eq(zeroAgentSchedules.orgId, args.orgId),
        ),
      );

    if (schedules.length === 0) {
      return { schedules: [] };
    }

    const agentRows = await db
      .select({
        id: agentComposes.id,
        displayName: zeroAgents.displayName,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        inArray(
          agentComposes.id,
          schedules.map((schedule) => {
            return schedule.agentId;
          }),
        ),
      );
    const agentMap = new Map(
      agentRows.map((row) => {
        return [row.id, row.displayName] as const;
      }),
    );

    return {
      schedules: schedules.flatMap((schedule) => {
        if (!agentMap.has(schedule.agentId)) {
          return [];
        }
        return [
          scheduleResponse(schedule, agentMap.get(schedule.agentId) ?? null),
        ];
      }),
    };
  });
}
