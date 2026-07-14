import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import {
  chatMessagesContract,
  type AttachFile,
  type CodexServiceTier,
  type GenerationTemplateRequest,
} from "@vm0/api-contracts/contracts/chat-threads";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";
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
  insufficientCredits,
  notFound,
} from "../../lib/error";
import { env } from "../../lib/env";
import { buildArtifactKey, sanitizeArtifactFilename } from "../../lib/file-url";
import type { AuthContext } from "../../types/auth";
import {
  createZeroRun$,
  type ZeroPreCreateSource,
} from "../services/zero-runs-create.service";
import { BEFORE_DISPATCH_CANCELLED_ERROR } from "../services/agent-run-create.service";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "../services/api-dispatch-timing.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  type CancelRunResult,
} from "../services/zero-run-cancel.service";
import {
  generateAndPersistChatThreadTitle,
  isChatTitleGenerationConfigured,
} from "../services/zero-chat-title.service";
import { generateAndPersistInitialThinkingMessage } from "../services/zero-chat-initial-thinking.service";
import {
  isCodexFastServiceTierSupported,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ModelFirstPin,
  resolveModelFirstProviderAdmission,
  resolveModelSelectionPin,
} from "../services/zero-model-selection.service";
import {
  chatThreadModelPinColumns,
  resolvePersistedChatThreadModel,
} from "../services/zero-chat-thread-model.service";
import {
  touchChatThreadLastMessageAt,
  visibleChatMessageCondition,
} from "../services/zero-chat-message-shared.service";
import { loadWebChatIncompleteContext } from "../services/zero-chat-incomplete-context.service";
import { appendQueuedRunAssistantMarker } from "../services/zero-chat-queue-marker.service";
import { appendChatThreadEvent } from "../services/zero-chat-thread-event.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { bestEffort } from "../utils";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type { RouteEntry } from "../route-entry";
import { buildGenerationTemplatePrompt } from "./generation-template-prompt";
import { resolveThreadGenerationTemplatePrompt } from "./thread-generation-template";

type SendBody = z.infer<typeof chatMessagesContract.send.body>;

interface NormalSendBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly chatThreadEventId?: string;
  readonly chatThreadSortEventId?: string;
  readonly model?: string;
  readonly modelSelection?: {
    readonly modelProviderId: string;
    readonly selectedModel: string;
  } | null;
  readonly runOptions?: {
    readonly codexServiceTier?: CodexServiceTier;
  };
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly hasTextContent?: boolean;
  readonly attachFiles?: AttachFile[];
  readonly computerUseHostId?: string | null;
  readonly clientMessageId?: string;
  readonly realAgentInPreview?: boolean;
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
  readonly computerUseHostId: string | null;
  readonly isNewThread: boolean;
  readonly isClientThreadRetry: boolean;
}

interface WebChatPriorRunMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachFiles: readonly string[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
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
  readonly modelProvider: string | null;
}

type ModelFirstProviderAdmission = Awaited<
  ReturnType<typeof resolveModelFirstProviderAdmission>
>;

interface ResolvedRunConfiguration {
  readonly modelPin: ThreadModelPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly codexServiceTier: "fast" | undefined;
}

interface ResolvedThreadAndRunConfiguration {
  readonly thread: ResolvedThread;
  readonly runConfiguration: ResolvedRunConfiguration;
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
  readonly timing?: ApiDispatchTimingCollector;
  readonly zeroPreCreateSource?: ZeroPreCreateSource;
}

interface PreparedNormalSend {
  readonly db: Db;
  readonly agent: AgentForChatSend;
  readonly thread: ResolvedThread;
  readonly priorContext: string;
  readonly generationTemplatePrompt: string;
  readonly computerUseHostGrant: ResolvedComputerUseHostGrant | null;
  readonly persistedExplicitSelection: boolean;
  readonly initialThinkingEnabled: boolean;
  readonly runConfiguration: ResolvedRunConfiguration;
}

function shouldTouchThreadSortFromNormalSend(
  source: ZeroPreCreateSource | undefined,
  isNewThread: boolean,
): boolean {
  return (
    !isNewThread &&
    source !== "chat_callback_auto_send" &&
    source !== "workflow_slash_command"
  );
}

interface NormalSendFeatureSwitches {
  readonly codexFastModeEnabled: boolean;
  readonly websiteTemplatesEnabled: boolean;
}

interface ResolvedComputerUseHostGrant {
  readonly hostId: string;
  readonly displayName: string;
}

