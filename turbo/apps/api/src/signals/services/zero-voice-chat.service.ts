import { createHash, randomBytes } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import type {
  VoiceChatItem,
  VoiceChatSession,
  VoiceChatTask,
  VoiceChatTaskResultEntry,
  VoiceChatTokenResponse,
} from "@vm0/api-contracts/contracts/zero-voice-chat";
import {
  DEFAULT_NOISE_REDUCTION,
  INPUT_AUDIO_TRANSCRIPTION_CONFIG,
  SESSION_OUTPUT_MODALITIES,
  SESSION_TOOLS,
  TALKER_MODEL,
  TALKER_REASONING_CONFIG,
  TALKER_VOICE,
  TURN_DETECTION_CONFIG,
  type NoiseReduction,
} from "@vm0/core/voice-chat/session-config";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { usageEvent } from "@vm0/db/schema/usage-event";
import {
  voiceChatItems,
  voiceChatRealtimeSessions,
  voiceChatSessions,
  voiceChatTasks,
} from "@vm0/db/schema/voice-chat";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { isBadRequestResponse, notFound } from "../../lib/error";
import { db$, writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { safeAsync, safeJsonParse } from "../utils";
import { createAgentRun$ } from "./agent-run-create.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  type CancelRunResult,
} from "./zero-run-cancel.service";

const ACTIVE_TASK_STATUSES = ["pending", "queued", "running"] as const;
const FINISHED_TASK_STATUSES = ["done", "failed"] as const;
const MAX_FINISHED_TASKS = 3;
const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
const OPENROUTER_TIMEOUT_MS = 30_000;
const REASONER_MAX_TOKENS = 800;
const OPENROUTER_TEMPERATURE = 0.2;
const MAX_UPSTREAM_ERROR_BODY_LENGTH = 2000;
const MIN_COMPACTED_RESULT_LEN = 300;
const COMPACT_SHRINK_PER_MINUTE = 0.9;
const COMPACT_INTERVAL_MS = 60_000;
const MIN_COMPACT_SHRINK_FRACTION = 0.1;
const RECENT_ITEMS_LIMIT = 20;
const MODEL_USAGE_KIND = "model";
const REALTIME_SESSION_PROVIDER = "openai";
const REALTIME_PROVIDER = "gpt-realtime-2";
const TRANSCRIPTION_PROVIDER = "gpt-4o-mini-transcribe";
const VOICE_CHAT_USAGE_NAMESPACE = "dd3f7425-aa8f-56d0-87cb-6158c8c621de";
const REALTIME_TOKEN_CATEGORIES = [
  "tokens.input.text",
  "tokens.input.audio",
  "tokens.input.cached_text",
  "tokens.input.cached_audio",
  "tokens.output.text",
  "tokens.output.audio",
] as const;
const TRANSCRIPTION_TOKEN_CATEGORIES = [
  "tokens.input.audio",
  "tokens.input.text",
  "tokens.output.text",
] as const;
const CONVERSATION_SECTION = "CONVERSATION";
const MISSING_TASKS_SECTION = "MISSING_TASKS";
const REASONER_SYSTEM_PROMPT = `You are the Reasoner for a voice chat session. A separate Talker agent speaks to the user in real time; the Talker is a small speech-to-speech model with limited reasoning. Your job is to maintain a compact conversation summary the Talker can rely on each turn, and to catch when the Talker promised to do something but never created a task.

The Talker gets the task board (in-flight tasks, recently finished, lifecycle events) straight from the database - you do NOT narrate task state, counts, or progress. Leave all of that to the DB-backed task board.

You emit one required section and one optional section. Plain text, no markdown, no JSON, no code fences.

---${CONVERSATION_SECTION}---
Short summary of the non-task conversation state. Use these labels, one line each, omit empty ones:
  User: identity / background / preferences (stable across turns)
  Focus: the big thing the user is trying to accomplish right now
  Decided: bullet list of choices/constraints the user has already locked in - so Talker does not re-ask them
  Open: bullet list of unanswered questions, unfulfilled Talker promises, or ambiguities the user hasn't resolved - these are conversation-level loose ends, NOT live tasks (tasks are on the DB-backed board and you should ignore them here)
  Entities: shorthand references (not tasks) the user and Talker keep returning to (files, PRs, people)
  Style: current tone / pacing / any correction the user made to Talker
Keep each label to one short line (Decided / Open / Entities may use a short comma-separated list). Do not narrate tasks.

---${MISSING_TASKS_SECTION}---
Optional. Only emit this section if you detect a gap: the Talker said it would do something (research, check, create, investigate, look up, find out, etc.) in the last 3-5 turns, but there is NO matching pending, queued, or running task on the board. One task prompt per line. Be specific and actionable. If nothing is missing, omit this entire section.

No preamble, no explanations.`;
const SLOW_BRAIN_PREAMBLE = `You are the slow brain of a voice-chat assistant. A separate Talker brain (running on OpenAI Realtime) is having a live voice conversation with the user. Whenever the Talker picks up something it thinks might need attention, it calls the \`inform_slow_brain(prompt)\` tool to forward it to you.

**This is an inform, not a request.** The Talker is not directing your actions - it is surfacing a signal from a noisy voice stream. You have the full session context below (conversation, pending work, recently finished work). Based on that, you decide what is actually useful: act, decline, clarify, or just point at existing work. The Talker does not know what you already know.

Voice is messy and repetitive. The same real intent often arrives as several informs across turns - rephrased, retranscribed, repeated, or re-confirmed. Two informs in a row may be the same thing, or may be different things that sound the same. Always let the session context - especially the pending-tasks and recently-finished-tasks sections - be your primary evidence for what is actually going on, rather than the inform text alone.

Whatever you return is what the Talker voices back to the user, so keep it concise and substantive.`;
const SLOW_BRAIN_EPILOGUE = `The Talker brain has informed you of the following (delivered as the incoming user message). Use the context above to decide what - if anything - to do, and return something the Talker can voice back to the user.`;
const logReasoner = logger("zero:voice-chat:reasoner");
const logCompactor = logger("zero:voice-chat:compact");
const logTask = logger("zero:voice-chat:task");
const logToken = logger("api:zero:voice-chat:token");
const logUsage = logger("api:zero:voice-chat:usage");

type SessionRow = typeof voiceChatSessions.$inferSelect;
type ItemRow = typeof voiceChatItems.$inferSelect;
type TaskRow = typeof voiceChatTasks.$inferSelect;
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CompleteVoiceChatTaskArgs {
  readonly taskId: string;
  readonly result: string | null;
  readonly error: string | null;
  readonly agentId: string;
}

interface CompleteVoiceChatTaskOutcome {
  readonly item: ItemRow;
  readonly task: TaskRow;
  readonly mismatch: boolean;
  readonly session: {
    readonly id: string;
    readonly orgId: string;
    readonly userId: string;
  };
}

interface CompleteVoiceChatTaskResult {
  readonly item: ItemRow;
  readonly task: TaskRow;
  readonly session: { readonly id: string; readonly userId: string };
}

type ErrorResponse<Status extends number, Code extends string> = {
  readonly status: Status;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: Code;
    };
  };
};

interface AssistantInterruptedNote {
  readonly type: "assistant_interrupted";
  readonly assistantRealtimeItemId: string;
  readonly heardText: string;
  readonly audioEndMs?: number;
}

interface ItemForReasoner {
  readonly seq: number;
  readonly role: string;
  readonly content: string | null;
  readonly createdAt: string;
}

