import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import {
  chatMessagesContract,
  type AttachFile,
  type GenerationTemplateRequest,
} from "@vm0/api-contracts/contracts/chat-threads";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageScheduleSnapshot,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import type { z } from "zod";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { now, nowDate } from "../external/time";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerDeleted,
} from "../../lib/error";
import { env } from "../../lib/env";
import { buildArtifactKey, sanitizeArtifactFilename } from "../../lib/file-url";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import type { AuthContext } from "../../types/auth";
import { createZeroRun$ } from "../services/zero-runs-create.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  type CancelRunResult,
} from "../services/zero-run-cancel.service";
import {
  generateAndPersistChatThreadTitle,
  isChatTitleGenerationConfigured,
} from "../services/zero-chat-title.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ModelFirstPin,
  modelOnlyModelFirstPin,
  modelProviderPinAvailable,
  resolveDefaultModelFirstPin,
  resolveModelFirstProviderAdmission,
  resolveModelSelectionPin,
} from "../services/zero-model-selection.service";
import { visibleChatMessageCondition } from "../services/zero-chat-thread.service";
import { appendQueuedRunAssistantMarker } from "../services/zero-chat-queue-marker.service";
import { bestEffort } from "../utils";
import type { RouteEntry } from "../route";
import { buildGenerationTemplatePrompt } from "./generation-template-prompt";

type SendBody = z.infer<typeof chatMessagesContract.send.body>;

interface NormalSendBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly modelProvider?: string;
  readonly modelSelection?: {
    readonly modelProviderId: string;
    readonly selectedModel: string;
  } | null;
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly hasTextContent?: boolean;
  readonly attachFiles?: AttachFile[];
  readonly clientMessageId?: string;
  readonly debugNoMockClaude?: boolean;
  readonly debugNoMockCodex?: boolean;
  readonly revokesMessageId?: string;
}

interface RecallSendBody {
  readonly agentId: string;
  readonly threadId: string;
  readonly revokesMessageId: string;
  readonly clientMessageId?: string;
}

interface InterruptSendBody {
  readonly agentId: string;
  readonly threadId: string;
  readonly interruptsRunId: string;
  readonly clientMessageId?: string;
}

interface AgentForChatSend {
  readonly id: string;
  readonly orgId: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}

type ThreadModelPin = ModelFirstPin;

interface ResolvedThread {
  readonly threadId: string;
  readonly sessionId: string | undefined;
  readonly incompleteContext: string;
  readonly isNewThread: boolean;
  readonly isClientThreadRetry: boolean;
}

interface WebChatPriorRunMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachFiles: readonly string[] | null;
}

interface WebChatPriorRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly messages: readonly WebChatPriorRunMessage[];
}

interface LatestThreadSession {
  readonly sessionId: string;
  readonly selectedModel: string | null;
}

interface WebChatIncompleteRoundMessage {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly error: string | null;
  readonly attachFiles: readonly string[] | null;
}

interface WebChatIncompleteRound {
  readonly runId: string;
  readonly status: "cancelled" | "failed" | "timeout";
  readonly messages: WebChatIncompleteRoundMessage[];
}

interface IncompleteRoundRow extends WebChatIncompleteRoundMessage {
  readonly runId: string;
  readonly runStatus: "cancelled" | "failed" | "timeout";
  readonly createdAt: Date;
  readonly sequenceNumber: number | null;
}

type IncomingModelSelection = NormalSendBody["modelSelection"];
type IncomingGenerationTemplate = NormalSendBody["generationTemplate"];
type OrganizationAuthContext = AuthContext & { readonly orgId: string };

interface NormalSendArgs {
  readonly body: NormalSendBody;
  readonly auth: OrganizationAuthContext;
  readonly userId: string;
  readonly orgId: string;
  readonly apiStartTime: number;
}

interface PreparedNormalSend {
  readonly db: Db;
  readonly agent: AgentForChatSend;
  readonly thread: ResolvedThread;
  readonly priorContext: string;
  readonly generationTemplatePrompt: string;
  readonly persistedExplicitSelection: boolean;
}

type NormalSendFailure =
  | ReturnType<typeof notFound>
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof conflict>
  | ReturnType<typeof badRequestMessage>;

interface CreatedChatMessageResponse {
  readonly status: 201;
  readonly body: {
    readonly runId: string | null;
    readonly threadId: string;
    readonly status?: string;
    readonly createdAt: string;
  };
}

type ClientSendResolution =
  | CreatedChatMessageResponse
  | ReturnType<typeof conflict>;

type CreateChatThreadResult =
  | {
      readonly id: string;
      readonly clientThreadAlreadyExisted: boolean;
    }
  | ReturnType<typeof notFound>;

