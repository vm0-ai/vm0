import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import {
  chatMessagesContract,
  type AttachFile,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
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
  or,
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
import { badRequestMessage, notFound, providerDeleted } from "../../lib/error";
import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { createZeroRun$ } from "../services/zero-runs-create.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  type CancelRunResult,
} from "../services/zero-run-cancel.service";
import { ensureOrgModelPolicies } from "../services/zero-model-policy.service";
import {
  generateAndPersistChatThreadTitle,
  isChatTitleGenerationConfigured,
} from "../services/zero-chat-title.service";
import { checkOrgCreditsForRunAdmission } from "../services/zero-run-admission.service";
import {
  touchChatThreadLastMessageAt,
  visibleChatMessageCondition,
} from "../services/zero-chat-thread.service";
import { bestEffort } from "../utils";
import type { RouteEntry } from "../route";

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
  readonly hasTextContent?: boolean;
  readonly attachFiles?: AttachFile[];
  readonly clientMessageId?: string;
  readonly forceNewSession?: boolean;
  readonly debugNoMockClaude?: boolean;
  readonly debugNoMockCodex?: boolean;
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

interface ThreadModelPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

function parseModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null || value === "org" || value === "member") {
    return value;
  }
  throw new Error(`Unknown model provider credential scope "${value}"`);
}

function modelOnlyThreadPin(selectedModel: string | null): ThreadModelPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel,
  };
}

interface ResolvedThread {
  readonly threadId: string;
  readonly sessionId: string | undefined;
  readonly incompleteContext: string;
  readonly isNewThread: boolean;
}

interface WebChatPriorMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachFiles: readonly string[] | null;
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
  readonly forceNewSession: boolean;
  readonly thread: ResolvedThread;
  readonly priorContext: string;
  readonly persistedExplicitSelection: boolean;
}

type NormalSendFailure =
  | ReturnType<typeof notFound>
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof forbidden>
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