interface TaskForReasoner {
  readonly id: string;
  readonly status: string;
  readonly prompt: string;
  readonly resultText: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

interface ReasonerResult {
  readonly conversationSummary: string;
  readonly missingTasks: readonly string[];
}

interface OpenRouterResponse {
  readonly choices: readonly {
    readonly message: { readonly content: string };
  }[];
}

interface OpenAiClientSecretResponse {
  readonly value: string;
  readonly expires_at: number;
}

const OPENAI_TOKEN_ERROR_TAG = "OpenAiTokenError" as const;

interface OpenAiTokenError extends Error {
  readonly name: typeof OPENAI_TOKEN_ERROR_TAG;
  readonly status: number;
  readonly body: string;
}

type VoiceChatUsageEventType = "response.done" | "transcription.completed";

interface VoiceChatUsageTokens {
  readonly inputText?: number;
  readonly inputAudio?: number;
  readonly inputCachedText?: number;
  readonly inputCachedAudio?: number;
  readonly outputText?: number;
  readonly outputAudio?: number;
}

interface RecordVoiceChatRealtimeUsageInput {
  readonly voiceChatSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly providerEventId: string;
  readonly eventType: VoiceChatUsageEventType;
  readonly tokens: VoiceChatUsageTokens;
}

interface RecordVoiceChatRealtimeUsageResult {
  readonly creditsExhausted: boolean;
  readonly rowsInserted: number;
}

interface VoiceChatUsageCategoryRow {
  readonly category: string;
  readonly quantity: number;
}

function buildVoiceChatUsageIdempotencyKey(parts: {
  readonly voiceChatSessionId: string;
  readonly providerEventId: string;
  readonly category: string;
}): string {
  const name = `${parts.voiceChatSessionId}:${parts.providerEventId}:${parts.category}`;
  return uuidv5(name, VOICE_CHAT_USAGE_NAMESPACE);
}

function openRouterRequestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(OPENROUTER_TIMEOUT_MS)]);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/**
 * Map a `voice_chat_sessions` row to the contract-shaped `VoiceChatSession`
 * DTO. Mirrors web's `serializeVoiceChatSession` in
 * `apps/web/app/api/zero/voice-chat/_support.ts` so the contract -> row
 * mapping has a single source of truth across the api migration. Sibling
 * routes (`getSession`, `listTasks`) reuse this when they migrate.
 */
export function serializeVoiceChatSession(
  session: typeof voiceChatSessions.$inferSelect,
): VoiceChatSession {
  return {
    id: session.id,
    orgId: session.orgId,
    userId: session.userId,
    agentId: session.agentId,
    mode: "chat",
    conversationSummary: session.conversationSummary,
    workingTasksSummary: session.workingTasksSummary,
    finishedTasksSummary: session.finishedTasksSummary,
    summarySeq: session.summarySeq,
    summaryVersion: session.summaryVersion,
    lastSummaryAt: session.lastSummaryAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
  };
}

export function serializeVoiceChatItem(item: ItemRow): VoiceChatItem {
  return {
    id: item.id,
    sessionId: item.sessionId,
    seq: item.seq,
    role: item.role as VoiceChatItem["role"],
    content: item.content,
    taskId: item.taskId,
    realtimeItemId: item.realtimeItemId,
    createdAt: item.createdAt.toISOString(),
  };
}

function routeError<Status extends number, Code extends string>(
  status: Status,
  code: Code,
  message: string,
): ErrorResponse<Status, Code> {
  return {
    status,
    body: { error: { message, code } },
  };
}

function insufficientCredits(): ErrorResponse<402, "INSUFFICIENT_CREDITS"> {
  return routeError(
    402,
    "INSUFFICIENT_CREDITS",
    "Insufficient credits. Please add credits to continue.",
  );
}

function pricingNotConfigured(
  missing: readonly string[],
): ErrorResponse<503, "NOT_CONFIGURED"> {
  return routeError(
    503,
    "NOT_CONFIGURED",
    `Voice-chat realtime pricing is not configured: ${missing.join(", ")}`,
  );
}

function internalError(
  message: string,
): ErrorResponse<500, "INTERNAL_SERVER_ERROR"> {
  return routeError(500, "INTERNAL_SERVER_ERROR", message);
}

export function voiceChatSessionList(
  orgId: string,
  userId: string,
): Computed<Promise<(typeof voiceChatSessions.$inferSelect)[]>> {
  return computed((get) => {
    const db = get(db$);
    return db
      .select()
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.orgId, orgId),
          eq(voiceChatSessions.userId, userId),
        ),
      )
      .orderBy(desc(voiceChatSessions.createdAt));
  });
}

export function voiceChatSessionDetail(
  orgId: string,
  userId: string,
  sessionId: string,
): Computed<Promise<typeof voiceChatSessions.$inferSelect | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [session] = await db
      .select()
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.id, sessionId),
          eq(voiceChatSessions.orgId, orgId),
          eq(voiceChatSessions.userId, userId),
        ),
      )
      .limit(1);
    return session ?? null;
  });
}

export const createVoiceChatSession$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ): Promise<SessionRow> => {
    const writeDb = set(writeDb$);
    const [existing] = await writeDb
      .select()
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.userId, args.userId),
          eq(voiceChatSessions.agentId, args.agentId),
        ),
      )
      .orderBy(desc(voiceChatSessions.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      return existing;
    }

    const [session] = await writeDb
      .insert(voiceChatSessions)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
      })
      .returning();
    signal.throwIfAborted();
    if (!session) {
      throw new Error("Failed to insert voice-chat session");
    }
    return session;
  },
);

/**
 * Map a `voice_chat_tasks` row to the contract-shaped `VoiceChatTask` DTO.
 */
export function serializeVoiceChatTask(
  task: typeof voiceChatTasks.$inferSelect,
): VoiceChatTask {
  return {
    id: task.id,
    sessionId: task.sessionId,
    runId: task.runId,
    callId: task.callId,
    prompt: task.prompt,
    status: task.status as VoiceChatTask["status"],
    result: task.result,
    resultUpdatedAt: task.resultUpdatedAt?.toISOString() ?? null,
    assistantMessages: task.assistantMessages,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
  };
}

export function voiceChatTaskList(
  sessionId: string,
): Computed<Promise<(typeof voiceChatTasks.$inferSelect)[]>> {
  return computed(async (get) => {
    const db = get(db$);

    const active = await db
      .select()
      .from(voiceChatTasks)
      .where(
        and(
          eq(voiceChatTasks.sessionId, sessionId),
          inArray(voiceChatTasks.status, ACTIVE_TASK_STATUSES),
        ),
      )
      .orderBy(asc(voiceChatTasks.createdAt));

    const finished = await db
      .select()
      .from(voiceChatTasks)
      .where(
        and(
          eq(voiceChatTasks.sessionId, sessionId),
          inArray(voiceChatTasks.status, FINISHED_TASK_STATUSES),
        ),
      )
      .orderBy(desc(voiceChatTasks.finishedAt))
      .limit(MAX_FINISHED_TASKS);

    return [...active, ...finished];
  });
}

function allVoiceChatTasks(sessionId: string): Computed<Promise<TaskRow[]>> {
  return computed((get) => {
    const db = get(db$);
    return db
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.sessionId, sessionId))
      .orderBy(desc(voiceChatTasks.createdAt));
  });
}

function readVoiceChatItems(
  sessionId: string,
  afterSeq?: number,
): Computed<Promise<ItemRow[]>> {
  return computed((get) => {
    const db = get(db$);
    const baseCondition = eq(voiceChatItems.sessionId, sessionId);
    const condition =
      afterSeq !== undefined
        ? and(baseCondition, sql`${voiceChatItems.seq} > ${afterSeq}`)
        : baseCondition;
    return db
      .select()
      .from(voiceChatItems)
      .where(condition)
      .orderBy(asc(voiceChatItems.seq));
  });
}