type NormalSendFailure =
  | ReturnType<typeof notFound>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof conflict>
  | ReturnType<typeof insufficientCredits>
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

function modelFirstSelection(
  selectedModel: string,
): NonNullable<NormalSendBody["modelSelection"]> {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

function normalizeNormalSendBody(body: NormalSendBody):
  | { readonly ok: true; readonly data: NormalSendBody }
  | {
      readonly ok: false;
      readonly response: ReturnType<typeof badRequestMessage>;
    } {
  if (body.model === undefined) {
    return { ok: true, data: body };
  }
  return {
    ok: true,
    data: {
      ...body,
      modelSelection: modelFirstSelection(body.model),
    },
  };
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
  computerUseHostDisplayName: string | null,
): string {
  return [
    buildWebChatPrompt(),
    priorContext,
    incompleteContext,
    generationTemplatePrompt,
    computerUseHostDisplayName
      ? buildComputerUseSystemPrompt(computerUseHostDisplayName)
      : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function buildComputerUseSystemPrompt(displayName: string): string {
  return [
    "# Computer Use",
    `Computer Use is enabled for this run on ${displayName}.`,
    "Use Zero CLI computer-use commands to inspect apps, read app state, and perform desktop actions.",
    "The computer may go offline while this run is active. If a command reports that the computer is unavailable or offline, ask the user to reconnect Zero Computer Use on that computer, then retry.",
  ].join("\n");
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
      modelProvider: zeroRuns.modelProvider,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    // D7: only web-source runs join the thread's session-continuity chain, so a
    // chat-mode automation run (triggerSource "automation") never resumes a web
    // session and a later web turn never resumes an automation one. The 'web'
    // filter (before .limit) is mirrored in latestSessionForThreadFromDb
    // (internal-chat-run-callback.service.ts) and latestSessionIdForThread
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
        modelProvider: row.modelProvider,
      };
    }
  }
  return undefined;
}

function shouldStartNewSessionForRunConfiguration(params: {
  readonly latestSession: LatestThreadSession | undefined;
  readonly nextSelectedModel: string | null;
  readonly nextModelProvider: string | null | undefined;
}): boolean {
  if (!params.latestSession) {
    return false;
  }
  return (
    params.latestSession.selectedModel !== params.nextSelectedModel ||
    (params.latestSession.modelProvider ?? null) !==
      (params.nextModelProvider ?? null)
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
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        sql`(${agentRuns.status} IS DISTINCT FROM ${"cancelled"} OR ${agentRuns.error} IS DISTINCT FROM ${BEFORE_DISPATCH_CANCELLED_ERROR})`,
      ),
    )
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
      generationTemplate: chatMessages.generationTemplate,
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
      generationTemplate: row.generationTemplate,
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

function emptyModelFirstThreadPin(): ThreadModelPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: null,
  };
}

async function resolveExplicitRunConfiguration(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: NormalSendBody;
  readonly codexFastModeEnabled: boolean;
}): Promise<ResolvedRunConfiguration | NormalSendFailure> {
  if (!params.body.modelSelection) {
    return badRequestMessage("A model selection is required");
  }
  const modelPin = await resolveModelSelectionPin({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelSelection: params.body.modelSelection,
  });
  if ("status" in modelPin) {
    return modelPin;
  }
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelPin,
    requestedModelProvider: undefined,
  });
  const codexServiceTierError = validateCodexServiceTier({
    body: params.body,
    modelPin,
    providerAdmission,
    codexFastModeEnabled: params.codexFastModeEnabled,
  });
  if (codexServiceTierError) {
    return codexServiceTierError;
  }
  return {
    modelPin,
    providerAdmission,
    codexServiceTier: codexServiceTierForRun({
      body: params.body,
      modelPin,
      providerAdmission,
      codexFastModeEnabled: params.codexFastModeEnabled,
    }),
  };
}

async function resolveNormalSendFeatureSwitches(
  db: Db,
  orgId: string,
  userId: string,
): Promise<NormalSendFeatureSwitches> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return {
    codexFastModeEnabled: isFeatureEnabled(
      FeatureSwitchKey.CodexFastMode,
      context,
    ),
    websiteTemplatesEnabled: isFeatureEnabled(
      FeatureSwitchKey.WebsiteTemplates,
      context,
    ),
  };
}