type AppendMessageResult =
  | {
      readonly ok: true;
      readonly createdAt: Date;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

const sendBody$ = bodyResultOf(chatMessagesContract.send);
// Existing web chat threads always carry a small recent-message window in the
// system prompt. Session compatibility is handled separately by forceNewSession.
const RECENT_CHAT_MESSAGE_LIMIT = 10;
const WEB_CHAT_PRIOR_MESSAGE_CHAR_CAP = 4000;
const WEB_CHAT_INCOMPLETE_MESSAGE_CHAR_CAP = 4000;
const ORG_SENTINEL_USER_ID = "__org__";
const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function isCancelResult(value: unknown): value is CancelRunResult {
  return (
    typeof value === "object" && value !== null && "alreadyCancelled" in value
  );
}

function isRecallSendBody(body: SendBody): body is RecallSendBody {
  return "revokesMessageId" in body && body.revokesMessageId !== undefined;
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
  return new URL("/api/internal/callbacks/chat", env("VM0_API_URL")).toString();
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
): string {
  return [buildWebChatPrompt(), priorContext, incompleteContext]
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

function buildWebChatPriorMessagesContext(
  messages: readonly WebChatPriorMessage[],
): string {
  if (messages.length === 0) {
    return "";
  }
  const total = messages.length;
  const blocks = messages.map((message, index) => {
    const relativeIndex = index - total + 1;
    const roleLabel = message.role === "user" ? "User" : "Assistant";
    const attach = formatAttachFileIds(message.attachFiles);
    const lines = [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- ROLE: ${message.role}`,
      "",
      `${roleLabel}: ${truncatePrior(message.content) || "[empty message]"}`,
    ];
    if (attach) {
      lines.push(attach);
    }
    return lines.join("\n");
  });
  return [
    "# Web Chat Context",
    "",
    "The messages below are from a web chat conversation. When responding:",
    "- Messages closer to RELATIVE_INDEX 0 are more recent -- prioritize them.",
    "- Match the tone of the conversation -- casual messages deserve casual replies.",
    "- Only provide technical analysis when explicitly asked a technical question.",
    "- Keep responses proportional to the message length and complexity.",
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

async function latestSessionIdForThread(
  db: Db,
  threadId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ result: agentRuns.result })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(zeroRuns.chatThreadId, threadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return undefined;
}

async function getLatestMessagesByThreadId(
  db: Db,
  threadId: string,
  limit: number,
): Promise<WebChatPriorMessage[]> {
  const rows = await db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
    })
    .from(chatMessages)
    .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        isNotNull(chatMessages.content),
        inArray(chatMessages.role, ["user", "assistant"]),
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.sequenceNumber))
    .limit(limit);

  return rows.reverse().flatMap((row) => {
    if (
      row.content === null ||
      (row.role !== "user" && row.role !== "assistant")
    ) {
      return [];
    }
    return [
      {
        role: row.role,
        content: row.content,
        attachFiles: row.attachFiles,
      },
    ];
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

async function defaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
): Promise<ThreadModelPin> {
  const [preference] = await db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  const preferredModel = preference?.selectedModel ?? null;
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      preferredModel
        ? and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.model, preferredModel),
          )
        : and(
            eq(orgModelPolicies.orgId, orgId),
            eq(orgModelPolicies.isDefault, true),
          ),
    )
    .limit(1);

  if (!policy && preferredModel) {
    return defaultModelFirstPin(db, orgId, "__no_preference__");
  }

  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
    };
  }

  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
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
  return modelOnlyThreadPin(thread.selectedModel);
}

async function modelProviderPinAvailable(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string;
}): Promise<boolean> {
  const [provider] = await params.db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);
  return provider !== undefined;
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
  return modelOnlyThreadPin(run.selectedModel);
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

async function resolveModelSelectionPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: NonNullable<IncomingModelSelection>;
}): Promise<ThreadModelPin | ReturnType<typeof badRequestMessage>> {
  const { db, orgId, userId, modelSelection } = params;
  if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
    const available = await modelProviderPinAvailable({
      db,
      orgId,
      userId,
      modelProviderId: modelSelection.modelProviderId,
    });
    if (!available) {
      return badRequestMessage("Unknown model provider for this workspace");
    }
    return {
      modelProviderId: modelSelection.modelProviderId,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }

  await ensureOrgModelPolicies(db, orgId, userId);
  const [policy] = await db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.model, modelSelection.selectedModel),
      ),
    )
    .limit(1);
  if (!policy) {
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }
  return {
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
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
    .set({ ...modelOnlyThreadPin(pin.selectedModel), updatedAt: nowDate() })
    .where(and(eq(chatThreads.id, threadId), isNull(chatThreads.selectedModel)))
    .returning({ selectedModel: chatThreads.selectedModel });
  return pin;
}

async function resolveRunModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly modelSelection: IncomingModelSelection;
  readonly forceNewSession: boolean;
}): Promise<
  | ThreadModelPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
> {
  const existing = params.forceNewSession
    ? null
    : await existingModelFirstThreadPin(params.db, params.threadId);
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
    : await defaultModelFirstPin(params.db, params.orgId, params.userId);
  if ("status" in pin) {
    return pin;
  }
  return persistThreadPinIfUnset(params.db, params.threadId, pin);
}

async function validateModelSelection(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string | undefined;
  readonly modelSelection: IncomingModelSelection;
  readonly forceNewSession: boolean;
}): Promise<ReturnType<typeof badRequestMessage> | undefined> {
  if (
    params.modelSelection &&
    params.modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID
  ) {
    const available = await modelProviderPinAvailable({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelProviderId: params.modelSelection.modelProviderId,
    });
    if (!available) {
      return badRequestMessage("Unknown model provider for this workspace");
    }
  }

  if (
    params.forceNewSession ||
    params.threadId === undefined ||
    params.modelSelection === undefined
  ) {
    return undefined;
  }

  const existing = await existingModelFirstThreadPin(
    params.db,
    params.threadId,
  );
  if (!existing?.selectedModel) {
    return undefined;
  }
  if (
    params.modelSelection === null ||
    existing.selectedModel !== params.modelSelection.selectedModel
  ) {
    return badRequestMessage("Cannot change model on an existing thread");
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
  readonly threadId: string;
  readonly modelSelection: IncomingModelSelection;
  readonly forceNewSession: boolean;
}): Promise<boolean> {
  if (!params.modelSelection) {
    return false;
  }
  if (
    params.modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID
  ) {
    return false;
  }
  const existing = params.forceNewSession
    ? null
    : await existingModelFirstThreadPin(params.db, params.threadId);
  if (existing) {
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
): Promise<{ readonly id: string }> {
  const [thread] = await db
    .insert(chatThreads)
    .values({
      ...(args.clientThreadId ? { id: args.clientThreadId } : {}),
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
  return thread;
}

async function resolveThread(params: {
  readonly db: Db;
  readonly userId: string;
  readonly agentId: string;
  readonly existingThreadId: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly initialPin: ThreadModelPin;
  readonly forceNewSession: boolean;
}): Promise<ResolvedThread | ReturnType<typeof notFound>> {
  if (!params.existingThreadId) {
    const thread = await createChatThread(params.db, {
      userId: params.userId,
      agentId: params.agentId,
      clientThreadId: params.clientThreadId,
      pin: params.initialPin,
    });
    return {
      threadId: thread.id,
      sessionId: undefined,
      incompleteContext: "",
      isNewThread: true,
    };
  }

  const [thread] = await params.db
    .select({ id: chatThreads.id })
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

  const [sessionId, incompleteRows] = await Promise.all([
    params.forceNewSession
      ? Promise.resolve(undefined)
      : latestSessionIdForThread(params.db, thread.id),
    getIncompleteRoundsSinceLastSuccess(params.db, thread.id),
  ]);
  return {
    threadId: thread.id,
    sessionId,
    incompleteContext: params.forceNewSession
      ? ""
      : buildWebChatIncompleteContext(
          groupIncompleteRoundsByRunId(incompleteRows),
        ),
    isNewThread: false,
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
  return buildWebChatPriorMessagesContext(
    await getLatestMessagesByThreadId(db, threadId, RECENT_CHAT_MESSAGE_LIMIT),
  );
}

async function resetThreadModelPinForNewSession(
  db: Db,
  threadId: string,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
      updatedAt: nowDate(),
    })
    .where(eq(chatThreads.id, threadId));
}

async function maybeResetThreadModelPinForNewSession(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly forceNewSession: boolean;
  readonly isNewThread: boolean;
}): Promise<void> {
  if (!params.forceNewSession || params.isNewThread) {
    return;
  }
  await resetThreadModelPinForNewSession(params.db, params.threadId);
}

function appendUnassociatedUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly attachFiles: readonly AttachFile[] | undefined;
  readonly clientMessageId: string | undefined;
}): Promise<{ readonly createdAt: Date }> {
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
    const attachFileIds = params.attachFiles?.map((file) => {
      return file.id;
    });
    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        ...(explicitId ? { id: explicitId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: params.prompt,
        runId: null,
        attachFiles:
          attachFileIds && attachFileIds.length > 0 ? attachFileIds : null,
      })
      .onConflictDoNothing({ target: chatMessages.id })
      .returning({ createdAt: chatMessages.createdAt });
    if (inserted) {
      await touchChatThreadLastMessageAt(tx, params.threadId);
      return inserted;
    }
    if (!explicitId) {
      throw new Error("Failed to insert unassociated user message");
    }
    const [existing] = await tx
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
      .where(
        and(
          eq(chatMessages.id, explicitId),
          eq(chatMessages.chatThreadId, params.threadId),
          eq(chatThreads.userId, params.userId),
          eq(chatMessages.role, "user"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error("Failed to resolve unassociated user message");
    }
    return existing;
  });
}

async function appendAssociatedUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly prompt: string;
  readonly runId: string;
  readonly attachFiles: readonly AttachFile[] | undefined;
  readonly clientMessageId: string | undefined;
}): Promise<void> {
  await params.db.transaction(async (tx) => {
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
    const attachFileIds = params.attachFiles?.map((file) => {
      return file.id;
    });
    await tx
      .insert(chatMessages)
      .values({
        ...(explicitId ? { id: explicitId } : {}),
        chatThreadId: params.threadId,
        role: "user",
        content: params.prompt,
        runId: params.runId,
        attachFiles:
          attachFileIds && attachFileIds.length > 0 ? attachFileIds : null,
      })
      .onConflictDoNothing({ target: chatMessages.id });
    await touchChatThreadLastMessageAt(tx, params.threadId);
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
      await touchChatThreadLastMessageAt(tx, params.threadId);
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
      await touchChatThreadLastMessageAt(tx, params.threadId);
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

    const forceNewSession = args.body.forceNewSession === true;
    const modelError = await validateModelSelection({
      db,
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.body.threadId,
      modelSelection: args.body.modelSelection,
      forceNewSession,
    });
    signal.throwIfAborted();
    if (modelError) {
      return modelError;
    }

    const thread = await resolveThread({
      db,
      userId: args.userId,
      agentId: args.body.agentId,
      existingThreadId: args.body.threadId,
      clientThreadId: args.body.clientThreadId,
      initialPin: emptyModelFirstThreadPin(),
      forceNewSession,
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
    await maybeResetThreadModelPinForNewSession({
      db,
      threadId: thread.threadId,
      forceNewSession,
      isNewThread: thread.isNewThread,
    });
    signal.throwIfAborted();

    const persistedExplicitSelection =
      await maybePersistExplicitModelFirstSelection({
        db,
        orgId: args.orgId,
        userId: args.userId,
        threadId: thread.threadId,
        modelSelection: args.body.modelSelection,
        forceNewSession,
      });
    signal.throwIfAborted();

    return {
      db,
      agent,
      forceNewSession,
      thread,
      priorContext,
      persistedExplicitSelection,
    };
  },
);

async function queueUnassociatedNormalMessage(params: {
  readonly prepared: PreparedNormalSend;
  readonly body: NormalSendBody;
  readonly userId: string;
}): Promise<CreatedChatMessageResponse> {
  const message = await appendUnassociatedUserMessage({
    db: params.prepared.db,
    threadId: params.prepared.thread.threadId,
    userId: params.userId,
    prompt: params.body.prompt,
    attachFiles: params.body.attachFiles,
    clientMessageId: params.body.clientMessageId,
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
      createdAt: message.createdAt.toISOString(),
    },
  };
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

async function resolveEffectiveModelProviderType(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ThreadModelPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<string | null | undefined> {
  if (params.modelPin.modelProviderType) {
    return params.modelPin.modelProviderType;
  }
  if (!params.modelPin.modelProviderId) {
    return params.requestedModelProvider;
  }

  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelPin.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);

  return provider?.type ?? params.requestedModelProvider;
}

async function resolveProviderAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ThreadModelPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<{
  readonly effectiveModelProvider: string | null | undefined;
  readonly error: Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const error = await checkOrgCreditsForRunAdmission({
    db: params.db,
    orgId: params.orgId,
    modelProviderType: effectiveModelProvider,
  });
  return { effectiveModelProvider, error };
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
      forceNewSession: prepared.forceNewSession,
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
    const providerAdmission = await resolveProviderAdmission({
      db: prepared.db,
      orgId: args.orgId,
      userId: args.userId,
      modelPin,
      requestedModelProvider,
    });
    signal.throwIfAborted();
    if (providerAdmission.error) {
      return providerAdmission.error;
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

    scheduleChatTitleGeneration({
      db: prepared.db,
      body: args.body,
      thread: prepared.thread,
      userId: args.userId,
    });
    scheduleAssociatedUserMessage({
      db: prepared.db,
      body: args.body,
      threadId: prepared.thread.threadId,
      userId: args.userId,
      runId: runResult.body.runId,
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

const sendNormalMessage$ = command(
  async ({ set }, args: NormalSendArgs, signal: AbortSignal) => {
    const prepared = await set(prepareNormalSend$, args, signal);
    signal.throwIfAborted();
    if ("status" in prepared) {
      return prepared;
    }

    if (await activeRunExistsForThread(prepared.db, prepared.thread.threadId)) {
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