export const appendVoiceChatItem$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly role: VoiceChatItem["role"];
      readonly content: string | null;
      readonly taskId?: string | null;
      readonly realtimeItemId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly item: ItemRow; readonly inserted: boolean }
    | ErrorResponse<404, "NOT_FOUND">
  > => {
    const writeDb = set(writeDb$);
    const [inserted] = await writeDb
      .insert(voiceChatItems)
      .values({
        sessionId: args.sessionId,
        role: args.role,
        content: args.content,
        taskId: args.taskId ?? null,
        realtimeItemId: args.realtimeItemId ?? null,
      })
      .onConflictDoNothing({
        target: [voiceChatItems.sessionId, voiceChatItems.realtimeItemId],
      })
      .returning();
    signal.throwIfAborted();

    if (inserted) {
      return { item: inserted, inserted: true };
    }

    if (!args.realtimeItemId) {
      return notFound("Voice-chat item not found");
    }

    const [existing] = await writeDb
      .select()
      .from(voiceChatItems)
      .where(
        and(
          eq(voiceChatItems.sessionId, args.sessionId),
          eq(voiceChatItems.realtimeItemId, args.realtimeItemId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Conflicting item not found after dedupe");
    }
    return { item: existing, inserted: false };
  },
);

function callbackUrl(path: string): string {
  return new URL(path, env("VM0_API_URL")).toString();
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildVoiceChatTaskCallbacks(taskId: string) {
  return [
    {
      url: callbackUrl("/api/internal/callbacks/voice-chat"),
      secret: generateCallbackSecret(),
      payload: { taskId },
    },
  ] as const;
}

export function voiceChatTaskAppendSystemPrompt(
  sessionId: string,
  agentId: string,
): Computed<Promise<string>> {
  return computed(async (get) => {
    const [agentSystemPrompt, items, sessionTasks] = await Promise.all([
      get(resolveAgentSystemPrompt(agentId)),
      get(readVoiceChatItems(sessionId)),
      get(allVoiceChatTasks(sessionId)),
    ]);
    return buildSlowBrainAppendSystemPrompt({
      agentSystemPrompt,
      items,
      sessionTasks,
    });
  });
}

export const createVoiceChatTask$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly callId: string;
      readonly prompt: string;
      readonly appendSystemPrompt: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly task: TaskRow }
    | ErrorResponse<400, "BAD_REQUEST">
    | ErrorResponse<403, "FORBIDDEN">
    | ErrorResponse<404, "NOT_FOUND">
    | ErrorResponse<402, "INSUFFICIENT_CREDITS">
    | ErrorResponse<429, "CONCURRENT_RUN_LIMIT">
    | ErrorResponse<503, "PROVIDER_UNAVAILABLE">
  > => {
    const writeDb = set(writeDb$);
    const [inserted] = await writeDb
      .insert(voiceChatTasks)
      .values({
        sessionId: args.sessionId,
        callId: args.callId,
        prompt: args.prompt,
        status: "pending",
      })
      .returning();
    signal.throwIfAborted();
    if (!inserted) {
      throw new Error("Failed to insert voice-chat task");
    }

    const triggerSource: TriggerSource = "voice-chat";
    const runResult = await set(
      createAgentRun$,
      {
        userId: args.userId,
        orgId: args.orgId,
        body: {
          prompt: args.prompt,
          agentComposeId: args.agentId,
          appendSystemPrompt: args.appendSystemPrompt,
          triggerSource,
        },
        apiStartTime: args.apiStartTime,
        callbacks: buildVoiceChatTaskCallbacks(inserted.id),
      },
      signal,
    );
    signal.throwIfAborted();

    if (runResult.status !== 201) {
      await writeDb
        .delete(voiceChatTasks)
        .where(eq(voiceChatTasks.id, inserted.id));
      signal.throwIfAborted();
      return runResult;
    }

    const nextStatus =
      runResult.body.status === "queued" ? "queued" : "pending";
    const [updated] = await writeDb
      .update(voiceChatTasks)
      .set({ runId: runResult.body.runId, status: nextStatus })
      .where(eq(voiceChatTasks.id, inserted.id))
      .returning();
    signal.throwIfAborted();

    return { status: 200, task: updated ?? inserted };
  },
);

export const markVoiceChatTaskRunningIfQueued$ = command(
  async (
    { set },
    runId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly sessionId: string;
    readonly userId: string;
  } | null> => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .update(voiceChatTasks)
      .set({ status: "running", startedAt: nowDate() })
      .where(
        and(
          eq(voiceChatTasks.runId, runId),
          inArray(voiceChatTasks.status, ["pending", "queued"]),
        ),
      )
      .returning({ sessionId: voiceChatTasks.sessionId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    const [session] = await writeDb
      .select({ userId: voiceChatSessions.userId })
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, row.sessionId))
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return null;
    }
    return { sessionId: row.sessionId, userId: session.userId };
  },
);

export const appendVoiceChatTaskAssistantResult$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly entries: readonly VoiceChatTaskResultEntry[];
    },
    signal: AbortSignal,
  ): Promise<{
    readonly sessionId: string;
    readonly userId: string;
  } | null> => {
    if (args.entries.length === 0) {
      return null;
    }

    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .update(voiceChatTasks)
      .set({
        assistantMessages: sql`${voiceChatTasks.assistantMessages} || ${JSON.stringify([...args.entries])}::jsonb`,
      })
      .where(
        and(
          eq(voiceChatTasks.runId, args.runId),
          inArray(voiceChatTasks.status, ["pending", "queued", "running"]),
        ),
      )
      .returning({ sessionId: voiceChatTasks.sessionId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    const [session] = await writeDb
      .select({ userId: voiceChatSessions.userId })
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, row.sessionId))
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return null;
    }
    return { sessionId: row.sessionId, userId: session.userId };
  },
);

function isCancelRunResult(value: unknown): value is CancelRunResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "alreadyCancelled" in value &&
    "runId" in value
  );
}

function isRunNotCancellableResult(value: unknown): boolean {
  if (!isBadRequestResponse(value)) {
    return false;
  }
  const body = value.body;
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return false;
  }
  const error = body.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "RUN_NOT_CANCELLABLE"
  );
}

function formatTaskResult(params: {
  readonly result: string | null;
  readonly error: string | null;
}): string {
  if (params.error) {
    return `[task failed] ${params.error}`;
  }
  return params.result ?? "[task returned empty result]";
}

async function completeMismatchedVoiceChatTask(
  tx: WriteTx,
  taskRow: TaskRow,
  sessionRow: SessionRow,
  finishedAt: Date,
): Promise<CompleteVoiceChatTaskOutcome> {
  const [failedTask] = await tx
    .update(voiceChatTasks)
    .set({
      status: "failed",
      error: "agent mismatch",
      finishedAt,
    })
    .where(eq(voiceChatTasks.id, taskRow.id))
    .returning();

  const [noteItem] = await tx
    .insert(voiceChatItems)
    .values({
      sessionId: taskRow.sessionId,
      role: "system_note",
      content: "agent mismatch — task failed",
      taskId: taskRow.id,
      realtimeItemId: null,
    })
    .returning();

  if (!noteItem) {
    throw new Error("Failed to insert voice-chat mismatch note");
  }

  return {
    task: failedTask ?? taskRow,
    item: noteItem,
    mismatch: true,
    session: {
      id: sessionRow.id,
      orgId: sessionRow.orgId,
      userId: sessionRow.userId,
    },
  };
}

