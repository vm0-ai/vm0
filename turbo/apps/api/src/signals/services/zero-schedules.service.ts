import { command, computed, type Computed } from "ccstate";
import {
  zeroScheduleRunContract,
  zeroSchedulesMainContract,
  type DeployScheduleResponse,
  ScheduleListResponse,
  ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import type { ChatMessageScheduleSnapshot } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { isValidTimeZone, settle } from "../utils";
import {
  automationRowToTimeAutomation,
  DefaultInterpreter,
} from "./automations/default-interpreter";
import { calculateNextRun, TimeTrigger } from "./automations/time-trigger";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import { visibleJoinedZeroAgentCondition } from "./zero-agent-data.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import {
  postAutomationUserMessage,
  resolveScheduleChatThreadModelPin,
} from "../routes/zero-chat-messages";
import { publishChatThreadSchedulesChangedSafely } from "../external/realtime";

const log = logger("api:zero:schedules");
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const LIGHTWEIGHT_MODEL = "google/gemini-3.1-flash-lite-preview";

/** The time-trigger kinds the schedule surface manages (never webhook). */
const TIME_TRIGGER_KINDS = ["cron", "once", "loop"] as const;

type TimeTriggerKind = (typeof TIME_TRIGGER_KINDS)[number];

/**
 * A schedule as stored on the events-first tables: the automation (identity +
 * intent) joined with its single time trigger (recurrence config + runtime
 * state). The schedules API is a projection of this pair — phase 3 of #16847
 * cut its reads and writes over from the dropped-in-place zero_agent_schedules
 * surface.
 */
interface ScheduleView {
  readonly automation: typeof automations.$inferSelect;
  readonly trigger: typeof automationTriggers.$inferSelect;
}

// The schedule chip on the run's chat bubble: for a migrated automation the
// snapshot keeps the original schedule id so existing message rows and
// navigation stay coherent; natively-created automations use their own id.
function chatMessageScheduleSnapshot(
  automation: typeof automations.$inferSelect,
): ChatMessageScheduleSnapshot {
  return {
    id: automation.sourceScheduleId ?? automation.id,
    title: automation.name,
    description: automation.description ?? null,
  };
}

// The public ScheduleResponse projection of an automation + time trigger. The
// id is the automation id (D2 on #16847: schedule ids became automation ids at
// the phase-3 contract cutover; name addressing is unchanged). retryStartedAt
// is vestigial — the column was dropped — and stays null until the contract
// removes it.
function scheduleResponse(
  view: ScheduleView,
  displayName: string | null,
): ScheduleResponse {
  const { automation, trigger } = view;
  return {
    id: automation.id,
    agentId: automation.agentId,
    displayName,
    userId: automation.userId,
    name: automation.name,
    triggerType: trigger.kind as TimeTriggerKind,
    cronExpression: trigger.cronExpression,
    atTime: trigger.atTime?.toISOString() ?? null,
    intervalSeconds: trigger.intervalSeconds,
    timezone: trigger.timezone,
    prompt: automation.instruction,
    description: automation.description,
    appendSystemPrompt: automation.appendSystemPrompt,
    enabled: automation.enabled,
    nextRunAt: trigger.nextRunAt?.toISOString() ?? null,
    lastRunAt: trigger.lastRunAt?.toISOString() ?? null,
    retryStartedAt: null,
    consecutiveFailures: trigger.consecutiveFailures,
    chatThreadId: automation.chatThreadId,
    createdAt: automation.createdAt.toISOString(),
    updatedAt: automation.updatedAt.toISOString(),
  };
}

// Re-exported from the time trigger so existing callers (the reschedule
// callback route and the schedule tests) keep importing it from the service.
export { calculateNextRun };

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