function validateGenerationTemplateFeatureSwitches(params: {
  readonly body: NormalSendBody;
  readonly featureSwitches: NormalSendFeatureSwitches;
}): NormalSendFailure | undefined {
  if (
    params.body.generationTemplate?.type === "website" &&
    !params.featureSwitches.websiteTemplatesEnabled
  ) {
    return badRequestMessage("Website templates are not enabled");
  }
  return undefined;
}

function validateGenerationTemplatePrompt(
  body: NormalSendBody,
): NormalSendFailure | undefined {
  const generationTemplate = body.generationTemplate;
  if (!generationTemplate) {
    return undefined;
  }
  const validation = buildGenerationTemplatePrompt(generationTemplate);
  if (validation.status === "invalid") {
    return badRequestMessage(validation.message);
  }
  return undefined;
}

function validateGenerationTemplateForNormalSend(params: {
  readonly body: NormalSendBody;
  readonly featureSwitches: NormalSendFeatureSwitches;
}): NormalSendFailure | undefined {
  return (
    validateGenerationTemplateFeatureSwitches(params) ??
    validateGenerationTemplatePrompt(params.body)
  );
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

function hasComputerUseHostSelection(body: NormalSendBody): boolean {
  return Object.prototype.hasOwnProperty.call(body, "computerUseHostId");
}

async function updateThreadComputerUseHost(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly hostId: string | null;
}): Promise<void> {
  await params.db
    .update(chatThreads)
    .set({ computerUseHostId: params.hostId, updatedAt: nowDate() })
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, params.userId),
      ),
    );
}

async function selectedComputerUseHostGrant(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
}): Promise<ResolvedComputerUseHostGrant | "missing"> {
  const [host] = await params.db
    .select({
      id: computerUseHosts.id,
      displayName: computerUseHosts.displayName,
    })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, params.hostId),
        eq(computerUseHosts.orgId, params.orgId),
        eq(computerUseHosts.userId, params.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  if (!host) {
    return "missing";
  }
  return {
    hostId: host.id,
    displayName: host.displayName,
  };
}

async function resolveComputerUseHostGrant(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: NormalSendBody;
  readonly thread: ResolvedThread;
}): Promise<ResolvedComputerUseHostGrant | null | NormalSendFailure> {
  const explicitSelection = hasComputerUseHostSelection(params.body);
  const requestedHostId = explicitSelection
    ? params.body.computerUseHostId
    : params.thread.computerUseHostId;

  if (!requestedHostId) {
    if (explicitSelection && params.thread.computerUseHostId !== null) {
      await updateThreadComputerUseHost({
        db: params.db,
        threadId: params.thread.threadId,
        userId: params.userId,
        hostId: null,
      });
    }
    return null;
  }

  const hostGrant = await selectedComputerUseHostGrant({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    hostId: requestedHostId,
  });
  if (hostGrant === "missing") {
    if (explicitSelection) {
      return notFound("Computer-use host not found");
    }
    await updateThreadComputerUseHost({
      db: params.db,
      threadId: params.thread.threadId,
      userId: params.userId,
      hostId: null,
    });
    return null;
  }

  if (
    explicitSelection &&
    requestedHostId !== params.thread.computerUseHostId
  ) {
    await updateThreadComputerUseHost({
      db: params.db,
      threadId: params.thread.threadId,
      userId: params.userId,
      hostId: requestedHostId,
    });
  }
  return hostGrant;
}