async function completeMatchedVoiceChatTask(
  tx: WriteTx,
  taskRow: TaskRow,
  sessionRow: SessionRow,
  args: CompleteVoiceChatTaskArgs,
  finishedAt: Date,
): Promise<CompleteVoiceChatTaskOutcome> {
  const finalEntries: VoiceChatTaskResultEntry[] = args.result
    ? [
        {
          type: "assistant",
          content: args.result,
          at: finishedAt.toISOString(),
        },
      ]
    : [];
  const consolidatedResult = [
    flattenTaskResult(taskRow.assistantMessages) ?? "",
    args.result ?? "",
  ]
    .filter((content) => {
      return content.length > 0;
    })
    .join("\n");
  const [completedTask] = await tx
    .update(voiceChatTasks)
    .set({
      status: args.error ? "failed" : "done",
      assistantMessages: sql`${voiceChatTasks.assistantMessages} || ${JSON.stringify(finalEntries)}::jsonb`,
      result: consolidatedResult.length > 0 ? consolidatedResult : null,
      resultUpdatedAt: consolidatedResult.length > 0 ? finishedAt : null,
      error: args.error,
      finishedAt,
    })
    .where(eq(voiceChatTasks.id, taskRow.id))
    .returning();

  const [resultItem] = await tx
    .insert(voiceChatItems)
    .values({
      sessionId: taskRow.sessionId,
      role: "task_result",
      content: formatTaskResult({
        result: args.result,
        error: args.error,
      }),
      taskId: taskRow.id,
      realtimeItemId: null,
    })
    .returning();

  if (!resultItem) {
    throw new Error("Failed to insert voice-chat task result");
  }

  return {
    task: completedTask ?? taskRow,
    item: resultItem,
    mismatch: false,
    session: {
      id: sessionRow.id,
      orgId: sessionRow.orgId,
      userId: sessionRow.userId,
    },
  };
}

async function completeVoiceChatTaskMutation(
  writeDb: Db,
  args: CompleteVoiceChatTaskArgs,
): Promise<CompleteVoiceChatTaskOutcome | null> {
  return await writeDb.transaction(async (tx) => {
    const [taskRow] = await tx
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, args.taskId))
      .for("update")
      .limit(1);
    if (!taskRow) {
      return null;
    }

    const [sessionRow] = await tx
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, taskRow.sessionId))
      .limit(1);
    if (!sessionRow) {
      return null;
    }

    const finishedAt = nowDate();
    return sessionRow.agentId !== args.agentId
      ? await completeMismatchedVoiceChatTask(
          tx,
          taskRow,
          sessionRow,
          finishedAt,
        )
      : await completeMatchedVoiceChatTask(
          tx,
          taskRow,
          sessionRow,
          args,
          finishedAt,
        );
  });
}

export const completeVoiceChatTask$ = command(
  async (
    { set },
    args: CompleteVoiceChatTaskArgs,
    signal: AbortSignal,
  ): Promise<CompleteVoiceChatTaskResult | null> => {
    const writeDb = set(writeDb$);
    const outcome = await completeVoiceChatTaskMutation(writeDb, args);
    signal.throwIfAborted();

    if (!outcome) {
      return null;
    }

    if (outcome.mismatch) {
      const pending = await writeDb
        .select()
        .from(voiceChatTasks)
        .where(
          and(
            eq(voiceChatTasks.sessionId, outcome.session.id),
            inArray(voiceChatTasks.status, ["pending", "queued"]),
          ),
        );
      signal.throwIfAborted();

      for (const task of pending) {
        if (!task.runId) {
          continue;
        }
        const cancelled = await set(
          cancelRun$,
          {
            runId: task.runId,
            userId: outcome.session.userId,
            orgId: outcome.session.orgId,
          },
          signal,
        );
        signal.throwIfAborted();
        if (isCancelRunResult(cancelled)) {
          await set(dispatchCancelSideEffects$, cancelled, signal);
          signal.throwIfAborted();
          continue;
        }
        if (isRunNotCancellableResult(cancelled)) {
          logTask.warn(
            `cancelRun for task ${task.id} (runId=${task.runId}) skipped - run is no longer cancellable`,
          );
          continue;
        }
        throw new Error(`Failed to cancel voice-chat task run ${task.runId}`);
      }
    }

    return {
      task: outcome.task,
      item: outcome.item,
      session: { id: outcome.session.id, userId: outcome.session.userId },
    };
  },
);

function buildReasonerUserPrompt(params: {
  readonly agentSystemPrompt: string;
  readonly priorConversationSummary: string | null;
  readonly transcript: readonly ItemForReasoner[];
  readonly tasks: readonly TaskForReasoner[];
}): string {
  const agentSlot = params.agentSystemPrompt.trim() || "(none)";
  const priorConversation = params.priorConversationSummary?.trim() || "(none)";
  const transcriptSlot =
    params.transcript.length === 0
      ? "(none)"
      : params.transcript
          .map((item) => {
            return `[${item.seq}] ${item.role}: ${item.content ?? ""}`;
          })
          .join("\n");
  const tasksSlot =
    params.tasks.length === 0
      ? "(none)"
      : params.tasks
          .map((task) => {
            const parts = [
              `[${task.id}] status=${task.status}`,
              `prompt: ${task.prompt}`,
            ];
            if (task.resultText) {
              parts.push(`result: ${task.resultText}`);
            }
            if (task.error) {
              parts.push(`error: ${task.error}`);
            }
            return parts.join("\n  ");
          })
          .join("\n\n");

  return [
    `Agent system prompt:\n${agentSlot}`,
    `Prior conversation summary:\n${priorConversation}`,
    `Full conversation transcript:\n${transcriptSlot}`,
    `Tasks this session (for grounding only - DO NOT summarize these):\n${tasksSlot}`,
  ].join("\n\n");
}

function extractSection(raw: string, name: string): string {
  const marker = `---${name}---`;
  const idx = raw.indexOf(marker);
  if (idx === -1) {
    return "";
  }
  const after = raw.slice(idx + marker.length);
  const nextIdx = after.search(/---[A-Z_]+---/u);
  const slice = nextIdx === -1 ? after : after.slice(0, nextIdx);
  return slice.trim();
}

function parseReasonerSections(raw: string): ReasonerResult {
  const missingTasksRaw = extractSection(raw, MISSING_TASKS_SECTION);
  const missingTasks = missingTasksRaw
    .split("\n")
    .map((line) => {
      return line.trim();
    })
    .filter((line) => {
      return line.length > 0;
    });

  return {
    conversationSummary: extractSection(raw, CONVERSATION_SECTION),
    missingTasks,
  };
}

async function callReasoner(params: {
  readonly agentSystemPrompt: string;
  readonly priorConversationSummary: string | null;
  readonly transcript: readonly ItemForReasoner[];
  readonly tasks: readonly TaskForReasoner[];
  readonly signal: AbortSignal;
}): Promise<ReasonerResult | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    logReasoner.warn(
      "OPENROUTER_API_KEY not configured, skipping reasoner call",
    );
    return null;
  }

  const responseResult = await safeAsync(() => {
    return fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: REASONER_SYSTEM_PROMPT },
          { role: "user", content: buildReasonerUserPrompt(params) },
        ],
        max_tokens: REASONER_MAX_TOKENS,
        temperature: OPENROUTER_TEMPERATURE,
      }),
      signal: openRouterRequestSignal(params.signal),
    });
  });
  if ("error" in responseResult) {
    if (isTimeoutError(responseResult.error)) {
      logReasoner.warn("reasoner fetch timed out");
      return null;
    }
    if (responseResult.error instanceof TypeError) {
      logReasoner.warn("reasoner network error", responseResult.error);
      return null;
    }
    throw responseResult.error;
  }

  const response = responseResult.ok;
  if (!response.ok) {
    const text = await response.text();
    logReasoner.warn(`reasoner request failed: ${response.status} ${text}`);
    return null;
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content.trim();
  if (!content) {
    logReasoner.warn("reasoner returned empty content");
    return null;
  }

  return parseReasonerSections(content);
}