type AppendMessageResult =
  | {
      readonly ok: true;
      readonly createdAt: Date;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

type ClientMessageIdResolution =
  | {
      readonly kind: "available";
    }
  | {
      readonly kind: "queued";
      readonly createdAt: Date;
      readonly inserted: boolean;
    }
  | {
      readonly kind: "associated";
      readonly runId: string;
      readonly status: string;
      readonly createdAt: Date;
    }
  | {
      readonly kind: "conflict";
    };

interface ExistingClientMessageIdRow {
  readonly chatThreadId: string;
  readonly threadUserId: string;
  readonly role: string;
  readonly content: string | null;
  readonly runId: string | null;
  readonly revokesMessageId: string | null;
  readonly interruptsRunId: string | null;
  readonly error: string | null;
  readonly messageCreatedAt: Date;
  readonly runStatus: string | null;
  readonly runCreatedAt: Date | null;
}

const sendBody$ = bodyResultOf(chatMessagesContract.send);
// Existing web chat threads carry a small recent-run window in the system
// prompt. Session compatibility is decided server-side from the target model.
const RECENT_CHAT_RUN_LIMIT = 10;
const WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP = 4000;
const WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP = 4000;
const INSUFFICIENT_CREDITS_MARKER = "insufficient_credits";

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function duplicateClientMessageIdResponse() {
  return conflict("clientMessageId is already in use");
}

function resolveExistingClientMessageIdRow(
  row: ExistingClientMessageIdRow | undefined,
  params: {
    readonly threadId: string;
    readonly userId: string;
  },
): ClientMessageIdResolution {
  if (!row) {
    return { kind: "available" };
  }
  if (
    row.chatThreadId !== params.threadId ||
    row.threadUserId !== params.userId ||
    row.role !== "user" ||
    row.interruptsRunId !== null
  ) {
    return { kind: "conflict" };
  }
  if (
    row.revokesMessageId !== null &&
    row.runId === null &&
    row.content === null &&
    row.error === null
  ) {
    return { kind: "conflict" };
  }
  if (row.runId === null) {
    return {
      kind: "queued",
      createdAt: row.messageCreatedAt,
      inserted: false,
    };
  }
  if (!row.runCreatedAt || !row.runStatus) {
    return { kind: "conflict" };
  }
  return {
    kind: "associated",
    runId: row.runId,
    status: row.runStatus,
    createdAt: row.runCreatedAt,
  };
}

async function resolveClientMessageId(
  db: Db,
  params: {
    readonly clientMessageId: string;
    readonly threadId: string;
    readonly userId: string;
  },
): Promise<ClientMessageIdResolution> {
  const [message] = await db
    .select({
      chatThreadId: chatMessages.chatThreadId,
      threadUserId: chatThreads.userId,
      role: chatMessages.role,
      content: chatMessages.content,
      runId: chatMessages.runId,
      revokesMessageId: chatMessages.revokesMessageId,
      interruptsRunId: chatMessages.interruptsRunId,
      error: chatMessages.error,
      messageCreatedAt: chatMessages.createdAt,
      runStatus: agentRuns.status,
      runCreatedAt: agentRuns.createdAt,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(eq(chatMessages.id, params.clientMessageId))
    .limit(1);
  return resolveExistingClientMessageIdRow(message, params);
}

function clientMessageIdResolutionResponse(
  resolution: ClientMessageIdResolution,
  threadId: string,
):
  | CreatedChatMessageResponse
  | ReturnType<typeof duplicateClientMessageIdResponse>
  | undefined {
  if (resolution.kind === "available") {
    return undefined;
  }
  if (resolution.kind === "conflict") {
    return duplicateClientMessageIdResponse();
  }
  if (resolution.kind === "associated") {
    return {
      status: 201,
      body: {
        runId: resolution.runId,
        threadId,
        status: resolution.status,
        createdAt: resolution.createdAt.toISOString(),
      },
    };
  }
  return {
    status: 201,
    body: {
      runId: null,
      threadId,
      createdAt: resolution.createdAt.toISOString(),
    },
  };
}

function isCancelResult(value: unknown): value is CancelRunResult {
  return (
    typeof value === "object" && value !== null && "alreadyCancelled" in value
  );
}

function isRecallSendBody(body: SendBody): body is RecallSendBody {
  return (
    "revokesMessageId" in body &&
    body.revokesMessageId !== undefined &&
    !("prompt" in body && body.prompt !== undefined)
  );
}

function isInterruptSendBody(body: SendBody): body is InterruptSendBody {
  return "interruptsRunId" in body && body.interruptsRunId !== undefined;
}

function isNormalSendBody(body: SendBody): body is NormalSendBody {
  return "prompt" in body && body.prompt !== undefined;
}

function hasAgentSessionId(
  value: unknown,
): value is { readonly agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { readonly agentSessionId: unknown }).agentSessionId ===
      "string"
  );
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function chatCallbackUrl(): string {
  return new URL(
    "/api/internal/callbacks/chat",
    internalApiBaseUrl(),
  ).toString();
}

function buildWebChatPrompt(): string {
  return [
    "# Current Integration\nYou are currently running inside: Web",
    "You are communicating with the user through the web chat UI.",
  ].join("\n\n");
}

function buildWebAttachFilesPrompt(
  files: readonly {
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
  }[],
): string {
  return files
    .map((file) => {
      return `[Web file] ${file.filename} (${file.contentType})\n   [ID] ${file.id}`;
    })
    .join("\n");
}

function buildAppendSystemPrompt(
  incompleteContext: string,
  priorContext: string,
  generationTemplatePrompt: string,
): string {
  return [
    buildWebChatPrompt(),
    priorContext,
    incompleteContext,
    generationTemplatePrompt,
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function buildFullPrompt(
  prompt: string,
  attachFiles: readonly AttachFile[] | undefined,
): string {
  if (!attachFiles || attachFiles.length === 0) {
    return prompt;
  }
  return `${prompt}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;
}

function attachFileIds(
  attachFiles: readonly AttachFile[] | undefined,
): string[] | null {
  const ids = attachFiles?.map((file) => {
    return file.id;
  });
  return ids && ids.length > 0 ? ids : null;
}

function attachFileMetadata(
  userId: string,
  attachFiles: readonly AttachFile[] | undefined,
): ChatMessageAttachFileMetadata[] | null {
  const metadata = attachFiles?.map((file) => {
    const sanitized = sanitizeArtifactFilename(file.filename);
    return {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      objectKey: buildArtifactKey(userId, file.id, sanitized),
    };
  });
  return metadata && metadata.length > 0 ? metadata : null;
}

function truncatePrior(value: string): string {
  if (value.length <= WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function truncateIncomplete(value: string): string {
  if (value.length <= WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatAttachFileIds(
  ids: readonly string[] | null | undefined,
): string {
  if (!ids || ids.length === 0) {
    return "";
  }
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

function formatPriorRunMessage(message: WebChatPriorRunMessage): string {
  const roleLabel = message.role === "user" ? "User" : "Assistant";
  const attach = formatAttachFileIds(message.attachFiles);
  const body = `${roleLabel}: ${truncatePrior(message.content) || "[empty message]"}`;
  return attach ? `${body}\n${attach}` : body;
}

function buildWebChatPriorRunsContext(
  runs: readonly WebChatPriorRun[],
): string {
  if (runs.length === 0) {
    return "";
  }
  const total = runs.length;
  const blocks = runs.map((run, index) => {
    const relativeIndex = index - total + 1;
    const renderedMessages = run.messages.map(formatPriorRunMessage);
    const hasUserMessage = run.messages.some((message) => {
      return message.role === "user";
    });
    const hasAssistantMessage = run.messages.some((message) => {
      return message.role === "assistant";
    });
    if (!hasUserMessage) {
      renderedMessages.unshift(
        `User: ${truncatePrior(run.prompt) || "[empty message]"}`,
      );
    }
    if (!hasAssistantMessage) {
      renderedMessages.push("Assistant: [no stored assistant message]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_ID: ${run.runId}`,
      `- RUN_STATUS: ${run.status}`,
      `- LOG_COMMAND: zero logs ${run.runId} --all`,
      "",
      ...renderedMessages,
    ].join("\n");
  });
  return [
    "# Web Chat Run Context",
    "",
    "The runs below are from the same web chat thread. When responding:",
    "- Runs closer to RELATIVE_INDEX 0 are more recent -- prioritize them.",
    "- Match the tone of the conversation -- casual messages deserve casual replies.",
    "- Only provide technical analysis when explicitly asked a technical question.",
    "- Keep responses proportional to the message length and complexity.",
    "- Use the LOG_COMMAND for a run if you need more detailed agent log context.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function formatIncompleteMessage(
  message: WebChatIncompleteRoundMessage,
): string {
  const attach = formatAttachFileIds(message.attachFiles);
  if (message.role === "user") {
    const body =
      message.content !== null && message.content !== ""
        ? truncateIncomplete(message.content)
        : "[empty message]";
    return attach ? `User: ${body}\n${attach}` : `User: ${body}`;
  }
  if (message.content !== null && message.content !== "") {
    return `Assistant (partial): ${truncateIncomplete(message.content)}`;
  }
  return "Assistant: [no response before run ended]";
}

function buildWebChatIncompleteContext(
  rounds: readonly WebChatIncompleteRound[],
): string {
  if (rounds.length === 0) {
    return "";
  }
  const total = rounds.length;
  const blocks = rounds.map((round, index) => {
    const relativeIndex = index - total + 1;
    const rendered = round.messages.map(formatIncompleteMessage);
    const hasAssistant = round.messages.some((message) => {
      return message.role === "assistant";
    });
    if (!hasAssistant) {
      rendered.push("Assistant: [no response before run ended]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_STATUS: ${round.status}`,
      "",
      ...rendered,
    ].join("\n");
  });
  return [
    "# Incomplete Rounds Context",
    "",
    "The rounds below were sent in this thread but their runs did not complete",
    "(cancelled, failed, or timed out), so the CLI session history does not",
    "contain them. Treat them as part of the conversation you are having with",
    "the user. RELATIVE_INDEX 0 is the most recent incomplete round.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function isIncompleteRunStatus(
  value: string | null,
): value is "cancelled" | "failed" | "timeout" {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

function groupIncompleteRoundsByRunId(
  rows: readonly IncompleteRoundRow[],
): WebChatIncompleteRound[] {
  const byRunId = new Map<string, WebChatIncompleteRound>();
  const order: string[] = [];
  for (const row of rows) {
    let round = byRunId.get(row.runId);
    if (!round) {
      round = { runId: row.runId, status: row.runStatus, messages: [] };
      byRunId.set(row.runId, round);
      order.push(row.runId);
    }
    round.messages.push({
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
    });
  }
  return order.map((runId) => {
    const round = byRunId.get(runId);
    if (!round) {
      throw new Error("Incomplete round grouping lost run id");
    }
    return round;
  });
}

async function loadAgentForChatSend(
  db: Db,
  agentId: string,
): Promise<AgentForChatSend | undefined> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      orgId: zeroAgents.orgId,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return agent;
}

async function latestSessionForThread(
  db: Db,
  threadId: string,
): Promise<LatestThreadSession | undefined> {
  const rows = await db
    .select({
      result: agentRuns.result,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    // D7: only web-source runs join the thread's session-continuity chain, so a
    // chat-mode scheduled run (triggerSource "schedule") never resumes a web
    // session and a later web turn never resumes a scheduled one. The 'web'
    // filter (before .limit) is mirrored in latestSessionForThreadFromDb
    // (internal-callbacks-chat.ts) and latestSessionIdForThread
    // (chat-thread-v1-send.service.ts) — keep them in sync. This is a
    // continuity filter ONLY; it must NOT be copied into activeRunExistsForThread.
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        eq(zeroRuns.triggerSource, "web"),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return {
        sessionId: row.result.agentSessionId,
        selectedModel: row.selectedModel,
      };
    }
  }
  return undefined;
}

async function selectedModelForSessionDecision(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: IncomingModelSelection;
  readonly threadSelectedModel: string | null;
}): Promise<string | null> {
  if (params.modelSelection !== undefined) {
    return (
      params.modelSelection?.selectedModel ??
      (
        await resolveDefaultModelFirstPin(
          params.db,
          params.orgId,
          params.userId,
        )
      ).selectedModel
    );
  }
  return params.threadSelectedModel;
}

function shouldStartNewSessionForSelectedModel(params: {
  readonly latestSession: LatestThreadSession | undefined;
  readonly nextSelectedModel: string | null;
}): boolean {
  return (
    params.latestSession?.selectedModel !== undefined &&
    params.latestSession.selectedModel !== null &&
    params.nextSelectedModel !== null &&
    params.latestSession.selectedModel !== params.nextSelectedModel
  );
}

async function getLatestRunsByThreadId(
  db: Db,
  threadId: string,
  limit: number,
): Promise<WebChatPriorRun[]> {
  const runRows = await db
    .select({
      runId: zeroRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.chatThreadId, threadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);

  const orderedRuns = runRows.reverse();
  const runIds = orderedRuns.map((run) => {
    return run.runId;
  });
  if (runIds.length === 0) {
    return [];
  }

  const messageRows = await db
    .select({
      runId: chatMessages.runId,
      role: chatMessages.role,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        isNotNull(chatMessages.content),
        inArray(chatMessages.runId, runIds),
        inArray(chatMessages.role, ["user", "assistant"]),
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));

  const messagesByRunId = new Map<string, WebChatPriorRunMessage[]>();
  for (const row of messageRows) {
    if (
      row.runId === null ||
      row.content === null ||
      (row.role !== "user" && row.role !== "assistant")
    ) {
      continue;
    }
    const existing = messagesByRunId.get(row.runId) ?? [];
    existing.push({
      role: row.role,
      content: row.content,
      attachFiles: row.attachFiles,
    });
    messagesByRunId.set(row.runId, existing);
  }

  return orderedRuns.map((run) => {
    return {
      runId: run.runId,
      status: run.status,
      prompt: run.prompt,
      messages: messagesByRunId.get(run.runId) ?? [],
    };
  });
}

async function getIncompleteRoundsSinceLastSuccess(
  db: Db,
  threadId: string,
  maxRounds = 20,
): Promise<IncompleteRoundRow[]> {
  const rows = await db
    .select({
      runId: chatMessages.runId,
      role: chatMessages.role,
      content: chatMessages.content,
      error: chatMessages.error,
      attachFiles: chatMessages.attachFiles,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
      runStatus: agentRuns.status,
    })
    .from(chatMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        visibleChatMessageCondition(),
        inArray(agentRuns.status, ["cancelled", "failed", "timeout"]),
        inArray(chatMessages.role, ["user", "assistant"]),
        sql`${chatMessages.createdAt} > COALESCE(
          (
            SELECT MAX(cm2.created_at)
            FROM chat_messages cm2
            INNER JOIN agent_runs ar2 ON ar2.id = cm2.run_id
            WHERE cm2.chat_thread_id = ${threadId}
              AND NOT EXISTS (
                SELECT 1
                FROM chat_messages revoker2
                WHERE revoker2.revokes_message_id = cm2.id
              )
              AND ar2.result ? 'agentSessionId'
              AND jsonb_typeof(ar2.result->'agentSessionId') = 'string'
          ),
          '-infinity'::timestamptz
        )`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));

  const candidates: IncompleteRoundRow[] = [];
  for (const row of rows) {
    if (row.runId === null) {
      continue;
    }
    if (!isIncompleteRunStatus(row.runStatus)) {
      continue;
    }
    if (row.role !== "user" && row.role !== "assistant") {
      continue;
    }
    candidates.push({
      runId: row.runId,
      runStatus: row.runStatus,
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
      createdAt: row.createdAt,
      sequenceNumber: row.sequenceNumber,
    });
  }

  const orderedRunIds: string[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    if (!seen.has(row.runId)) {
      seen.add(row.runId);
      orderedRunIds.push(row.runId);
    }
  }
  if (orderedRunIds.length <= maxRounds) {
    return candidates;
  }

  const keep = new Set(orderedRunIds.slice(orderedRunIds.length - maxRounds));
  return candidates.filter((row) => {
    return keep.has(row.runId);
  });
}

async function activeRunExistsForThread(
  db: Db,
  threadId: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: zeroRuns.id })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    )
    .limit(1);
  return run !== undefined;
}