export type RunCreationErrorResponse = {
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
    const settled = await settle(response.text());
    const text = settled.ok ? settled.value : "unknown error";
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
  const result = await settle(
    generateText(
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
    ),
  );

  if (!result.ok) {
    log.warn("Schedule description generation failed, using fallback", {
      error:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
      scheduleName: request.name,
    });
    return buildTemplateDescription(request, agentName);
  }

  return result.value ?? buildTemplateDescription(request, agentName);
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

/**
 * Load the schedule view for the (agent, name, org, user) key: the automation
 * row plus its single time trigger. Returns null when no automation exists or
 * when the name belongs to a non-time automation (e.g. webhook) — the
 * schedules surface only manages time automations.
 */
async function findScheduleView(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
  },
): Promise<ScheduleView | null> {
  const [row] = await db
    .select({ automation: automations, trigger: automationTriggers })
    .from(automations)
    .innerJoin(
      automationTriggers,
      eq(automationTriggers.automationId, automations.id),
    )
    .where(
      and(
        eq(automations.agentId, args.agentId),
        eq(automations.name, args.name),
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
        inArray(automationTriggers.kind, [...TIME_TRIGGER_KINDS]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * True when the (agent, name, org, user) key is already taken by an automation
 * with no time trigger (e.g. a webhook automation): deploying a schedule under
 * that name would violate the automations unique index, so the deploy rejects
 * it up front instead of 500ing.
 */
async function isNameTakenByNonTimeAutomation(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly name: string;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.agentId, args.agentId),
        eq(automations.name, args.name),
        eq(automations.orgId, args.orgId),
        eq(automations.userId, args.userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

type OwnershipResult =
  | {
      readonly ok: true;
      readonly view: ScheduleView;
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

  const view = await findScheduleView(db, { userId, orgId, agentId, name });
  if (!view) {
    return { ok: false };
  }

  return { ok: true, view, displayName: agent.displayName ?? null };
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

/**
 * Load an agent the user may target, scoped to the org and the user's
 * visibility: the agent gate shared by the schedule deploy and the v2
 * automation create.
 */
export async function loadAgentForDeploy(
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

/**
 * A chat thread may be linked to a schedule only if it exists, is owned by the
 * same user, and belongs to the same agent. (No cross-org sharing; chat threads
 * carry only a userId, so org isolation is enforced via the user.)
 */
async function isChatThreadLinkable(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  const [thread] = await db
    .select({
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.chatThreadId))
    .limit(1);
  return (
    thread !== undefined &&
    thread.userId === args.userId &&
    thread.agentComposeId === args.agentId
  );
}

type ChatThreadLinkResult =
  | {
      readonly ok: true;
      readonly chatThreadId: string | null;
      readonly createChatThread: boolean;
    }
  | { readonly ok: false; readonly error: DeployScheduleResult };

/**
 * Resolve the chat-thread link for a deploy: link a NEW schedule to either the
 * supplied owned chat thread or a server-created thread. The chatThreadId is
 * honored only on creation; on update of an existing schedule it is ignored and
 * the schedule keeps its original link.
 */
async function resolveScheduleChatThreadLink(args: {
  readonly db: Db;
  readonly chatThreadId: string | undefined;
  readonly agentId: string;
  readonly userId: string;
  readonly existing: boolean;
  readonly signal: AbortSignal;
}): Promise<ChatThreadLinkResult> {
  if (args.existing) {
    return { ok: true, chatThreadId: null, createChatThread: false };
  }
  if (args.chatThreadId !== undefined) {
    const linkable = await isChatThreadLinkable(args.db, {
      chatThreadId: args.chatThreadId,
      userId: args.userId,
      agentId: args.agentId,
    });
    args.signal.throwIfAborted();
    if (!linkable) {
      return {
        ok: false,
        error: {
          kind: "bad_request",
          message:
            "Chat thread not found, not owned by this user, or belongs to a different agent",
        },
      };
    }
    return {
      ok: true,
      chatThreadId: args.chatThreadId,
      createChatThread: false,
    };
  }
  return { ok: true, chatThreadId: null, createChatThread: true };
}

async function updateExistingSchedule(
  db: Db,
  args: {
    readonly existing: ScheduleView;
    readonly request: DeployScheduleBody;
    readonly triggerType: TimeTriggerKind;
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
  },
): Promise<ScheduleView> {
  return await db.transaction(async (tx) => {
    const [automation] = await tx
      .update(automations)
      .set({
        instruction: args.request.prompt,
        description: args.request.description ?? null,
        appendSystemPrompt: args.request.appendSystemPrompt ?? null,
        updatedAt: args.currentTime,
      })
      .where(eq(automations.id, args.existing.automation.id))
      .returning();
    const [trigger] = await tx
      .update(automationTriggers)
      .set({
        kind: args.triggerType,
        cronExpression: args.request.cronExpression ?? null,
        atTime: args.request.atTime ? new Date(args.request.atTime) : null,
        intervalSeconds: args.request.intervalSeconds ?? null,
        timezone: args.request.timezone,
        nextRunAt: args.nextRunAt,
        consecutiveFailures: 0,
        updatedAt: args.currentTime,
      })
      .where(eq(automationTriggers.id, args.existing.trigger.id))
      .returning();
    if (!automation || !trigger) {
      throw new Error(`Failed to update schedule ${args.request.name}`);
    }
    return { automation, trigger };
  });
}

async function insertNewSchedule(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly request: DeployScheduleBody;
    readonly triggerType: TimeTriggerKind;
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
    // Resolved chat-thread link. Null only when createChatThread is true (the
    // thread is created inside the transaction below). Computed in
    // deploySchedule$ after the ownership check — NOT read from the request body.
    readonly chatThreadId: string | null;
    readonly createChatThread: boolean;
  },
): Promise<ScheduleView> {
  const created = await db.transaction(async (tx) => {
    let chatThreadId = args.chatThreadId;
    if (args.createChatThread) {
      const [thread] = await tx
        .insert(chatThreads)
        .values({
          userId: args.userId,
          agentComposeId: args.request.agentId,
          title: args.request.description ?? args.request.name,
          lastMessageAt: args.currentTime,
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .returning({ id: chatThreads.id });
      if (!thread) {
        throw new Error("Failed to create chat thread");
      }
      chatThreadId = thread.id;
    }
    if (chatThreadId === null) {
      // Invariant: a new schedule either supplies a linkable thread
      // (createChatThread false) or has one created above (createChatThread
      // true). The link is never null at insert time.
      throw new Error("insertNewSchedule: resolved chat thread id is null");
    }

    const enabled = args.request.enabled ?? false;
    const [automation] = await tx
      .insert(automations)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name: args.request.name,
        description: args.request.description ?? null,
        instruction: args.request.prompt,
        appendSystemPrompt: args.request.appendSystemPrompt ?? null,
        agentId: args.request.agentId,
        chatThreadId,
        interpreterKind: "time",
        enabled,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!automation) {
      throw new Error(`Failed to create schedule ${args.request.name}`);
    }
    const [trigger] = await tx
      .insert(automationTriggers)
      .values({
        automationId: automation.id,
        kind: args.triggerType,
        cronExpression: args.request.cronExpression ?? null,
        atTime: args.request.atTime ? new Date(args.request.atTime) : null,
        intervalSeconds: args.request.intervalSeconds ?? null,
        timezone: args.request.timezone,
        nextRunAt: args.nextRunAt,
        consecutiveFailures: 0,
        enabled,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!trigger) {
      throw new Error(`Failed to create schedule ${args.request.name}`);
    }
    return { automation, trigger };
  });

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

    const existing = await findScheduleView(db, {
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.body.agentId,
      name: args.body.name,
    });
    signal.throwIfAborted();
    if (!existing) {
      const nameTaken = await isNameTakenByNonTimeAutomation(db, {
        userId: args.userId,
        orgId: args.orgId,
        agentId: args.body.agentId,
        name: args.body.name,
      });
      signal.throwIfAborted();
      if (nameTaken) {
        return {
          kind: "bad_request",
          message: `Name ${args.body.name} is already used by a non-schedule automation on this agent`,
        };
      }
    }

    // Chat-mode linkage: a NEW schedule is linked to either an owned supplied
    // thread or a server-created web chat thread. The link is create-only /
    // immutable.
    const chatLink = await resolveScheduleChatThreadLink({
      db,
      chatThreadId: args.body.chatThreadId,
      agentId: args.body.agentId,
      userId: args.userId,
      existing: existing !== null,
      signal,
    });
    if (!chatLink.ok) {
      return chatLink.error;
    }
    const chatThreadIdToLink = chatLink.chatThreadId;

    const effectiveBody =
      existing && args.body.enabled === undefined
        ? { ...args.body, enabled: existing.automation.enabled }
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

    const { triggerType, nextRunAt } = new TimeTrigger().resolve(
      bodyWithDescription,
      currentTime,
    );
    const view = existing
      ? await updateExistingSchedule(db, {
          existing,
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
          chatThreadId: chatThreadIdToLink,
          createChatThread: chatLink.createChatThread,
        });
    signal.throwIfAborted();

    // Notify the linked chat thread so its header schedule menu refreshes the
    // thread-scoped list in real time.
    await publishChatThreadSchedulesChangedSafely(
      args.userId,
      view.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      status: existing ? 200 : 201,
      response: {
        schedule: scheduleResponse(view, agent.displayName),
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

    const currentTime = nowDate();
    const updated = await db.transaction(async (tx) => {
      const [automation] = await tx
        .update(automations)
        .set({ enabled: false, updatedAt: currentTime })
        .where(eq(automations.id, ownership.view.automation.id))
        .returning();
      const [trigger] = await tx
        .update(automationTriggers)
        .set({ enabled: false, updatedAt: currentTime })
        .where(eq(automationTriggers.id, ownership.view.trigger.id))
        .returning();
      return automation && trigger ? { automation, trigger } : null;
    });
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    await publishChatThreadSchedulesChangedSafely(
      args.userId,
      updated.automation.chatThreadId,
    );
    signal.throwIfAborted();

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

    const chatThreadId = ownership.view.automation.chatThreadId;
    // The trigger row is removed by the FK cascade.
    const [deleted] = await db
      .delete(automations)
      .where(eq(automations.id, ownership.view.automation.id))
      .returning({ id: automations.id });
    signal.throwIfAborted();
    if (!deleted) {
      return { kind: "not_found" };
    }

    // Notify the linked chat thread so its header schedule menu drops the
    // deleted entry in real time.
    await publishChatThreadSchedulesChangedSafely(args.userId, chatThreadId);
    signal.throwIfAborted();

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
    const { view, displayName } = ownership;
    const { trigger } = view;

    const currentTime = nowDate();
    let nextRunAt: Date | null = null;
    if (trigger.kind === "loop") {
      nextRunAt = currentTime;
    } else if (trigger.cronExpression) {
      nextRunAt = calculateNextRun(
        trigger.cronExpression,
        trigger.timezone,
        currentTime,
      );
    } else if (trigger.atTime) {
      if (trigger.atTime > currentTime) {
        nextRunAt = trigger.atTime;
      } else {
        return { kind: "schedule_past" };
      }
    }

    const updated = await db.transaction(async (tx) => {
      const [automation] = await tx
        .update(automations)
        .set({ enabled: true, updatedAt: currentTime })
        .where(eq(automations.id, view.automation.id))
        .returning();
      const [updatedTrigger] = await tx
        .update(automationTriggers)
        .set({
          enabled: true,
          nextRunAt,
          consecutiveFailures: 0,
          updatedAt: currentTime,
        })
        .where(eq(automationTriggers.id, trigger.id))
        .returning();
      return automation && updatedTrigger
        ? { automation, trigger: updatedTrigger }
        : null;
    });
    signal.throwIfAborted();
    if (!updated) {
      return { kind: "not_found" };
    }

    await publishChatThreadSchedulesChangedSafely(
      args.userId,
      updated.automation.chatThreadId,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      response: scheduleResponse(updated, displayName),
    };
  },
);

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

type ScheduleRunModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly kind: "run_error";
        readonly response: RunCreationErrorResponse;
      };
    };

// Resolve the model context for a manually-fired automation run: the thread
// model pin (org default if unpinned) and the admitted provider. No user is
// present to receive a model-config / credits error, so failures surface as
// run_error (normalized to 400) feeding the run-now response. Shared by the
// schedule run-now and the v2 automation run-now.
export async function resolveScheduleRunModelContext(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<ScheduleRunModelContext> {
  const threadModelPin = await resolveScheduleChatThreadModelPin({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.chatThreadId,
  });
  args.signal.throwIfAborted();
  if ("status" in threadModelPin) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: { status: 400, body: threadModelPin.body },
      },
    };
  }

  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    modelPin: threadModelPin,
    requestedModelProvider: undefined,
  });
  args.signal.throwIfAborted();
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  return {
    ok: true,
    modelPin: threadModelPin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
  };
}

// After a manual run is created: render it as a web-chat turn (with the
// schedule chip), persist the resolved model fields, and stamp the run as
// lastRunId on every trigger of the automation so the per-trigger
// skip-if-active checks (the poller and the run-now conflict) see the active
// manual run. Shared by the schedule run-now (whose automation carries a
// single time trigger, so the stamp is identical to the historic per-trigger
// one) and the v2 automation run-now (where a manual fire belongs to no
// trigger in particular).
export async function persistManualRunSideEffects(args: {
  readonly db: Db;
  readonly automation: typeof automations.$inferSelect;
  readonly runId: string;
  readonly queued: boolean;
  readonly prompt: string;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
}): Promise<void> {
  const { automation } = args;
  await postAutomationUserMessage({
    db: args.db,
    threadId: automation.chatThreadId,
    userId: automation.userId,
    runId: args.runId,
    prompt: args.prompt,
    appendQueueMarker: args.queued,
    scheduleId: automation.sourceScheduleId ?? undefined,
    scheduleTitle: automation.name,
    scheduleSnapshot: chatMessageScheduleSnapshot(automation),
  });

  await args.db
    .update(zeroRuns)
    .set({
      modelProvider: args.effectiveModelProvider,
      modelProviderId: args.modelPin.modelProviderId,
      modelProviderCredentialScope: args.modelPin.modelProviderCredentialScope,
      selectedModel: args.modelPin.selectedModel,
    })
    .where(eq(zeroRuns.id, args.runId));

  await args.db
    .update(automationTriggers)
    .set({ lastRunId: args.runId })
    .where(eq(automationTriggers.automationId, automation.id));
}

// Manually fire a schedule as a web-chat turn in its linked thread. The id is
// the automation id (D2). Model comes from the thread pin (org default if
// unpinned); the session is always fresh (no sessionId). The run carries the
// trigger-keyed reschedule callback (advances next_run_at on completion when
// the trigger was claimed; a manual fire did not claim, so the advance lands on
// an already-set next_run_at — same semantics the schedule path always had) and
// the chat callback that owns the summary.
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
    const [view] = await db
      .select({ automation: automations, trigger: automationTriggers })
      .from(automations)
      .innerJoin(
        automationTriggers,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(
        and(
          eq(automations.id, args.body.scheduleId),
          eq(automations.orgId, args.orgId),
          inArray(automationTriggers.kind, [...TIME_TRIGGER_KINDS]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!view) {
      return { kind: "not_found", message: "Schedule not found" };
    }
    const { automation, trigger } = view;

    if (trigger.lastRunId) {
      const [lastRun] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, trigger.lastRunId))
        .limit(1);
      signal.throwIfAborted();

      if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
        return {
          kind: "conflict",
          message: "Previous run is still active",
        };
      }
    }

    const modelContext = await resolveScheduleRunModelContext({
      db,
      orgId: automation.orgId,
      userId: automation.userId,
      chatThreadId: automation.chatThreadId,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    // The single default interpreter handles every Automation kind, keyed off
    // an automation-table time trigger event (provenance + trigger-keyed
    // reschedule callback). The registry is deferred to the first fetching
    // interpreter (e.g. Gmail).
    const runInput = await new DefaultInterpreter().interpret(
      automationRowToTimeAutomation({
        id: automation.id,
        agentId: automation.agentId,
        orgId: automation.orgId,
        userId: automation.userId,
        chatThreadId: automation.chatThreadId,
        instruction: automation.instruction,
        appendSystemPrompt: automation.appendSystemPrompt,
        triggerType: trigger.kind as TimeTriggerKind,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
      }),
      { kind: "automation-time", triggerId: trigger.id },
    );
    signal.throwIfAborted();

    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: automation.orgId,
          orgRole: "member",
          userId: automation.userId,
          tokenType: "session",
        },
        body: {
          prompt: runInput.prompt,
          agentId: runInput.agentId,
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "schedule",
        chatThreadId: runInput.chatThreadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await persistManualRunSideEffects({
      db,
      automation,
      runId: result.body.runId,
      queued: result.body.status === "queued",
      prompt: runInput.prompt,
      modelPin,
      effectiveModelProvider,
    });
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
    const views = await db
      .select({ automation: automations, trigger: automationTriggers })
      .from(automations)
      .innerJoin(
        automationTriggers,
        eq(automationTriggers.automationId, automations.id),
      )
      .where(
        and(
          eq(automations.userId, args.userId),
          eq(automations.orgId, args.orgId),
          inArray(automationTriggers.kind, [...TIME_TRIGGER_KINDS]),
        ),
      );

    if (views.length === 0) {
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
          views.map((view) => {
            return view.automation.agentId;
          }),
        ),
      );
    const agentMap = new Map(
      agentRows.map((row) => {
        return [row.id, row.displayName] as const;
      }),
    );

    const responses = views.flatMap((view) => {
      if (!agentMap.has(view.automation.agentId)) {
        return [];
      }
      return [
        scheduleResponse(view, agentMap.get(view.automation.agentId) ?? null),
      ];
    });

    return {
      schedules: responses,
    };
  });
}