function parseAssistantInterruptedNote(
  content: string,
): AssistantInterruptedNote | null {
  const parsed = safeJsonParse(content);
  if (parsed === undefined) {
    logReasoner.warn(`failed to parse assistant interrupted note: ${content}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const note = parsed as Partial<AssistantInterruptedNote>;
  if (
    note.type !== "assistant_interrupted" ||
    typeof note.assistantRealtimeItemId !== "string" ||
    typeof note.heardText !== "string"
  ) {
    return null;
  }
  return {
    type: "assistant_interrupted",
    assistantRealtimeItemId: note.assistantRealtimeItemId,
    heardText: note.heardText,
    audioEndMs: note.audioEndMs,
  };
}

type InterruptedMap = Map<
  string,
  { heardText: string; seq: number; createdAt: Date; consumed: boolean }
>;

function collectAssistantInterruptions(
  items: readonly ItemRow[],
): InterruptedMap {
  const interrupted: InterruptedMap = new Map();
  for (const item of items) {
    if (item.role !== "system_note" || !item.content) {
      continue;
    }
    const note = parseAssistantInterruptedNote(item.content);
    if (!note) {
      continue;
    }
    interrupted.set(note.assistantRealtimeItemId, {
      heardText: note.heardText,
      seq: item.seq,
      createdAt: item.createdAt,
      consumed: false,
    });
  }
  return interrupted;
}

function transcriptReplacement(
  item: ItemRow,
  interrupted: InterruptedMap,
): ItemRow | null | "skip" {
  if (item.role === "system_note") {
    return item.content && parseAssistantInterruptedNote(item.content)
      ? "skip"
      : item;
  }

  if (item.role !== "assistant" || !item.realtimeItemId) {
    return item;
  }

  const replacement = interrupted.get(item.realtimeItemId);
  if (!replacement) {
    return item;
  }
  replacement.consumed = true;
  return replacement.heardText.trim()
    ? { ...item, content: replacement.heardText }
    : "skip";
}

function buildReasonerTranscript(items: readonly ItemRow[]): ItemRow[] {
  const interrupted = collectAssistantInterruptions(items);
  const transcript: ItemRow[] = [];
  for (const item of items) {
    const replacement = transcriptReplacement(item, interrupted);
    if (replacement !== "skip" && replacement !== null) {
      transcript.push(replacement);
    }
  }

  for (const replacement of interrupted.values()) {
    if (!replacement.consumed && replacement.heardText.trim()) {
      transcript.push({
        ...items[0]!,
        id: items[0]?.id ?? "",
        sessionId: items[0]?.sessionId ?? "",
        seq: replacement.seq,
        role: "assistant",
        content: replacement.heardText,
        taskId: null,
        realtimeItemId: null,
        createdAt: replacement.createdAt,
      });
    }
  }

  return transcript.sort((left, right) => {
    return left.seq - right.seq;
  });
}

function flattenTaskResult(
  result: readonly {
    readonly type: "assistant";
    readonly content: string;
    readonly at: string;
  }[],
): string | null {
  if (result.length === 0) {
    return null;
  }
  return result
    .map((entry) => {
      return entry.content;
    })
    .join("\n");
}

function resolveAgentSystemPrompt(
  agentId: string | null,
): Computed<Promise<string>> {
  return computed(async (get) => {
    if (!agentId) {
      return "";
    }
    const db = get(db$);
    const [row] = await db
      .select({ content: agentComposeVersions.content })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposeVersions.id, agentComposes.headVersionId),
      )
      .where(eq(agentComposes.id, agentId))
      .limit(1);
    if (!row?.content || typeof row.content !== "object") {
      return "";
    }
    const content = row.content as {
      readonly agents?: Record<string, { readonly description?: string }>;
    };
    const firstAgent = content.agents
      ? Object.values(content.agents)[0]
      : undefined;
    return firstAgent?.description ?? "";
  });
}

function formatItems(items: readonly ItemRow[]): string {
  const recent = items.slice(-RECENT_ITEMS_LIMIT);
  if (recent.length === 0) {
    return "(none)";
  }
  return recent
    .map((item) => {
      return `[${item.seq}] ${item.role}: ${item.content ?? ""}`;
    })
    .join("\n");
}

function formatPendingTasks(tasks: readonly TaskRow[]): string {
  const pending = tasks.filter((task) => {
    return ACTIVE_TASK_STATUSES.some((status) => {
      return status === task.status;
    });
  });
  if (pending.length === 0) {
    return "(none)";
  }
  return pending
    .map((task) => {
      return `[${task.id}] status=${task.status} prompt: ${task.prompt}`;
    })
    .join("\n");
}

function formatFinishedTasks(tasks: readonly TaskRow[]): string {
  const finished = tasks.filter((task) => {
    return task.status === "done" || task.status === "failed";
  });
  if (finished.length === 0) {
    return "(none)";
  }
  return finished
    .map((task) => {
      const header = `[${task.id}] status=${task.status} prompt: ${task.prompt}`;
      const parts: string[] = [header];
      const body = task.result ?? flattenTaskResult(task.assistantMessages);
      if (body) {
        parts.push(`result:\n${body}`);
      }
      if (task.error) {
        parts.push(`error: ${task.error}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

function buildSlowBrainAppendSystemPrompt(params: {
  readonly agentSystemPrompt: string;
  readonly items: readonly ItemRow[];
  readonly sessionTasks: readonly TaskRow[];
}): string {
  const agentPrompt = params.agentSystemPrompt.trim() || "(none)";
  return [
    SLOW_BRAIN_PREAMBLE,
    `[Voice chat agent system prompt]\n${agentPrompt}`,
    `[Last ${RECENT_ITEMS_LIMIT.toString()} transcript items]\n${formatItems(
      params.items,
    )}`,
    `[Pending tasks in this voice chat session]\n${formatPendingTasks(
      params.sessionTasks,
    )}`,
    `[Recently finished tasks in this voice chat session]\n${formatFinishedTasks(
      params.sessionTasks,
    )}`,
    SLOW_BRAIN_EPILOGUE,
  ].join("\n\n");
}

function computeTargetLen(currentLen: number, elapsedMs: number): number {
  const minutes = elapsedMs / 60_000;
  const shrinkRatio = Math.pow(COMPACT_SHRINK_PER_MINUTE, minutes);
  return Math.max(
    MIN_COMPACTED_RESULT_LEN,
    Math.floor(currentLen * shrinkRatio),
  );
}

function buildCompactorPrompt(params: {
  readonly prompt: string;
  readonly currentResult: string;
  readonly targetLen: number;
}): string {
  return [
    "You are compacting a past task result so it stays useful in a voice-chat assistant's long-running context.",
    `The user asked: ${params.prompt}`,
    `Current stored result (${params.currentResult.length.toString()} chars):`,
    params.currentResult,
    `Compact this down to roughly ${params.targetLen.toString()} characters. Keep only the facts, numbers, names, and conclusions most likely to be referenced later. Drop narrative, reasoning, and redundant detail. Plain text only - no markdown, no preamble, no meta-commentary. Output ONLY the compacted result.`,
  ].join("\n\n");
}

async function callCompactor(params: {
  readonly prompt: string;
  readonly currentResult: string;
  readonly targetLen: number;
  readonly apiKey: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const responseResult = await safeAsync(() => {
    return fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: "user", content: buildCompactorPrompt(params) }],
        max_tokens: Math.max(256, Math.ceil(params.targetLen / 2)),
        temperature: OPENROUTER_TEMPERATURE,
      }),
      signal: openRouterRequestSignal(params.signal),
    });
  });
  if ("error" in responseResult) {
    if (isTimeoutError(responseResult.error)) {
      logCompactor.warn("compactor fetch timed out");
      return null;
    }
    if (responseResult.error instanceof TypeError) {
      logCompactor.warn("compactor network error", responseResult.error);
      return null;
    }
    throw responseResult.error;
  }

  const response = responseResult.ok;
  if (!response.ok) {
    const text = await response.text();
    logCompactor.warn(`compactor request failed: ${response.status} ${text}`);
    return null;
  }

  const data = (await response.json()) as OpenRouterResponse;
  const content = data.choices[0]?.message.content.trim();
  if (!content) {
    logCompactor.warn("compactor returned empty content");
    return null;
  }
  return content;
}