async function createChatThread(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly clientThreadId: string | undefined;
    readonly chatThreadEventId: string | undefined;
    readonly pin: ThreadModelPin;
    readonly codexServiceTier: CodexServiceTier | null;
  },
): Promise<CreateChatThreadResult> {
  return await db.transaction(async (tx) => {
    if (args.clientThreadId) {
      const [thread] = await tx
        .insert(chatThreads)
        .values({
          id: args.clientThreadId,
          userId: args.userId,
          agentComposeId: args.agentId,
          title: null,
          ...chatThreadModelPinColumns(args.pin),
          codexServiceTier: args.codexServiceTier,
        })
        .onConflictDoNothing({ target: chatThreads.id })
        .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
      if (thread) {
        await appendChatThreadEvent(tx, {
          kind: "created",
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: thread.id,
          agentComposeId: args.agentId,
          eventId: args.chatThreadEventId,
          title: null,
          selectedModel: args.pin.selectedModel,
          createdAt: thread.createdAt,
        });
        return { id: thread.id, clientThreadAlreadyExisted: false };
      }

      const [existingThread] = await tx
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

    const [thread] = await tx
      .insert(chatThreads)
      .values({
        userId: args.userId,
        agentComposeId: args.agentId,
        title: null,
        ...chatThreadModelPinColumns(args.pin),
        codexServiceTier: args.codexServiceTier,
      })
      .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
    if (!thread) {
      throw new Error("Failed to create chat thread");
    }
    await appendChatThreadEvent(tx, {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentComposeId: args.agentId,
      eventId: args.chatThreadEventId,
      title: null,
      selectedModel: args.pin.selectedModel,
      createdAt: thread.createdAt,
    });
    return { id: thread.id, clientThreadAlreadyExisted: false };
  });
}

function resolveInitialThreadModelPin(params: {
  readonly existingThreadId: string | undefined;
  readonly explicitRunConfiguration: ResolvedRunConfiguration | undefined;
}): Promise<ThreadModelPin | ReturnType<typeof badRequestMessage>> {
  if (params.existingThreadId) {
    return Promise.resolve(emptyModelFirstThreadPin());
  }
  if (!params.explicitRunConfiguration?.modelPin.selectedModel) {
    return Promise.resolve(badRequestMessage("A model selection is required"));
  }
  return Promise.resolve(params.explicitRunConfiguration.modelPin);
}

async function resolveThread(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly existingThreadId: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly chatThreadEventId: string | undefined;
  readonly initialPin: ThreadModelPin;
  readonly explicitRunConfiguration: ResolvedRunConfiguration | undefined;
  readonly requestedCodexServiceTier: CodexServiceTier | undefined;
  readonly persistRequestedCodexServiceTier: boolean;
  readonly codexFastModeEnabled: boolean;
}): Promise<ResolvedThreadAndRunConfiguration | NormalSendFailure> {
  if (!params.existingThreadId) {
    if (!params.explicitRunConfiguration) {
      return badRequestMessage("A model selection is required");
    }
    const thread = await createChatThread(params.db, {
      userId: params.userId,
      orgId: params.orgId,
      agentId: params.agentId,
      clientThreadId: params.clientThreadId,
      chatThreadEventId: params.chatThreadEventId,
      pin: params.initialPin,
      codexServiceTier:
        params.explicitRunConfiguration.codexServiceTier ?? null,
    });
    if ("status" in thread) {
      return thread;
    }
    return {
      thread: {
        threadId: thread.id,
        sessionId: undefined,
        incompleteContext: "",
        computerUseHostId: null,
        isNewThread: !thread.clientThreadAlreadyExisted,
        isClientThreadRetry: thread.clientThreadAlreadyExisted,
      },
      runConfiguration: params.explicitRunConfiguration,
    };
  }

  const [thread] = await params.db
    .select({
      id: chatThreads.id,
      computerUseHostId: chatThreads.computerUseHostId,
    })
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

  let runConfiguration = params.explicitRunConfiguration;
  if (!runConfiguration) {
    const persisted = await resolvePersistedChatThreadModel({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      threadId: thread.id,
      requestedCodexServiceTier: params.requestedCodexServiceTier,
      persistRequestedCodexServiceTier: params.persistRequestedCodexServiceTier,
      codexFastModeEnabled: params.codexFastModeEnabled,
    });
    if (!persisted) {
      return notFound("Chat thread not found");
    }
    if ("status" in persisted) {
      return persisted;
    }
    runConfiguration = {
      modelPin: persisted.pin,
      providerAdmission: persisted.providerAdmission,
      codexServiceTier: persisted.runCodexServiceTier,
    };
  }

  const [latestSession, incompleteContext] = await Promise.all([
    latestSessionForThread(params.db, thread.id),
    loadWebChatIncompleteContext(params.db, thread.id),
  ]);
  const startNewSession = shouldStartNewSessionForRunConfiguration({
    latestSession,
    nextSelectedModel: runConfiguration.modelPin.selectedModel,
    nextModelProvider:
      runConfiguration.providerAdmission.effectiveModelProvider,
  });
  return {
    thread: {
      threadId: thread.id,
      sessionId: startNewSession ? undefined : latestSession?.sessionId,
      incompleteContext: startNewSession ? "" : incompleteContext,
      computerUseHostId: thread.computerUseHostId,
      isNewThread: false,
      isClientThreadRetry: false,
    },
    runConfiguration,
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
  readonly chatThreadSortEventId: string | undefined;
  readonly touchThreadSort: boolean;
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
      if (params.touchThreadSort) {
        await touchChatThreadLastMessageAt(
          tx,
          params.threadId,
          inserted.createdAt,
          params.chatThreadSortEventId,
        );
      }
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
  readonly chatThreadSortEventId: string | undefined;
  readonly touchThreadSort: boolean;
  readonly revokesMessageId: string | undefined;
  readonly generationTemplate: IncomingGenerationTemplate;
  readonly appendQueueMarker: boolean;
  // When false, the thread's in-progress draft is preserved. Automation posts
  // are not user-initiated typing, so they must not clear the user's draft.
  readonly clearDraft: boolean;
}): Promise<boolean> {
  return await params.db.transaction(async (tx) => {
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
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ createdAt: chatMessages.createdAt });
    if (inserted && params.touchThreadSort) {
      await touchChatThreadLastMessageAt(
        tx,
        params.threadId,
        inserted.createdAt,
        params.chatThreadSortEventId,
      );
    }
    if (params.appendQueueMarker) {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        createdAfter: inserted?.createdAt ?? nowDate(),
      });
    }
    return inserted !== undefined;
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
        content: chatMessages.content,
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
      if (
        existingRevoker.role === "user" &&
        existingRevoker.runId === null &&
        existingRevoker.content === null
      ) {
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
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        bestEffort(
          set(dispatchCancelSideEffects$, cancelResult, backgroundSignal),
        ),
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

function loadTimedAuthorizedAgent(
  args: NormalSendArgs,
  db: Db,
  signal: AbortSignal,
): Promise<AgentForChatSend | NormalSendFailure> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_load_and_authorize_agent",
    "nested",
    async () => {
      const agent = await loadAgentForChatSend(db, args.body.agentId);
      signal.throwIfAborted();
      if (!agent || agent.orgId !== args.orgId) {
        return notFound("Agent not found");
      }
      if (agent.visibility === "private" && agent.owner !== args.userId) {
        return forbidden("Only the private agent owner can run this agent");
      }
      return agent;
    },
  );
}