async function resolveClientMessageSend(params: {
  readonly db: Db;
  readonly userId: string;
  readonly threadId: string;
  readonly clientMessageId: string | undefined;
}): Promise<ClientSendResolution | undefined> {
  if (!params.clientMessageId) {
    return undefined;
  }
  const resolution = await resolveClientMessageId(params.db, {
    clientMessageId: params.clientMessageId,
    threadId: params.threadId,
    userId: params.userId,
  });
  return clientMessageIdResolutionResponse(resolution, params.threadId);
}

async function resolveClientThreadRetryRun(
  db: Db,
  threadId: string,
): Promise<CreatedChatMessageResponse | undefined> {
  const [run] = await db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(zeroRuns.chatThreadId, threadId))
    .orderBy(asc(agentRuns.createdAt))
    .limit(1);
  if (!run) {
    return undefined;
  }

  return {
    status: 201,
    body: {
      runId: run.runId,
      threadId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
    },
  };
}

async function getStoredThreadModelPin(
  db: Db,
  threadId: string,
): Promise<ThreadModelPin | null> {
  const [thread] = await db
    .select({ selectedModel: chatThreads.selectedModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread?.selectedModel) {
    return null;
  }
  return modelOnlyModelFirstPin(thread.selectedModel);
}

async function getFirstRunModelPin(
  db: Db,
  threadId: string,
): Promise<ThreadModelPin | null> {
  const [run] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(chatMessages)
    .innerJoin(zeroRuns, eq(zeroRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNotNull(chatMessages.runId),
        isNotNull(zeroRuns.selectedModel),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);
  if (!run?.selectedModel) {
    return null;
  }
  return modelOnlyModelFirstPin(run.selectedModel);
}

async function existingModelFirstThreadPin(
  db: Db,
  threadId: string,
): Promise<ThreadModelPin | null> {
  return (
    (await getStoredThreadModelPin(db, threadId)) ??
    (await getFirstRunModelPin(db, threadId))
  );
}

function emptyModelFirstThreadPin(): ThreadModelPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: null,
  };
}