const compactVoiceChatTaskResults$ = command(
  async (
    { set },
    args: { readonly sessionId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const apiKey = optionalEnv("OPENROUTER_API_KEY");
    if (!apiKey) {
      return;
    }

    const writeDb = set(writeDb$);
    const rows = await writeDb
      .select()
      .from(voiceChatTasks)
      .where(
        and(
          eq(voiceChatTasks.sessionId, args.sessionId),
          inArray(voiceChatTasks.status, ["done", "failed"]),
        ),
      );
    signal.throwIfAborted();

    const nowMs = now();
    let compactedCount = 0;
    for (const row of rows) {
      const flattened = row.assistantMessages
        .map((entry) => {
          return entry.content;
        })
        .join("\n");
      const currentResult =
        row.result ?? (flattened.length > 0 ? flattened : null);
      const currentTimestamp =
        row.resultUpdatedAt ?? row.finishedAt ?? row.createdAt;
      if (!currentResult) {
        continue;
      }
      const currentLen = currentResult.length;
      if (currentLen <= MIN_COMPACTED_RESULT_LEN) {
        continue;
      }

      const elapsedMs = nowMs - currentTimestamp.getTime();
      if (elapsedMs < COMPACT_INTERVAL_MS) {
        continue;
      }

      const targetLen = computeTargetLen(currentLen, elapsedMs);
      if ((currentLen - targetLen) / currentLen < MIN_COMPACT_SHRINK_FRACTION) {
        continue;
      }

      const compacted = await callCompactor({
        prompt: row.prompt,
        currentResult,
        targetLen,
        apiKey,
        signal,
      });
      signal.throwIfAborted();
      if (compacted === null) {
        continue;
      }

      await writeDb
        .update(voiceChatTasks)
        .set({ result: compacted, resultUpdatedAt: nowDate() })
        .where(eq(voiceChatTasks.id, row.id));
      signal.throwIfAborted();
      compactedCount++;
    }

    if (compactedCount > 0) {
      await publishUserSignal([args.userId], `voice-chat:${args.sessionId}`);
      signal.throwIfAborted();
      logCompactor.debug(
        `compacted ${compactedCount.toString()} task result(s) for session ${args.sessionId}`,
      );
    }
  },
);

const drainPending$ = command(
  async ({ set }, sessionId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    const drained = await writeDb
      .update(voiceChatSessions)
      .set({ reasoningPending: false })
      .where(
        and(
          eq(voiceChatSessions.id, sessionId),
          eq(voiceChatSessions.reasoningPending, true),
        ),
      )
      .returning({ id: voiceChatSessions.id });
    signal.throwIfAborted();

    if (drained.length > 0) {
      await set(triggerVoiceChatReasoning$, sessionId, signal);
    }
  },
);

const releaseAndDrain$ = command(
  async (
    { set },
    args: { readonly sessionId: string; readonly startedAt: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(voiceChatSessions)
      .set({
        reasoningStatus: "idle",
        lastReasoningDurationMs: now() - args.startedAt.getTime(),
      })
      .where(eq(voiceChatSessions.id, args.sessionId));
    signal.throwIfAborted();
    await set(drainPending$, args.sessionId, signal);
  },
);

type ReasoningAcquireResult =
  | { readonly status: "skip" }
  | {
      readonly status: "acquired";
      readonly session: SessionRow;
      readonly startedAt: Date;
    };

const acquireReasoningSession$ = command(
  async (
    { set },
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ReasoningAcquireResult> => {
    const writeDb = set(writeDb$);
    const [session] = await writeDb
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, sessionId))
      .limit(1);
    signal.throwIfAborted();
    if (!session) {
      return { status: "skip" };
    }

    const startedAt = nowDate();
    const acquired = await writeDb
      .update(voiceChatSessions)
      .set({
        reasoningStatus: "running",
        lastReasoningStartedAt: startedAt,
        lastReasoningDurationMs: null,
      })
      .where(
        and(
          eq(voiceChatSessions.id, sessionId),
          eq(voiceChatSessions.reasoningStatus, "idle"),
        ),
      )
      .returning({ id: voiceChatSessions.id });
    signal.throwIfAborted();

    if (acquired.length === 0) {
      const [row] = await writeDb
        .update(voiceChatSessions)
        .set({ reasoningPending: true })
        .where(eq(voiceChatSessions.id, sessionId))
        .returning({ status: voiceChatSessions.reasoningStatus });
      signal.throwIfAborted();
      if (row?.status === "idle") {
        await set(triggerVoiceChatReasoning$, sessionId, signal);
      }
      return { status: "skip" };
    }

    const [freshSession] = await writeDb
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, sessionId))
      .limit(1);
    signal.throwIfAborted();
    if (!freshSession) {
      await set(releaseAndDrain$, { sessionId, startedAt }, signal);
      return { status: "skip" };
    }
    return { status: "acquired", session: freshSession, startedAt };
  },
);

interface ReasoningSnapshot {
  readonly transcript: readonly ItemRow[];
  readonly effectiveTranscript: readonly ItemRow[];
  readonly tasks: readonly TaskRow[];
  readonly maxSeq: number;
  readonly hasInFlightTask: boolean;
}

const loadReasoningSnapshot$ = command(
  async (
    { get },
    args: { readonly sessionId: string; readonly session: SessionRow },
    signal: AbortSignal,
  ): Promise<ReasoningSnapshot> => {
    const transcript = await get(readVoiceChatItems(args.sessionId));
    signal.throwIfAborted();
    const tasks = await get(allVoiceChatTasks(args.sessionId));
    signal.throwIfAborted();
    return {
      transcript,
      effectiveTranscript: buildReasonerTranscript(transcript),
      tasks,
      maxSeq:
        transcript.length > 0
          ? Math.max(
              ...transcript.map((item) => {
                return item.seq;
              }),
            )
          : args.session.summarySeq,
      hasInFlightTask: tasks.some((task) => {
        return ACTIVE_TASK_STATUSES.some((status) => {
          return status === task.status;
        });
      }),
    };
  },
);