function resolveTimedExplicitRunConfiguration(
  args: NormalSendArgs,
  db: Db,
  featureSwitches: NormalSendFeatureSwitches,
): ReturnType<typeof resolveExplicitRunConfiguration> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_validate_model_selection",
    "nested",
    () => {
      return resolveExplicitRunConfiguration({
        db,
        orgId: args.orgId,
        userId: args.userId,
        body: args.body,
        codexFastModeEnabled: featureSwitches.codexFastModeEnabled,
      });
    },
  );
}

function resolveTimedNormalSendFeatureSwitches(
  args: NormalSendArgs,
  db: Db,
): ReturnType<typeof resolveNormalSendFeatureSwitches> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_feature_switches",
    "nested",
    () => {
      return resolveNormalSendFeatureSwitches(db, args.orgId, args.userId);
    },
  );
}

function resolveTimedInitialThreadModelPin(
  args: NormalSendArgs,
  explicitRunConfiguration: ResolvedRunConfiguration | undefined,
): ReturnType<typeof resolveInitialThreadModelPin> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_initial_thread_model_pin",
    "nested",
    () => {
      return resolveInitialThreadModelPin({
        existingThreadId: args.body.threadId,
        explicitRunConfiguration,
      });
    },
  );
}

function resolveTimedThread(
  args: NormalSendArgs,
  db: Db,
  initialPin: ThreadModelPin,
  explicitRunConfiguration: ResolvedRunConfiguration | undefined,
  featureSwitches: NormalSendFeatureSwitches,
): ReturnType<typeof resolveThread> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_thread",
    "nested",
    () => {
      return resolveThread({
        db,
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.body.agentId,
        existingThreadId: args.body.threadId,
        clientThreadId: args.body.clientThreadId,
        chatThreadEventId: args.body.chatThreadEventId,
        initialPin,
        explicitRunConfiguration,
        requestedCodexServiceTier: args.body.runOptions?.codexServiceTier,
        persistRequestedCodexServiceTier: args.body.runOptions !== undefined,
        codexFastModeEnabled: featureSwitches.codexFastModeEnabled,
      });
    },
  );
}

function prepareTimedRecentChatContext(
  args: NormalSendArgs,
  db: Db,
  thread: ResolvedThread,
): ReturnType<typeof prepareRecentChatContext> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_prepare_recent_chat_context",
    "nested",
    () => {
      return prepareRecentChatContext(
        db,
        thread.threadId,
        thread.isNewThread,
        thread.incompleteContext,
      );
    },
  );
}