async function resolveStoredModelFirstPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: ThreadModelPin;
}): Promise<
  | ThreadModelPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
> {
  if (!params.pin.selectedModel) {
    return params.pin;
  }
  if (params.pin.modelProviderId) {
    const available = await modelProviderPinAvailable({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelProviderId: params.pin.modelProviderId,
    });
    if (!available) {
      return providerDeleted();
    }
    return params.pin;
  }
  if (params.pin.modelProviderType || params.pin.modelProviderCredentialScope) {
    return params.pin;
  }
  return resolveModelSelectionPin({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: params.pin.selectedModel,
    },
  });
}

/**
 * Resolve the model pin for a chat-mode scheduled run from its linked thread:
 * the thread's stored pin, else its first-run pin, else the org default. This
 * is deliberately decoupled from session state (a scheduled run is always
 * fresh) — do NOT route schedules through `resolveRunModelPin`, which falls
 * back to the org default whenever the session is fresh.
 */
export async function resolveScheduleChatThreadModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<
  | ThreadModelPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
> {
  const existing = await existingModelFirstThreadPin(
    params.db,
    params.threadId,
  );
  if (existing) {
    return resolveStoredModelFirstPin({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      pin: existing,
    });
  }
  return resolveDefaultModelFirstPin(params.db, params.orgId, params.userId);
}

async function persistThreadPinIfUnset(
  db: Db,
  threadId: string,
  pin: ThreadModelPin,
): Promise<ThreadModelPin> {
  if (!pin.selectedModel) {
    return pin;
  }
  await db
    .update(chatThreads)
    .set({
      ...modelOnlyModelFirstPin(pin.selectedModel),
      updatedAt: nowDate(),
    })
    .where(and(eq(chatThreads.id, threadId), isNull(chatThreads.selectedModel)))
    .returning({ selectedModel: chatThreads.selectedModel });
  return pin;
}

async function persistThreadPinForExplicitSelection(
  db: Db,
  threadId: string,
  pin: ThreadModelPin,
): Promise<ThreadModelPin> {
  if (!pin.selectedModel) {
    await db
      .update(chatThreads)
      .set({
        ...modelOnlyModelFirstPin(null),
        updatedAt: nowDate(),
      })
      .where(eq(chatThreads.id, threadId));
    return pin;
  }
  await db
    .update(chatThreads)
    .set({
      ...modelOnlyModelFirstPin(pin.selectedModel),
      updatedAt: nowDate(),
    })
    .where(eq(chatThreads.id, threadId));
  return pin;
}

async function resolveRunModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly modelSelection: IncomingModelSelection;
}): Promise<
  | ThreadModelPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
> {
  const existing =
    params.modelSelection === undefined
      ? await existingModelFirstThreadPin(params.db, params.threadId)
      : null;
  if (existing) {
    const pin = await resolveStoredModelFirstPin({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      pin: existing,
    });
    if ("status" in pin) {
      return pin;
    }
    return persistThreadPinIfUnset(params.db, params.threadId, pin);
  }

  const pin = params.modelSelection
    ? await resolveModelSelectionPin({
        db: params.db,
        orgId: params.orgId,
        userId: params.userId,
        modelSelection: params.modelSelection,
      })
    : await resolveDefaultModelFirstPin(params.db, params.orgId, params.userId);
  if ("status" in pin) {
    return pin;
  }
  return params.modelSelection === undefined
    ? persistThreadPinIfUnset(params.db, params.threadId, pin)
    : persistThreadPinForExplicitSelection(params.db, params.threadId, pin);
}

async function validateModelSelection(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: IncomingModelSelection;
}): Promise<ReturnType<typeof badRequestMessage> | undefined> {
  if (params.modelSelection) {
    const pin = await resolveModelSelectionPin({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelSelection: params.modelSelection,
    });
    if ("status" in pin) {
      return pin;
    }
  }
  return undefined;
}

async function updateUserModelPreference(
  db: Db,
  orgId: string,
  userId: string,
  selectedModel: string,
): Promise<void> {
  const nowValue = nowDate();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId,
      userId,
      selectedModel,
      createdAt: nowValue,
      updatedAt: nowValue,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { selectedModel, updatedAt: nowValue },
    });
}

async function maybePersistExplicitModelFirstSelection(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: IncomingModelSelection;
}): Promise<boolean> {
  if (!params.modelSelection) {
    return false;
  }
  if (
    params.modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID
  ) {
    return false;
  }
  await updateUserModelPreference(
    params.db,
    params.orgId,
    params.userId,
    params.modelSelection.selectedModel,
  );
  return true;
}

async function createChatThread(
  db: Db,
  args: {
    readonly userId: string;
    readonly agentId: string;
    readonly clientThreadId: string | undefined;
    readonly pin: ThreadModelPin;
  },
): Promise<CreateChatThreadResult> {
  if (args.clientThreadId) {
    const [thread] = await db
      .insert(chatThreads)
      .values({
        id: args.clientThreadId,
        userId: args.userId,
        agentComposeId: args.agentId,
        title: null,
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: args.pin.selectedModel,
      })
      .onConflictDoNothing({ target: chatThreads.id })
      .returning({ id: chatThreads.id });
    if (thread) {
      return { id: thread.id, clientThreadAlreadyExisted: false };
    }

    const [existingThread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.clientThreadId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.agentComposeId, args.agentId),
        ),
      )
      .limit(1);
    if (!existingThread) {
      return notFound("Chat thread not found");
    }
    return { id: existingThread.id, clientThreadAlreadyExisted: true };
  }

  const [thread] = await db
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentComposeId: args.agentId,
      title: null,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: args.pin.selectedModel,
    })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("Failed to create chat thread");
  }
  return { id: thread.id, clientThreadAlreadyExisted: false };
}