const callReasonerForSnapshot$ = command(
  async (
    { get },
    args: {
      readonly session: SessionRow;
      readonly snapshot: ReasoningSnapshot;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly agentSystemPrompt: string;
    readonly result: ReasonerResult | null;
  }> => {
    const agentSystemPrompt = await get(
      resolveAgentSystemPrompt(args.session.agentId),
    );
    signal.throwIfAborted();
    const result = await callReasoner({
      agentSystemPrompt,
      priorConversationSummary: args.session.conversationSummary,
      transcript: args.snapshot.effectiveTranscript.map((item) => {
        return {
          seq: item.seq,
          role: item.role,
          content: item.content,
          createdAt: item.createdAt.toISOString(),
        };
      }),
      tasks: args.snapshot.tasks.map((task) => {
        return {
          id: task.id,
          status: task.status,
          prompt: task.prompt,
          resultText: task.result ?? flattenTaskResult(task.assistantMessages),
          error: task.error,
          createdAt: task.createdAt.toISOString(),
          startedAt: task.startedAt?.toISOString() ?? null,
          finishedAt: task.finishedAt?.toISOString() ?? null,
        };
      }),
      signal,
    });
    signal.throwIfAborted();
    return { agentSystemPrompt, result };
  },
);

const persistReasonerResult$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly session: SessionRow;
      readonly result: ReasonerResult | null;
      readonly maxSeq: number;
      readonly startedAt: Date;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    if (args.result === null) {
      await set(
        appendVoiceChatItem$,
        {
          sessionId: args.sessionId,
          role: "system_note",
          content: "Reasoner tick failed",
          realtimeItemId: null,
        },
        signal,
      );
      signal.throwIfAborted();
      await writeDb
        .update(voiceChatSessions)
        .set({
          reasoningStatus: "idle",
          lastSummaryAt: nowDate(),
          lastReasoningDurationMs: now() - args.startedAt.getTime(),
        })
        .where(eq(voiceChatSessions.id, args.sessionId));
      signal.throwIfAborted();
      return;
    }

    const updated = await writeDb
      .update(voiceChatSessions)
      .set({
        conversationSummary: args.result.conversationSummary,
        summarySeq: args.maxSeq,
        summaryVersion: args.session.summaryVersion + 1,
        lastSummaryAt: nowDate(),
        reasoningStatus: "idle",
        lastReasoningDurationMs: now() - args.startedAt.getTime(),
      })
      .where(
        and(
          eq(voiceChatSessions.id, args.sessionId),
          eq(voiceChatSessions.summaryVersion, args.session.summaryVersion),
        ),
      )
      .returning({ id: voiceChatSessions.id });
    signal.throwIfAborted();

    if (updated.length > 0) {
      await publishUserSignal(
        [args.session.userId],
        `voice-chat:${args.sessionId}`,
      );
      signal.throwIfAborted();
      return;
    }

    logReasoner.debug(
      `reasoner version contention for ${args.sessionId}, dropping tick`,
    );
    await writeDb
      .update(voiceChatSessions)
      .set({
        reasoningStatus: "idle",
        lastReasoningDurationMs: now() - args.startedAt.getTime(),
      })
      .where(eq(voiceChatSessions.id, args.sessionId));
    signal.throwIfAborted();
  },
);

const createReasonerMissingTasks$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly session: SessionRow;
      readonly result: ReasonerResult | null;
      readonly agentSystemPrompt: string;
      readonly snapshot: ReasoningSnapshot;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      args.result === null ||
      args.result.missingTasks.length === 0 ||
      !args.session.agentId
    ) {
      return;
    }

    const appendSystemPrompt = buildSlowBrainAppendSystemPrompt({
      agentSystemPrompt: args.agentSystemPrompt,
      items: args.snapshot.transcript,
      sessionTasks: args.snapshot.tasks,
    });
    const timestamp = now().toString();
    for (let i = 0; i < args.result.missingTasks.length; i++) {
      const prompt = args.result.missingTasks[i];
      if (!prompt) {
        continue;
      }
      const created = await set(
        createVoiceChatTask$,
        {
          sessionId: args.sessionId,
          userId: args.session.userId,
          orgId: args.session.orgId,
          agentId: args.session.agentId,
          callId: `reasoner-auto-${timestamp}-${i.toString()}`,
          prompt,
          appendSystemPrompt,
          apiStartTime: now(),
        },
        signal,
      );
      signal.throwIfAborted();
      if (created.status !== 200) {
        logTask.warn("reasoner auto-task creation failed", created.body);
        continue;
      }
      await set(
        appendVoiceChatItem$,
        {
          sessionId: args.sessionId,
          role: "system_note",
          content: `Reasoner auto-created task: ${prompt}`,
          realtimeItemId: null,
        },
        signal,
      );
      signal.throwIfAborted();
    }

    await publishUserSignal(
      [args.session.userId],
      `voice-chat:${args.sessionId}`,
    );
    signal.throwIfAborted();
  },
);

export const triggerVoiceChatReasoning$ = command(
  async ({ set }, sessionId: string, signal: AbortSignal): Promise<void> => {
    const acquired = await set(acquireReasoningSession$, sessionId, signal);
    if (acquired.status === "skip") {
      return;
    }

    const snapshot = await set(
      loadReasoningSnapshot$,
      { sessionId, session: acquired.session },
      signal,
    );
    if (
      snapshot.maxSeq === acquired.session.summarySeq &&
      !snapshot.hasInFlightTask
    ) {
      await set(
        compactVoiceChatTaskResults$,
        { sessionId, userId: acquired.session.userId },
        signal,
      );
      signal.throwIfAborted();
      await set(
        releaseAndDrain$,
        { sessionId, startedAt: acquired.startedAt },
        signal,
      );
      return;
    }

    const { agentSystemPrompt, result } = await set(
      callReasonerForSnapshot$,
      { session: acquired.session, snapshot },
      signal,
    );
    await set(
      persistReasonerResult$,
      {
        sessionId,
        session: acquired.session,
        result,
        maxSeq: snapshot.maxSeq,
        startedAt: acquired.startedAt,
      },
      signal,
    );
    await set(
      createReasonerMissingTasks$,
      {
        sessionId,
        session: acquired.session,
        result,
        agentSystemPrompt,
        snapshot,
      },
      signal,
    );

    await set(
      compactVoiceChatTaskResults$,
      { sessionId, userId: acquired.session.userId },
      signal,
    );
    signal.throwIfAborted();
    await set(drainPending$, sessionId, signal);
  },
);

interface CreditCheckRow extends Record<string, unknown> {
  readonly credit_enabled: boolean | null;
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

export const checkVoiceChatCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<null | ErrorResponse<402, "INSUFFICIENT_CREDITS">> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH member AS (
        SELECT credit_enabled FROM org_members_metadata
        WHERE org_id = ${args.orgId} AND user_id = ${args.userId}
        LIMIT 1
      ),
      org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credit_enabled FROM member) AS credit_enabled,
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credit_enabled === false || row.credits === null) {
      return insufficientCredits();
    }

    const credits = Number(row.credits);
    const unsettledExpired = Number(row.unsettled_expired ?? 0);
    return credits - unsettledExpired > 0 ? null : insufficientCredits();
  },
);

export const voiceChatRealtimePricingGate$ = computed(
  async (get): Promise<null | ErrorResponse<503, "NOT_CONFIGURED">> => {
    const db = get(db$);
    const rows = await db
      .select({
        provider: usagePricing.provider,
        category: usagePricing.category,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, MODEL_USAGE_KIND),
          inArray(usagePricing.provider, [
            REALTIME_PROVIDER,
            TRANSCRIPTION_PROVIDER,
          ]),
        ),
      );

    const realtime = new Set<string>();
    const transcription = new Set<string>();
    for (const row of rows) {
      const target =
        row.provider === REALTIME_PROVIDER ? realtime : transcription;
      target.add(row.category);
    }

    const missing: string[] = [];
    for (const category of REALTIME_TOKEN_CATEGORIES) {
      if (!realtime.has(category)) {
        missing.push(`${REALTIME_PROVIDER}.${category}`);
      }
    }
    for (const category of TRANSCRIPTION_TOKEN_CATEGORIES) {
      if (!transcription.has(category)) {
        missing.push(`${TRANSCRIPTION_PROVIDER}.${category}`);
      }
    }

    return missing.length === 0 ? null : pricingNotConfigured(missing);
  },
);

function voiceChatUsageProviderFor(eventType: VoiceChatUsageEventType): string {
  return eventType === "response.done"
    ? REALTIME_PROVIDER
    : TRANSCRIPTION_PROVIDER;
}