function maybePersistTimedExplicitModelFirstSelection(
  args: NormalSendArgs,
  db: Db,
): ReturnType<typeof maybePersistExplicitModelFirstSelection> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_persist_explicit_model_selection",
    "nested",
    () => {
      return maybePersistExplicitModelFirstSelection({
        db,
        orgId: args.orgId,
        userId: args.userId,
        modelSelection: args.body.modelSelection,
      });
    },
  );
}

function resolveTimedComputerUseHostGrant(
  args: NormalSendArgs,
  db: Db,
  thread: ResolvedThread,
): ReturnType<typeof resolveComputerUseHostGrant> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_computer_use_host_grant",
    "nested",
    () => {
      return resolveComputerUseHostGrant({
        db,
        orgId: args.orgId,
        userId: args.userId,
        body: args.body,
        thread,
      });
    },
  );
}

const prepareNormalSend$ = command(
  async (
    { set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<PreparedNormalSend | NormalSendFailure> => {
    const db = set(writeDb$);
    const agent = await loadTimedAuthorizedAgent(args, db, signal);
    if ("status" in agent) {
      return agent;
    }

    const featureSwitches = await resolveTimedNormalSendFeatureSwitches(
      args,
      db,
    );
    signal.throwIfAborted();
    const generationTemplateError = validateGenerationTemplateForNormalSend({
      body: args.body,
      featureSwitches,
    });
    if (generationTemplateError) {
      return generationTemplateError;
    }

    let explicitRunConfiguration: ResolvedRunConfiguration | undefined;
    if (args.body.modelSelection) {
      const resolved = await resolveTimedExplicitRunConfiguration(
        args,
        db,
        featureSwitches,
      );
      signal.throwIfAborted();
      if ("status" in resolved) {
        return resolved;
      }
      explicitRunConfiguration = resolved;
    }

    const initialPin = await resolveTimedInitialThreadModelPin(
      args,
      explicitRunConfiguration,
    );
    signal.throwIfAborted();
    if ("status" in initialPin) {
      return initialPin;
    }

    const resolvedThread = await resolveTimedThread(
      args,
      db,
      initialPin,
      explicitRunConfiguration,
      featureSwitches,
    );
    signal.throwIfAborted();
    if ("status" in resolvedThread) {
      return resolvedThread;
    }
    const { thread, runConfiguration } = resolvedThread;

    const priorContext = await prepareTimedRecentChatContext(args, db, thread);
    signal.throwIfAborted();
    const generationTemplatePrompt = resolveThreadGenerationTemplatePrompt({
      explicit: args.body.generationTemplate,
    });
    const persistedExplicitSelection =
      await maybePersistTimedExplicitModelFirstSelection(args, db);
    signal.throwIfAborted();
    const computerUseHostGrant = await resolveTimedComputerUseHostGrant(
      args,
      db,
      thread,
    );
    signal.throwIfAborted();
    if (computerUseHostGrant !== null && "status" in computerUseHostGrant) {
      return computerUseHostGrant;
    }

    return {
      db,
      agent,
      thread,
      priorContext,
      generationTemplatePrompt,
      computerUseHostGrant,
      persistedExplicitSelection,
      initialThinkingEnabled: args.zeroPreCreateSource === undefined,
      runConfiguration,
    };
  },
);

async function queueUnassociatedNormalMessage(params: {
  readonly prepared: PreparedNormalSend;
  readonly body: NormalSendBody;
  readonly userId: string;
  readonly touchThreadSort: boolean;
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
    chatThreadSortEventId: params.body.chatThreadSortEventId,
    touchThreadSort: params.touchThreadSort,
    generationTemplate: params.body.generationTemplate,
  });
  if (message.kind === "queued" && message.inserted) {
    await publishChatMessageCreated(
      params.userId,
      params.prepared.thread.threadId,
    );
    await publishThreadListChanged(params.userId);
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
  readonly orgId: string;
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
      orgId: params.orgId,
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
  readonly appendInitialThinking: boolean;
  readonly touchThreadSort: boolean;
}): void {
  waitUntil(
    (async () => {
      const inserted = await appendAssociatedUserMessage({
        db: params.db,
        threadId: params.threadId,
        userId: params.userId,
        prompt: params.body.prompt,
        runId: params.runId,
        attachFiles: params.body.attachFiles,
        clientMessageId: params.body.clientMessageId,
        chatThreadSortEventId: params.body.chatThreadSortEventId,
        touchThreadSort: params.touchThreadSort,
        revokesMessageId: params.body.revokesMessageId,
        generationTemplate: params.body.generationTemplate,
        appendQueueMarker: params.appendQueueMarker,
        clearDraft: true,
      });
      if (inserted) {
        await publishUserSignal(
          [params.userId],
          `chatThreadMessageCreated:${params.threadId}`,
        );
        await publishThreadListChanged(params.userId);
      }
      await publishUserSignal(
        [params.userId],
        `chatThreadRunCreated:${params.threadId}`,
      );
      if (params.appendInitialThinking) {
        await bestEffort(
          generateAndPersistInitialThinkingMessage({
            db: params.db,
            threadId: params.threadId,
            userId: params.userId,
            runId: params.runId,
            currentPrompt: params.body.prompt,
          }),
        );
      }
      // Direct user messages move sidebar recency; the terminal callback will
      // publish again when the run-finished marker lands.
    })(),
  );
}

function scheduleCreatedChatRunSideEffects(params: {
  readonly db: Db;
  readonly body: NormalSendBody;
  readonly thread: ResolvedThread;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly initialThinkingEnabled: boolean;
  readonly touchThreadSort: boolean;
}): void {
  scheduleChatTitleGeneration({
    db: params.db,
    body: params.body,
    thread: params.thread,
    userId: params.userId,
    orgId: params.orgId,
  });
  scheduleAssociatedUserMessage({
    db: params.db,
    body: params.body,
    threadId: params.thread.threadId,
    userId: params.userId,
    runId: params.runId,
    appendQueueMarker: params.runStatus === "queued",
    appendInitialThinking:
      params.initialThinkingEnabled &&
      params.runStatus !== "queued" &&
      params.body.hasTextContent !== false &&
      params.body.prompt.trim().length > 0,
    touchThreadSort: params.touchThreadSort,
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
  readonly touchThreadSort: boolean;
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
    if (userMessage && params.touchThreadSort) {
      await touchChatThreadLastMessageAt(
        tx,
        params.prepared.thread.threadId,
        createdAt,
        params.body.chatThreadSortEventId,
      );
    }
    await tx.insert(chatMessages).values({
      chatThreadId: params.prepared.thread.threadId,
      role: "assistant",
      content: assistantContent,
      error: INSUFFICIENT_CREDITS_MARKER,
      sequenceNumber: 1,
      createdAt: assistantCreatedAt,
      runId: null,
    });
    return { createdAt, inserted: userMessage !== undefined };
  });

  await publishChatMessageCreated(
    params.userId,
    params.prepared.thread.threadId,
  );
  if (result.inserted) {
    await publishThreadListChanged(params.userId);
  }

  return {
    status: 201,
    body: {
      runId: null,
      threadId: params.prepared.thread.threadId,
      createdAt: result.createdAt.toISOString(),
    },
  };
}

function codexFastServiceTierRequested(body: NormalSendBody): boolean {
  return body.runOptions?.codexServiceTier === "fast";
}

function validateCodexServiceTier(params: {
  readonly body: NormalSendBody;
  readonly modelPin: ThreadModelPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly codexFastModeEnabled: boolean;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (!codexFastServiceTierRequested(params.body)) {
    return undefined;
  }
  if (!params.codexFastModeEnabled) {
    return badRequestMessage(
      "Codex fast mode is not enabled for this workspace",
    );
  }
  if (
    isCodexFastServiceTierSupported({
      selectedModel: params.modelPin.selectedModel,
      effectiveModelProvider: params.providerAdmission.effectiveModelProvider,
      codexFastModeEnabled: params.codexFastModeEnabled,
    })
  ) {
    return undefined;
  }
  return badRequestMessage(
    "Codex fast mode is only available for ChatGPT (Codex) GPT 5.5 runs",
  );
}

function codexServiceTierForRun(params: {
  readonly body: NormalSendBody;
  readonly modelPin: ThreadModelPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly codexFastModeEnabled: boolean;
}): "fast" | undefined {
  return codexFastServiceTierRequested(params.body) &&
    isCodexFastServiceTierSupported({
      selectedModel: params.modelPin.selectedModel,
      effectiveModelProvider: params.providerAdmission.effectiveModelProvider,
      codexFastModeEnabled: params.codexFastModeEnabled,
    })
    ? "fast"
    : undefined;
}

function buildCreateZeroRunArgs(params: {
  readonly args: NormalSendArgs;
  readonly prepared: PreparedNormalSend;
}) {
  const { args, prepared } = params;
  const { modelPin, providerAdmission, codexServiceTier } =
    prepared.runConfiguration;
  const fullPrompt = buildFullPrompt(args.body.prompt, args.body.attachFiles);
  return {
    auth: args.auth,
    apiStartTime: args.apiStartTime,
    chatThreadId: prepared.thread.threadId,
    computerUseHostId: prepared.computerUseHostGrant?.hostId,
    modelProviderId: modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: modelPin.selectedModel ?? undefined,
    codexServiceTier,
    callbacks: [
      {
        internalKind: "chat" as const,
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
      ...(args.body.realAgentInPreview ? { realAgentInPreview: true } : {}),
    },
    triggerSource: "web" as const,
    dispatchFailedCallbacks: dispatchFailedRunCallbacks,
    appendSystemPrompt: buildAppendSystemPrompt(
      prepared.thread.incompleteContext,
      prepared.priorContext,
      prepared.generationTemplatePrompt,
      prepared.computerUseHostGrant?.displayName ?? null,
    ),
    ...(args.timing ? { timing: args.timing } : {}),
    ...(args.zeroPreCreateSource
      ? { zeroPreCreateSource: args.zeroPreCreateSource }
      : {}),
  };
}

async function buildTimedCreateZeroRunArgs(params: {
  readonly args: NormalSendArgs;
  readonly prepared: PreparedNormalSend;
}): Promise<ReturnType<typeof buildCreateZeroRunArgs>> {
  return await measureApiDispatchTiming(
    params.args.timing,
    "api_dispatch_pre_create_zero_web_chat_build_create_run_args",
    "nested",
    () => {
      return buildCreateZeroRunArgs(params);
    },
  );
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
    const createNormalRunStartedAt = now();
    const { modelPin, providerAdmission } = prepared.runConfiguration;
    if (providerAdmission.error) {
      return await appendInsufficientCreditsMessages({
        prepared,
        body: args.body,
        userId: args.userId,
        orgId: args.orgId,
        touchThreadSort: shouldTouchThreadSortFromNormalSend(
          args.zeroPreCreateSource,
          prepared.thread.isNewThread,
        ),
      });
    }

    const createRunArgs = await buildTimedCreateZeroRunArgs({
      args,
      prepared,
    });
    signal.throwIfAborted();

    if (args.timing) {
      args.timing.recordElapsed(
        "api_dispatch_pre_create_zero_web_chat_create_normal_run",
        "nested",
        createNormalRunStartedAt,
      );
    }
    const runResult = await set(createZeroRun$, createRunArgs, signal);
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
      orgId: args.orgId,
      runId: runResult.body.runId,
      runStatus: runResult.body.status,
      initialThinkingEnabled: prepared.initialThinkingEnabled,
      touchThreadSort: shouldTouchThreadSortFromNormalSend(
        args.zeroPreCreateSource,
        prepared.thread.isNewThread,
      ),
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
    const prepared = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_web_chat_prepare_normal_send",
      "nested",
      async () => {
        return await set(prepareNormalSend$, args, signal);
      },
    );
    signal.throwIfAborted();
    if ("status" in prepared) {
      return prepared;
    }

    const clientMessageResolution = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_web_chat_resolve_client_message",
      "nested",
      async () => {
        return await resolveClientMessageSend({
          db: prepared.db,
          userId: args.userId,
          threadId: prepared.thread.threadId,
          clientMessageId: args.body.clientMessageId,
        });
      },
    );
    signal.throwIfAborted();
    if (clientMessageResolution) {
      return clientMessageResolution;
    }

    const revocationError = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_web_chat_validate_revocation",
      "nested",
      async () => {
        return await validateNormalRevocationTarget({
          db: prepared.db,
          threadId: prepared.thread.threadId,
          revokesMessageId: args.body.revokesMessageId,
        });
      },
    );
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

    const hasActiveRun = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_web_chat_check_active_run",
      "nested",
      async () => {
        return await activeRunExistsForThread(
          prepared.db,
          prepared.thread.threadId,
        );
      },
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
        touchThreadSort: shouldTouchThreadSortFromNormalSend(
          args.zeroPreCreateSource,
          prepared.thread.isNewThread,
        ),
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
    const normalizedBody = normalizeNormalSendBody(body.data);
    if (!normalizedBody.ok) {
      return normalizedBody.response;
    }

    const apiStartTime = now();
    const timing = new ApiDispatchTimingCollector();
    return await set(
      sendNormalMessage$,
      {
        body: normalizedBody.data,
        auth,
        userId: auth.userId,
        orgId: auth.orgId,
        apiStartTime,
        timing,
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