async function resolveThread(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly existingThreadId: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly initialPin: ThreadModelPin;
  readonly modelSelection: IncomingModelSelection;
}): Promise<ResolvedThread | ReturnType<typeof notFound>> {
  if (!params.existingThreadId) {
    const thread = await createChatThread(params.db, {
      userId: params.userId,
      agentId: params.agentId,
      clientThreadId: params.clientThreadId,
      pin: params.initialPin,
    });
    if ("status" in thread) {
      return thread;
    }
    return {
      threadId: thread.id,
      sessionId: undefined,
      incompleteContext: "",
      isNewThread: !thread.clientThreadAlreadyExisted,
      isClientThreadRetry: thread.clientThreadAlreadyExisted,
    };
  }

  const [thread] = await params.db
    .select({ id: chatThreads.id, selectedModel: chatThreads.selectedModel })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, params.existingThreadId),
        eq(chatThreads.userId, params.userId),
      ),
    )
    .limit(1);
  if (!thread) {
    return notFound("Chat thread not found");
  }

  const [latestSession, incompleteRows] = await Promise.all([
    latestSessionForThread(params.db, thread.id),
    getIncompleteRoundsSinceLastSuccess(params.db, thread.id),
  ]);
  const startNewSession = shouldStartNewSessionForSelectedModel({
    latestSession,
    nextSelectedModel: await selectedModelForSessionDecision({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelSelection: params.modelSelection,
      threadSelectedModel: thread.selectedModel,
    }),
  });
  return {
    threadId: thread.id,
    sessionId: startNewSession ? undefined : latestSession?.sessionId,
    incompleteContext: startNewSession
      ? ""
      : buildWebChatIncompleteContext(
          groupIncompleteRoundsByRunId(incompleteRows),
        ),
    isNewThread: false,
    isClientThreadRetry: false,
  };
}

async function prepareRecentChatContext(
  db: Db,
  threadId: string,
  isNewThread: boolean,
  incompleteContext: string,
): Promise<string> {
  if (isNewThread) {
    return "";
  }
  if (incompleteContext.length > 0) {
    return "";
  }
  return buildWebChatPriorRunsContext(
    await getLatestRunsByThreadId(db, threadId, RECENT_CHAT_RUN_LIMIT),
  );
}

function appendUnassociatedUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly attachFiles: readonly AttachFile[] | undefined;
  readonly clientMessageId: string | undefined;
  readonly generationTemplate: IncomingGenerationTemplate;
}): Promise<ClientMessageIdResolution> {
  return params.db.transaction(async (tx) => {
    await tx
      .update(chatThreads)
      .set({ draftContent: null, draftAttachments: null })
      .where(
        and(
          eq(chatThreads.id, params.threadId),
          eq(chatThreads.userId, params.userId),
        ),
      );

    const explicitId = params.clientMessageId ?? undefined;
    const fileIds = attachFileIds(params.attachFiles);
    const fileMetadata = attachFileMetadata(params.userId, params.attachFiles);
    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(explicitId ? { id: explicitId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: params.prompt,
        runId: null,
        attachFiles: fileIds,
        attachFileMetadata: fileMetadata,
        generationTemplate: params.generationTemplate,
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ createdAt: chatMessages.createdAt });
    if (inserted) {
      return { kind: "queued", createdAt: inserted.createdAt, inserted: true };
    }
    if (!explicitId) {
      throw new Error("Failed to insert unassociated user message");
    }
    const [existing] = await tx
      .select({
        chatThreadId: chatMessages.chatThreadId,
        threadUserId: chatThreads.userId,
        role: chatMessages.role,
        content: chatMessages.content,
        runId: chatMessages.runId,
        revokesMessageId: chatMessages.revokesMessageId,
        interruptsRunId: chatMessages.interruptsRunId,
        error: chatMessages.error,
        messageCreatedAt: chatMessages.createdAt,
        runStatus: agentRuns.status,
        runCreatedAt: agentRuns.createdAt,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
      .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
      .where(eq(chatMessages.id, explicitId))
      .limit(1);
    const resolution = resolveExistingClientMessageIdRow(existing, {
      threadId: params.threadId,
      userId: params.userId,
    });
    return resolution.kind === "available" ? { kind: "conflict" } : resolution;
  });
}

async function clearThreadDraft(
  tx: Pick<Db, "update">,
  threadId: string,
  userId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ draftContent: null, draftAttachments: null })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
}

async function appendAssociatedUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly runId: string;
  readonly attachFiles: readonly AttachFile[] | undefined;
  readonly clientMessageId: string | undefined;
  readonly revokesMessageId: string | undefined;
  readonly generationTemplate: IncomingGenerationTemplate;
  readonly appendQueueMarker: boolean;
  // When false, the thread's in-progress draft is preserved. Scheduled posts
  // are not user-initiated typing, so they must not clear the user's draft.
  readonly clearDraft: boolean;
  // Set when this message is posted by a firing schedule. `scheduleSnapshot`
  // snapshots the schedule's basic display details at send time so the bubble
  // keeps its label even after an edit/delete. `scheduleTitle` is retained for
  // legacy fallback display.
  readonly scheduleId?: string;
  readonly scheduleTitle?: string;
  readonly scheduleSnapshot?: ChatMessageScheduleSnapshot;
}): Promise<void> {
  await params.db.transaction(async (tx) => {
    if (params.clearDraft) {
      await clearThreadDraft(tx, params.threadId, params.userId);
    }
    const explicitId = params.clientMessageId ?? undefined;
    const fileIds = attachFileIds(params.attachFiles);
    const fileMetadata = attachFileMetadata(params.userId, params.attachFiles);
    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(explicitId ? { id: explicitId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: params.prompt,
        runId: params.runId,
        revokesMessageId: params.revokesMessageId,
        attachFiles: fileIds,
        attachFileMetadata: fileMetadata,
        generationTemplate: params.generationTemplate,
        scheduleId: params.scheduleId,
        scheduleTitle: params.scheduleTitle,
        scheduleSnapshot: params.scheduleSnapshot,
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ createdAt: chatMessages.createdAt });
    if (params.appendQueueMarker) {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        createdAfter: inserted?.createdAt ?? nowDate(),
      });
    }
  });
}

function appendRecallUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly revokesMessageId: string;
  readonly clientMessageId: string | undefined;
}): Promise<AppendMessageResult> {
  return params.db.transaction(async (tx) => {
    const [existingRevoker] = await tx
      .select({
        role: chatMessages.role,
        runId: chatMessages.runId,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.revokesMessageId, params.revokesMessageId),
        ),
      )
      .limit(1);
    if (existingRevoker) {
      if (existingRevoker.role === "user" && existingRevoker.runId === null) {
        return { ok: true, createdAt: existingRevoker.createdAt };
      }
      return {
        ok: false,
        message: "Only queued user messages can be recalled",
      };
    }

    const [target] = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, params.revokesMessageId),
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
          isNull(chatMessages.revokesMessageId),
        ),
      )
      .limit(1);
    if (!target) {
      return {
        ok: false,
        message: "Only queued user messages can be recalled",
      };
    }

    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(params.clientMessageId ? { id: params.clientMessageId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: null,
        runId: null,
        revokesMessageId: params.revokesMessageId,
        attachFiles: null,
      })
      .onConflictDoNothing()
      .returning({ createdAt: chatMessages.createdAt });
    if (inserted) {
      return { ok: true, createdAt: inserted.createdAt };
    }
    const [resolved] = await tx
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.revokesMessageId, params.revokesMessageId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);
    if (!resolved) {
      return { ok: false, message: "Failed to insert recall user message" };
    }
    return { ok: true, createdAt: resolved.createdAt };
  });
}

async function validateNormalRevocationTarget(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly revokesMessageId: string | undefined;
}): Promise<NormalSendFailure | undefined> {
  if (!params.revokesMessageId) {
    return undefined;
  }

  const [target] = await params.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, params.revokesMessageId),
        eq(chatMessages.chatThreadId, params.threadId),
        eq(chatMessages.role, "assistant"),
        isNull(chatMessages.runLifecycleEvent),
        isNotNull(chatMessages.recommendedFollowups),
      ),
    )
    .limit(1);
  if (!target) {
    return badRequestMessage("Recommended follow-up is no longer available");
  }

  const [existingRevoker] = await params.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, params.threadId),
        eq(chatMessages.revokesMessageId, params.revokesMessageId),
      ),
    )
    .limit(1);
  if (existingRevoker) {
    return conflict("Recommended follow-up has already been used");
  }

  return undefined;
}

function appendInterruptUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly interruptsRunId: string;
  readonly clientMessageId: string | undefined;
}): Promise<AppendMessageResult> {
  return params.db.transaction(async (tx) => {
    const [existingInterrupter] = await tx
      .select({
        role: chatMessages.role,
        runId: chatMessages.runId,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.interruptsRunId, params.interruptsRunId),
        ),
      )
      .limit(1);
    if (existingInterrupter) {
      if (
        existingInterrupter.role === "user" &&
        existingInterrupter.runId === null
      ) {
        return { ok: true, createdAt: existingInterrupter.createdAt };
      }
      return {
        ok: false,
        message: "Only active chat runs can be interrupted",
      };
    }

    const [targetRun] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(
        and(
          eq(agentRuns.id, params.interruptsRunId),
          eq(zeroRuns.chatThreadId, params.threadId),
          inArray(agentRuns.status, ["queued", "pending", "running"]),
        ),
      )
      .limit(1);
    if (!targetRun) {
      return {
        ok: false,
        message: "Only active chat runs can be interrupted",
      };
    }

    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(params.clientMessageId ? { id: params.clientMessageId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: null,
        runId: null,
        interruptsRunId: params.interruptsRunId,
        attachFiles: null,
      })
      .onConflictDoNothing()
      .returning({ createdAt: chatMessages.createdAt });
    if (inserted) {
      return { ok: true, createdAt: inserted.createdAt };
    }
    const [resolved] = await tx
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatMessages.interruptsRunId, params.interruptsRunId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);
    if (!resolved) {
      return { ok: false, message: "Failed to insert interrupt user message" };
    }
    return { ok: true, createdAt: resolved.createdAt };
  });
}

async function publishChatMessageCreated(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
  await publishThreadListChanged(userId);
}

async function assertOwnedThread(
  db: Db,
  threadId: string,
  userId: string,
): Promise<ReturnType<typeof notFound> | undefined> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  return thread ? undefined : notFound("Chat thread not found");
}