function buildVoiceChatUsageRows(
  eventType: VoiceChatUsageEventType,
  tokens: VoiceChatUsageTokens,
): VoiceChatUsageCategoryRow[] {
  if (eventType === "response.done") {
    const allowed = REALTIME_TOKEN_CATEGORIES;
    const candidates: VoiceChatUsageCategoryRow[] = [
      { category: "tokens.input.text", quantity: tokens.inputText ?? 0 },
      { category: "tokens.input.audio", quantity: tokens.inputAudio ?? 0 },
      {
        category: "tokens.input.cached_text",
        quantity: tokens.inputCachedText ?? 0,
      },
      {
        category: "tokens.input.cached_audio",
        quantity: tokens.inputCachedAudio ?? 0,
      },
      { category: "tokens.output.text", quantity: tokens.outputText ?? 0 },
      { category: "tokens.output.audio", quantity: tokens.outputAudio ?? 0 },
    ];
    return candidates.filter((row) => {
      return (
        row.quantity > 0 &&
        (allowed as readonly string[]).includes(row.category)
      );
    });
  }

  const allowed = TRANSCRIPTION_TOKEN_CATEGORIES;
  const candidates: VoiceChatUsageCategoryRow[] = [
    { category: "tokens.input.audio", quantity: tokens.inputAudio ?? 0 },
    { category: "tokens.input.text", quantity: tokens.inputText ?? 0 },
    { category: "tokens.output.text", quantity: tokens.outputText ?? 0 },
  ];
  return candidates.filter((row) => {
    return (
      row.quantity > 0 && (allowed as readonly string[]).includes(row.category)
    );
  });
}

export const createVoiceChatRealtimeSession$ = command(
  async (
    { set },
    args: {
      readonly voiceChatSessionId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const writeDb = set(writeDb$);
    const [inserted] = await writeDb
      .insert(voiceChatRealtimeSessions)
      .values({
        voiceChatSessionId: args.voiceChatSessionId,
        orgId: args.orgId,
        userId: args.userId,
        provider: REALTIME_SESSION_PROVIDER,
        model: REALTIME_PROVIDER,
        transcriptionModel: TRANSCRIPTION_PROVIDER,
        status: "active",
      })
      .returning({ id: voiceChatRealtimeSessions.id });
    signal.throwIfAborted();
    return inserted?.id ?? null;
  },
);

export const endVoiceChatRealtimeSession$ = command(
  async (
    { set },
    args: {
      readonly voiceChatSessionId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly realtimeSessionId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .select({
        id: voiceChatRealtimeSessions.id,
        orgId: voiceChatRealtimeSessions.orgId,
        userId: voiceChatRealtimeSessions.userId,
        voiceChatSessionId: voiceChatRealtimeSessions.voiceChatSessionId,
      })
      .from(voiceChatRealtimeSessions)
      .where(eq(voiceChatRealtimeSessions.id, args.realtimeSessionId))
      .limit(1);
    signal.throwIfAborted();
    if (
      !row ||
      row.voiceChatSessionId !== args.voiceChatSessionId ||
      row.orgId !== args.orgId ||
      row.userId !== args.userId
    ) {
      return false;
    }

    await writeDb
      .update(voiceChatRealtimeSessions)
      .set({ status: "ended", endedAt: nowDate() })
      .where(
        and(
          eq(voiceChatRealtimeSessions.id, args.realtimeSessionId),
          eq(voiceChatRealtimeSessions.status, "active"),
        ),
      );
    signal.throwIfAborted();
    return true;
  },
);

export const recordVoiceChatRealtimeUsage$ = command(
  async (
    { set },
    input: RecordVoiceChatRealtimeUsageInput,
    signal: AbortSignal,
  ): Promise<RecordVoiceChatRealtimeUsageResult> => {
    const writeDb = set(writeDb$);
    const provider = voiceChatUsageProviderFor(input.eventType);
    const rows = buildVoiceChatUsageRows(input.eventType, input.tokens);

    if (rows.length === 0) {
      logUsage.warn("usage event has no billable token fields; dropping", {
        voiceChatSessionId: input.voiceChatSessionId,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
      });
      return { creditsExhausted: false, rowsInserted: 0 };
    }

    await writeDb
      .insert(usageEvent)
      .values(
        rows.map((row) => {
          return {
            runId: null,
            idempotencyKey: buildVoiceChatUsageIdempotencyKey({
              voiceChatSessionId: input.voiceChatSessionId,
              providerEventId: input.providerEventId,
              category: row.category,
            }),
            orgId: input.orgId,
            userId: input.userId,
            kind: MODEL_USAGE_KIND,
            provider,
            category: row.category,
            quantity: row.quantity,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, input.orgId, signal);
    signal.throwIfAborted();

    await writeDb
      .update(voiceChatRealtimeSessions)
      .set({ lastUsageAt: nowDate() })
      .where(
        and(
          eq(
            voiceChatRealtimeSessions.voiceChatSessionId,
            input.voiceChatSessionId,
          ),
          eq(voiceChatRealtimeSessions.status, "active"),
        ),
      );
    signal.throwIfAborted();

    const credits = await set(
      checkVoiceChatCredits$,
      { orgId: input.orgId, userId: input.userId },
      signal,
    );
    signal.throwIfAborted();

    return { creditsExhausted: credits !== null, rowsInserted: rows.length };
  },
);

function createOpenAiTokenError(
  status: number,
  body: string,
): OpenAiTokenError {
  const error = new Error(`OpenAI API error: ${status}`) as Error & {
    name: typeof OPENAI_TOKEN_ERROR_TAG;
    status: number;
    body: string;
  };
  error.name = OPENAI_TOKEN_ERROR_TAG;
  error.status = status;
  error.body = body;
  return error;
}

function isOpenAiTokenError(value: unknown): value is OpenAiTokenError {
  return (
    value instanceof Error &&
    (value as { readonly name?: unknown }).name === OPENAI_TOKEN_ERROR_TAG
  );
}

function safetyIdentifierForUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

function truncateUpstreamBody(body: string): string {
  return body.length <= MAX_UPSTREAM_ERROR_BODY_LENGTH
    ? body
    : body.slice(0, MAX_UPSTREAM_ERROR_BODY_LENGTH);
}

async function requestEphemeralToken(options: {
  readonly instructions: string;
  readonly noiseReduction?: NoiseReduction;
  readonly safetyIdentifier: string;
  readonly signal: AbortSignal;
}): Promise<VoiceChatTokenResponse> {
  const headers = new Headers({
    Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
    "Content-Type": "application/json",
    "OpenAI-Safety-Identifier": options.safetyIdentifier,
  });

  const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers,
    signal: options.signal,
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: TALKER_MODEL,
        reasoning: TALKER_REASONING_CONFIG,
        output_modalities: SESSION_OUTPUT_MODALITIES,
        instructions: options.instructions,
        audio: {
          input: {
            transcription: INPUT_AUDIO_TRANSCRIPTION_CONFIG,
            noise_reduction: {
              type: options.noiseReduction ?? DEFAULT_NOISE_REDUCTION,
            },
            turn_detection: TURN_DETECTION_CONFIG,
          },
          output: { voice: TALKER_VOICE },
        },
        tools: SESSION_TOOLS,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw createOpenAiTokenError(response.status, body);
  }

  const data = (await response.json()) as OpenAiClientSecretResponse;
  return {
    client_secret: {
      value: data.value,
      expires_at: data.expires_at,
    },
  };
}

export const createVoiceChatEphemeralToken$ = command(
  async (
    _store,
    args: {
      readonly userId: string;
      readonly instructions: string;
      readonly noiseReduction?: NoiseReduction;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 200; readonly body: VoiceChatTokenResponse }
    | ErrorResponse<500, "INTERNAL_SERVER_ERROR">
  > => {
    const tokenResult = await safeAsync(() => {
      return requestEphemeralToken({
        instructions: args.instructions,
        noiseReduction: args.noiseReduction,
        safetyIdentifier: safetyIdentifierForUser(args.userId),
        signal,
      });
    });
    signal.throwIfAborted();
    if ("error" in tokenResult) {
      if (isOpenAiTokenError(tokenResult.error)) {
        logToken.error("OpenAI token request failed", {
          status: tokenResult.error.status,
          upstreamBody: truncateUpstreamBody(tokenResult.error.body),
        });
        return internalError("Failed to create ephemeral token");
      }
      throw tokenResult.error;
    }
    return { status: 200, body: tokenResult.ok };
  },
);