const handleRecallSend$ = command(
  async (
    { set },
    args: {
      readonly body: RecallSendBody;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const ownership = await assertOwnedThread(
      db,
      args.body.threadId,
      args.userId,
    );
    signal.throwIfAborted();
    if (ownership) {
      return ownership;
    }

    const message = await appendRecallUserMessage({
      db,
      threadId: args.body.threadId,
      revokesMessageId: args.body.revokesMessageId,
      clientMessageId: args.body.clientMessageId,
    });
    signal.throwIfAborted();
    if (!message.ok) {
      return badRequestMessage(message.message);
    }

    await publishChatMessageCreated(args.userId, args.body.threadId);
    signal.throwIfAborted();
    return {
      status: 201 as const,
      body: {
        runId: null,
        threadId: args.body.threadId,
        createdAt: message.createdAt.toISOString(),
      },
    };
  },
);

const handleInterruptSend$ = command(
  async (
    { set },
    args: {
      readonly body: InterruptSendBody;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const ownership = await assertOwnedThread(
      db,
      args.body.threadId,
      args.userId,
    );
    signal.throwIfAborted();
    if (ownership) {
      return ownership;
    }

    const message = await appendInterruptUserMessage({
      db,
      threadId: args.body.threadId,
      interruptsRunId: args.body.interruptsRunId,
      clientMessageId: args.body.clientMessageId,
    });
    signal.throwIfAborted();
    if (!message.ok) {
      return badRequestMessage(message.message);
    }

    await publishChatMessageCreated(args.userId, args.body.threadId);
    signal.throwIfAborted();

    const cancelResult = await set(
      cancelRun$,
      {
        runId: args.body.interruptsRunId,
        userId: args.userId,
        orgId: args.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!isCancelResult(cancelResult)) {
      return cancelResult;
    }
    if (!cancelResult.alreadyCancelled) {
      waitUntil(
        bestEffort(set(dispatchCancelSideEffects$, cancelResult, signal)),
      );
    }

    return {
      status: 201 as const,
      body: {
        runId: null,
        threadId: args.body.threadId,
        createdAt: message.createdAt.toISOString(),
      },
    };
  },
);

const prepareNormalSend$ = command(
  async (
    { set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<PreparedNormalSend | NormalSendFailure> => {
    const db = set(writeDb$);
    const agent = await loadAgentForChatSend(db, args.body.agentId);
    signal.throwIfAborted();
    if (!agent || agent.orgId !== args.orgId) {
      return notFound("Agent not found");
    }
    if (agent.visibility === "private" && agent.owner !== args.userId) {
      return forbidden("Only the private agent owner can run this agent");
    }

    const modelError = await validateModelSelection({
      db,
      orgId: args.orgId,
      userId: args.userId,
      modelSelection: args.body.modelSelection,
    });
    signal.throwIfAborted();
    if (modelError) {
      return modelError;
    }
    const generationTemplatePrompt = buildGenerationTemplatePrompt(
      args.body.generationTemplate,
    );
    if (generationTemplatePrompt.status === "invalid") {
      return badRequestMessage(generationTemplatePrompt.message);
    }

    const thread = await resolveThread({
      db,
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.body.agentId,
      existingThreadId: args.body.threadId,
      clientThreadId: args.body.clientThreadId,
      initialPin: emptyModelFirstThreadPin(),
      modelSelection: args.body.modelSelection,
    });
    signal.throwIfAborted();
    if ("status" in thread) {
      return thread;
    }

    const priorContext = await prepareRecentChatContext(
      db,
      thread.threadId,
      thread.isNewThread,
      thread.incompleteContext,
    );
    signal.throwIfAborted();
    const persistedExplicitSelection =
      await maybePersistExplicitModelFirstSelection({
        db,
        orgId: args.orgId,
        userId: args.userId,
        modelSelection: args.body.modelSelection,
      });
    signal.throwIfAborted();

    return {
      db,
      agent,
      thread,
      priorContext,
      generationTemplatePrompt: generationTemplatePrompt.prompt,
      persistedExplicitSelection,
    };
  },
);

async function queueUnassociatedNormalMessage(params: {
  readonly prepared: PreparedNormalSend;
  readonly body: NormalSendBody;
  readonly userId: string;
}): Promise<
  | CreatedChatMessageResponse
  | ReturnType<typeof duplicateClientMessageIdResponse>
> {
  const message = await appendUnassociatedUserMessage({
    db: params.prepared.db,
    threadId: params.prepared.thread.threadId,
    userId: params.userId,
    prompt: params.body.prompt,
    attachFiles: params.body.attachFiles,
    clientMessageId: params.body.clientMessageId,
    generationTemplate: params.body.generationTemplate,
  });
  if (message.kind === "queued" && message.inserted) {
    await publishChatMessageCreated(
      params.userId,
      params.prepared.thread.threadId,
    );
  }
  const response = clientMessageIdResolutionResponse(
    message,
    params.prepared.thread.threadId,
  );
  if (!response) {
    return duplicateClientMessageIdResponse();
  }
  return response;
}

function scheduleChatTitleGeneration(params: {
  readonly db: Db;
  readonly body: NormalSendBody;
  readonly thread: ResolvedThread;
  readonly userId: string;
}): void {
  if (
    params.body.hasTextContent === false ||
    !isChatTitleGenerationConfigured()
  ) {
    return;
  }

  waitUntil(
    generateAndPersistChatThreadTitle({
      db: params.db,
      threadId: params.thread.threadId,
      userId: params.userId,
      prompt: params.body.prompt,
      includePriorRounds: !params.thread.isNewThread,
    }),
  );
}

function scheduleAssociatedUserMessage(params: {
  readonly db: Db;
  readonly body: NormalSendBody;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly appendQueueMarker: boolean;
}): void {
  waitUntil(
    (async () => {
      await appendAssociatedUserMessage({
        db: params.db,
        threadId: params.threadId,
        userId: params.userId,
        prompt: params.body.prompt,
        runId: params.runId,
        attachFiles: params.body.attachFiles,
        clientMessageId: params.body.clientMessageId,
        revokesMessageId: params.body.revokesMessageId,
        generationTemplate: params.body.generationTemplate,
        appendQueueMarker: params.appendQueueMarker,
        clearDraft: true,
      });
      await publishUserSignal(
        [params.userId],
        `chatThreadMessageCreated:${params.threadId}`,
      );
      await publishUserSignal(
        [params.userId],
        `chatThreadRunCreated:${params.threadId}`,
      );
      await publishThreadListChanged(params.userId);
    })(),
  );
}

/**
 * Post a scheduled run's prompt as a user chat message into its linked thread
 * and publish the realtime signals so the client surfaces the run. Mirrors the
 * web user-message path but (a) preserves the thread draft (the post is not
 * user-initiated typing, per the chat-mode schedule design) and (b) is awaited
 * rather than fire-and-forget, so cron/run-now sees the message persisted.
 */
export async function postScheduleUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly appendQueueMarker: boolean;
  readonly scheduleId: string;
  readonly scheduleTitle: string;
  readonly scheduleSnapshot: ChatMessageScheduleSnapshot;
}): Promise<void> {
  await appendAssociatedUserMessage({
    db: params.db,
    threadId: params.threadId,
    userId: params.userId,
    prompt: params.prompt,
    runId: params.runId,
    attachFiles: undefined,
    clientMessageId: undefined,
    revokesMessageId: undefined,
    generationTemplate: undefined,
    appendQueueMarker: params.appendQueueMarker,
    clearDraft: false,
    scheduleId: params.scheduleId,
    scheduleTitle: params.scheduleTitle,
    scheduleSnapshot: params.scheduleSnapshot,
  });
  await publishUserSignal(
    [params.userId],
    `chatThreadMessageCreated:${params.threadId}`,
  );
  await publishUserSignal(
    [params.userId],
    `chatThreadRunCreated:${params.threadId}`,
  );
  await publishThreadListChanged(params.userId);
}

function scheduleCreatedChatRunSideEffects(params: {
  readonly db: Db;
  readonly body: NormalSendBody;
  readonly thread: ResolvedThread;
  readonly userId: string;
  readonly runId: string;
  readonly runStatus: string;
}): void {
  scheduleChatTitleGeneration({
    db: params.db,
    body: params.body,
    thread: params.thread,
    userId: params.userId,
  });
  scheduleAssociatedUserMessage({
    db: params.db,
    body: params.body,
    threadId: params.thread.threadId,
    userId: params.userId,
    runId: params.runId,
    appendQueueMarker: params.runStatus === "queued",
  });
}

async function buildInsufficientCreditsAssistantMessage(params: {
  readonly db: Db;
  readonly orgId: string;
}): Promise<string> {
  const [org] = await params.db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, params.orgId))
    .limit(1);
  const appUrl = env("APP_URL").replace(/\/$/, "");
  const usageUrl = `${appUrl}/?settings=usage`;
  const billingUrl = `${appUrl}/?settings=billing`;
  if (org?.tier === "free" || org?.tier === "pro-suspend" || !org) {
    return [
      "Insufficient credits. This workspace has no spendable credits right now.",
      "",
      `Upgrade to Pro to get more credits: ${billingUrl}`,
    ].join("\n");
  }
  return [
    "Insufficient credits. This workspace has no spendable credits right now.",
    "",
    `Buy more credits or adjust auto-recharge: ${usageUrl}`,
  ].join("\n");
}

async function appendInsufficientCreditsMessages(params: {
  readonly prepared: PreparedNormalSend;
  readonly body: NormalSendBody;
  readonly userId: string;
  readonly orgId: string;
}): Promise<CreatedChatMessageResponse> {
  const assistantContent = await buildInsufficientCreditsAssistantMessage({
    db: params.prepared.db,
    orgId: params.orgId,
  });
  const userCreatedAt = nowDate();
  const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
  const result = await params.prepared.db.transaction(async (tx) => {
    await tx
      .update(chatThreads)
      .set({ draftContent: null, draftAttachments: null })
      .where(
        and(
          eq(chatThreads.id, params.prepared.thread.threadId),
          eq(chatThreads.userId, params.userId),
        ),
      );

    const explicitId = params.body.clientMessageId ?? undefined;
    const fileIds = attachFileIds(params.body.attachFiles);
    const fileMetadata = attachFileMetadata(
      params.userId,
      params.body.attachFiles,
    );
    const [userMessage] = await tx
      .insert(chatMessages)
      .values({
        ...(explicitId ? { id: explicitId } : {}),
        chatThreadId: params.prepared.thread.threadId,
        role: "user",
        content: params.body.prompt,
        runId: null,
        revokesMessageId: params.body.revokesMessageId,
        error: INSUFFICIENT_CREDITS_MARKER,
        sequenceNumber: 0,
        createdAt: userCreatedAt,
        attachFiles: fileIds,
        attachFileMetadata: fileMetadata,
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ createdAt: chatMessages.createdAt });

    const createdAt = userMessage?.createdAt ?? userCreatedAt;
    await tx.insert(chatMessages).values({
      chatThreadId: params.prepared.thread.threadId,
      role: "assistant",
      content: assistantContent,
      error: INSUFFICIENT_CREDITS_MARKER,
      sequenceNumber: 1,
      createdAt: assistantCreatedAt,
      runId: null,
    });
    return { createdAt };
  });

  await publishChatMessageCreated(
    params.userId,
    params.prepared.thread.threadId,
  );

  return {
    status: 201,
    body: {
      runId: null,
      threadId: params.prepared.thread.threadId,
      createdAt: result.createdAt.toISOString(),
    },
  };
}

const createNormalChatRun$ = command(
  async (
    { set },
    params: {
      readonly args: NormalSendArgs;
      readonly prepared: PreparedNormalSend;
    },
    signal: AbortSignal,
  ) => {
    const { args, prepared } = params;
    const modelPin = await resolveRunModelPin({
      db: prepared.db,
      orgId: args.orgId,
      userId: args.userId,
      threadId: prepared.thread.threadId,
      modelSelection: args.body.modelSelection,
    });
    signal.throwIfAborted();
    if ("status" in modelPin) {
      return modelPin;
    }

    const fullPrompt = buildFullPrompt(args.body.prompt, args.body.attachFiles);
    const requestedModelProvider =
      args.body.modelProvider && args.body.modelProvider !== "default"
        ? args.body.modelProvider
        : undefined;
    const providerAdmission = await resolveModelFirstProviderAdmission({
      db: prepared.db,
      orgId: args.orgId,
      userId: args.userId,
      modelPin,
      requestedModelProvider,
    });
    signal.throwIfAborted();
    if (providerAdmission.error) {
      return await appendInsufficientCreditsMessages({
        prepared,
        body: args.body,
        userId: args.userId,
        orgId: args.orgId,
      });
    }

    const runResult = await set(
      createZeroRun$,
      {
        auth: args.auth,
        apiStartTime: args.apiStartTime,
        chatThreadId: prepared.thread.threadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        callbacks: [
          {
            url: chatCallbackUrl(),
            secret: generateCallbackSecret(),
            payload: {
              threadId: prepared.thread.threadId,
              agentId: args.body.agentId,
            },
          },
        ],
        body: {
          prompt: fullPrompt,
          agentId: args.body.agentId,
          ...(prepared.thread.sessionId
            ? { sessionId: prepared.thread.sessionId }
            : {}),
          ...(providerAdmission.effectiveModelProvider
            ? { modelProvider: providerAdmission.effectiveModelProvider }
            : {}),
          debugNoMockClaude: args.body.debugNoMockClaude,
          debugNoMockCodex: args.body.debugNoMockCodex,
        },
        triggerSource: "web",
        appendSystemPrompt: buildAppendSystemPrompt(
          prepared.thread.incompleteContext,
          prepared.priorContext,
          prepared.generationTemplatePrompt,
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    if (runResult.status !== 201) {
      return runResult;
    }

    await prepared.db
      .update(zeroRuns)
      .set({
        modelProvider: providerAdmission.effectiveModelProvider,
        modelProviderId: modelPin.modelProviderId,
        modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
        selectedModel: modelPin.selectedModel,
      })
      .where(eq(zeroRuns.id, runResult.body.runId));
    signal.throwIfAborted();

    scheduleCreatedChatRunSideEffects({
      db: prepared.db,
      body: args.body,
      thread: prepared.thread,
      userId: args.userId,
      runId: runResult.body.runId,
      runStatus: runResult.body.status,
    });

    if (prepared.persistedExplicitSelection && modelPin.selectedModel) {
      await updateUserModelPreference(
        prepared.db,
        args.orgId,
        args.userId,
        modelPin.selectedModel,
      );
      signal.throwIfAborted();
    }

    return {
      status: 201 as const,
      body: {
        runId: runResult.body.runId,
        threadId: prepared.thread.threadId,
        status: runResult.body.status,
        createdAt: runResult.body.createdAt,
      },
    };
  },
);

export const sendNormalMessage$ = command(
  async ({ set }, args: NormalSendArgs, signal: AbortSignal) => {
    const prepared = await set(prepareNormalSend$, args, signal);
    signal.throwIfAborted();
    if ("status" in prepared) {
      return prepared;
    }

    const clientMessageResolution = await resolveClientMessageSend({
      db: prepared.db,
      userId: args.userId,
      threadId: prepared.thread.threadId,
      clientMessageId: args.body.clientMessageId,
    });
    signal.throwIfAborted();
    if (clientMessageResolution) {
      return clientMessageResolution;
    }

    const revocationError = await validateNormalRevocationTarget({
      db: prepared.db,
      threadId: prepared.thread.threadId,
      revokesMessageId: args.body.revokesMessageId,
    });
    signal.throwIfAborted();
    if (revocationError) {
      return revocationError;
    }

    if (prepared.thread.isClientThreadRetry) {
      const existingRun = await resolveClientThreadRetryRun(
        prepared.db,
        prepared.thread.threadId,
      );
      signal.throwIfAborted();
      if (existingRun) {
        return existingRun;
      }
      return badRequestMessage("Client thread id is already in use");
    }

    const hasActiveRun = await activeRunExistsForThread(
      prepared.db,
      prepared.thread.threadId,
    );
    signal.throwIfAborted();
    if (hasActiveRun) {
      if (args.body.revokesMessageId) {
        return badRequestMessage("Recommended follow-up cannot be queued");
      }
      const response = await queueUnassociatedNormalMessage({
        prepared,
        body: args.body,
        userId: args.userId,
      });
      signal.throwIfAborted();
      return response;
    }
    signal.throwIfAborted();

    return await set(createNormalChatRun$, { args, prepared }, signal);
  },
);

const sendChatMessageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(sendBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    if (isRecallSendBody(body.data)) {
      return await set(
        handleRecallSend$,
        { body: body.data, userId: auth.userId },
        signal,
      );
    }
    if (isInterruptSendBody(body.data)) {
      return await set(
        handleInterruptSend$,
        { body: body.data, userId: auth.userId, orgId: auth.orgId },
        signal,
      );
    }
    if (!isNormalSendBody(body.data)) {
      return badRequestMessage("Prompt is required");
    }

    return await set(
      sendNormalMessage$,
      {
        body: body.data,
        auth,
        userId: auth.userId,
        orgId: auth.orgId,
        apiStartTime: now(),
      },
      signal,
    );
  },
);

export const zeroChatMessagesRoutes: readonly RouteEntry[] = [
  {
    route: chatMessagesContract.send,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent-run:write",
      },
      sendChatMessageInner$,
    ),
  },
];
