import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@vm0/core";
import { replayChatThreadEvents } from "@vm0/core/chat-thread-event-replay";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  chatMessagesContract,
  type AttachFile,
  type ChatRunOptionsRequest,
  type ChatThreadEvent,
  type GenerationTemplateRequest,
  type PagedChatMessage,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import {
  getModelProviderFirewall,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  clearThreadSessionBinding,
  clearThreadSessionConversation,
  deleteVm0ManagedDefaultModelKey,
  readThreadSessionBinding,
  seedVm0ManagedModelKey as seedVm0ManagedModelKeyState,
} from "./helpers/runtime-state";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { overwriteModelProviderSecretForTests } from "./helpers/zero-model-provider-state";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  deleteBddVm0ApiKeys,
  hasVm0ApiKeyLabel,
  holdChatMessageFixture,
  holdChatMessageQueueItemFixture,
  holdOrgAdmissionLockFixture,
  replaceBddVm0ApiKeys,
} from "../../../test-fixtures/chat-messages";

/**
 * CHAT-02 / RUN-01 / CHAIN-CHAT: the web chat send route end to end.
 *
 * Every Given is constructed through public APIs (Stripe-webhook entitlement,
 * org model provider/policy routes, runner heartbeat/claim, sandbox report
 * webhooks, feature-switch and computer-use host routes) and every Then is a
 * response body, messages page, thread/run read, queue read, claim payload,
 * or captured chat-callback delivery — no database fixtures or row asserts.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const cu = createComputerUseBddApi(context);
const misc = createMiscRoutesApi(context);
const routeMocks = createZeroRouteMocks(context);
const CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET = "zero web upload-file -f <path>";
const API_DISPATCH_ZERO_WEB_CHAT_PRE_CREATE_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_load_and_authorize_agent",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_validate_model_selection",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_feature_switches",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_validate_codex_service_tier",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_initial_thread_model_pin",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_thread",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_prepare_recent_chat_context",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_persist_explicit_model_selection",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_persist_explicit_codex_service_tier",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_computer_use_host_grant",
  "api_dispatch_pre_create_zero_web_chat_resolve_client_message",
  "api_dispatch_pre_create_zero_web_chat_validate_revocation",
  "api_dispatch_pre_create_zero_web_chat_queue_first_enqueue",
  "api_dispatch_pre_create_zero_web_chat_queue_first_check_dispatchable",
  "api_dispatch_pre_create_zero_web_chat_create_normal_run",
  "api_dispatch_pre_create_zero_web_chat_resolve_model_pin",
  "api_dispatch_pre_create_zero_web_chat_resolve_provider_admission",
  "api_dispatch_pre_create_zero_web_chat_build_create_run_args",
] as const;
const API_DISPATCH_ZERO_INTERNAL_ENTRYPOINT_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_entrypoint_gap",
] as const;
const FORBIDDEN_API_DISPATCH_TIMING_KEYS = [
  "org_id",
  "user_id",
  "connector",
  "connector_name",
  "agent_id",
  "prompt",
  "vars",
  "secrets",
  "secret_names",
  "environment",
  "execution_context",
  "presigned_url",
  "presignedUrl",
  "archive_url",
  "archiveUrl",
  "manifest_url",
  "manifestUrl",
  "url",
  "storage_name",
  "storageName",
  "artifact_name",
  "artifactName",
  "volume_name",
  "volumeName",
  "mount_path",
  "mountPath",
  "runner_id",
  "runnerId",
  "cli_agent_session_id",
  "cliAgentSessionId",
  "sandbox_token",
  "sandboxToken",
  "api_key",
  "apiKey",
] as const;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.bdd-signature`;
}

function codexAuthJson(): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: accessExp }),
      refresh_token: "rt_bdd_chat_fast_mode",
      account_id: "ws_acct_bdd_fast_mode",
      id_token: unsignedJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_bdd_fast_mode_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "BDD Chat Fast Mode" },
        },
        exp: accessExp,
      }),
    },
  });
}

type AssistantMessage = Extract<PagedChatMessage, { role: "assistant" }>;
type UserMessage = Extract<PagedChatMessage, { role: "user" }>;
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

interface ChatRunSendBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly structuredPrompt?: UserMessageDocument;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly clientMessageId?: string;
  readonly model?: string;
  readonly runOptions?: ChatRunOptionsRequest;
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly attachFiles?: readonly AttachFile[];
  readonly computerUseHostId?: string | null;
  readonly revokesMessageId?: string;
}

const openRouterBodySchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

async function entitledChatActor(): Promise<EntitledChatActor> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat messages agent",
    description: "Exercises the web chat send route.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId };
}

async function seedVm0ManagedModelKey(selectedModel: string): Promise<string> {
  onTestFinished(async () => {
    await deleteVm0ManagedDefaultModelKey(context);
  });
  return await seedVm0ManagedModelKeyState(context, selectedModel);
}

async function sendChatRun(
  actor: ApiTestUser,
  body: ChatRunSendBody,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const requestBody = {
    ...body,
    clientMessageId: body.clientMessageId ?? randomUUID(),
  };
  const sent = await chat.requestSendMessage(actor, requestBody, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  let runId: string | null | undefined = sent.body.runId;
  if (runId === null) {
    // A terminal callback may claim the queued row between enqueue and the
    // inline dispatch decision. Recover as a refreshed client does: read the
    // appended replacement instead of retrying the client message id.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === requestBody.clientMessageId &&
            message.runId !== undefined
          );
        });
      },
    );
    runId = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === requestBody.clientMessageId;
    })?.runId;
  }
  if (runId === undefined || runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId, threadId: sent.body.threadId };
}

async function expectThreadCreatedModelEvent(
  actor: ApiTestUser,
  threadId: string,
  selectedModel: string,
): Promise<void> {
  const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
  expect(threadEvents.status).toBe(200);
  if (threadEvents.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  expect(threadEvents.body.events).toContainEqual(
    expect.objectContaining({
      kind: "created",
      chatThreadId: threadId,
      selectedModel,
    }),
  );
}

async function expectNoThreadModelUpdateEvent(
  actor: ApiTestUser,
  threadId: string,
  selectedModel: string,
): Promise<void> {
  const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
  expect(threadEvents.status).toBe(200);
  if (threadEvents.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  expect(threadEvents.body.events).not.toContainEqual(
    expect.objectContaining({
      kind: "model_selection_updated",
      chatThreadId: threadId,
      selectedModel,
    }),
  );
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  return {
    claim,
    sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
  };
}

function claimEnvironment(claim: RunnerClaim): Record<string, string> {
  if (!claim.environment) {
    throw new Error("Expected the runner claim to carry an environment");
  }
  return claim.environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationEvents(): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter(isRecord);
  });
}

function sandboxOperationEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEvents().filter((event) => {
    return event.run_id === runId;
  });
}

function firstAssistantMessageEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEventsForRun(runId).filter((event) => {
    return event.op_type === "api_to_first_assistant_message";
  });
}

function firstAssistantMessageEligibilityEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEventsForRun(runId).filter((event) => {
    return event.op_type === "first_assistant_message_eligible";
  });
}

function apiDispatchTimingEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEventsForRun(runId).filter((event) => {
    return (
      typeof event.op_type === "string" &&
      event.op_type.startsWith("api_dispatch_")
    );
  });
}

function apiDispatchActionTypes(
  events: readonly Record<string, unknown>[],
): Set<unknown> {
  return new Set(
    events.map((event) => {
      return event.op_type;
    }),
  );
}

function expectApiDispatchActions(
  events: readonly Record<string, unknown>[],
  expectedActionTypes: readonly string[],
): void {
  const observedActionTypes = apiDispatchActionTypes(events);
  for (const actionType of expectedActionTypes) {
    expect(observedActionTypes).toContain(actionType);
  }
}

function expectNoApiDispatchActions(
  events: readonly Record<string, unknown>[],
  unexpectedActionTypes: readonly string[],
): void {
  const observedActionTypes = apiDispatchActionTypes(events);
  for (const actionType of unexpectedActionTypes) {
    expect(observedActionTypes).not.toContain(actionType);
  }
}

function expectApiDispatchSpanKind(
  events: readonly Record<string, unknown>[],
  expectedActionTypes: readonly string[],
  spanKind: string,
): void {
  for (const actionType of expectedActionTypes) {
    const matchingEvents = events.filter((event) => {
      return event.op_type === actionType;
    });
    expect(matchingEvents).toHaveLength(1);
    expect(matchingEvents[0]).toStrictEqual(
      expect.objectContaining({
        span_kind: spanKind,
      }),
    );
  }
}

function expectApiDispatchTimingEventsNotToLeak(
  events: readonly Record<string, unknown>[],
  forbiddenValues: readonly string[],
): void {
  for (const event of events) {
    for (const forbiddenKey of FORBIDDEN_API_DISPATCH_TIMING_KEYS) {
      expect(event).not.toHaveProperty(forbiddenKey);
    }
    const serialized = JSON.stringify(event);
    for (const forbiddenValue of forbiddenValues) {
      expect(serialized).not.toContain(forbiddenValue);
    }
  }
}

/** Sandbox-scoped zero token issued to the run, exposed via the claim env. */
function zeroTokenFromClaim(claim: RunnerClaim): string {
  const token = claimEnvironment(claim).ZERO_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error("Expected the claim environment to carry a ZERO_TOKEN");
  }
  return token;
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly PagedChatMessage[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadMessages>> | undefined;
  await expect
    .poll(async () => {
      page = await chat.listThreadMessages(actor, threadId);
      return predicate(page.messages);
    })
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} messages to be readable`);
  }
  return page;
}

async function waitForRunUserMessage(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
  content: string,
): Promise<void> {
  await waitForThreadMessages(actor, threadId, (items) => {
    return userMessages(items).some((message) => {
      return message.runId === runId && message.content === content;
    });
  });
}

async function waitForRunStatus(
  actor: ApiTestUser,
  runId: string,
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
): Promise<void> {
  await expect
    .poll(async () => {
      const run = await api.readRun(actor, runId);
      return run.status;
    })
    .toBe(status);
}

async function waitForThreadTitle(
  actor: ApiTestUser,
  threadId: string,
  title: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return await readThreadTitleFromEvents(actor, threadId);
    })
    .toBe(title);
}

async function readThreadTitleFromEvents(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  const events = await chat.requestThreadEvents(actor, {}, [200]);
  if (events.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }

  let latestTitleEvent:
    | { readonly title: string | null; readonly createdAt: string }
    | undefined;
  for (const event of events.body.events) {
    if (
      event.chatThreadId !== threadId ||
      (event.kind !== "created" && event.kind !== "renamed")
    ) {
      continue;
    }
    if (
      latestTitleEvent === undefined ||
      Date.parse(event.createdAt) >= Date.parse(latestTitleEvent.createdAt)
    ) {
      latestTitleEvent = event;
    }
  }

  return latestTitleEvent?.title ?? null;
}

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: {
    readonly cliAgentType?: "claude-code" | "codex";
    readonly lastEventSequence?: number;
  } = {},
): Promise<void> {
  const history = `bdd chat session history ${runId}`;
  const historyHash = createHash("sha256").update(history).digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: options.cliAgentType ?? "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      ...(options.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: options.lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function failChatRun(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  error: string,
): Promise<void> {
  await webhooks.requestAgentComplete(
    { runId, exitCode: 1, error },
    sandboxHeaders,
    [200],
  );
}

async function cancelChatRun(actor: ApiTestUser, runId: string): Promise<void> {
  await api.requestCancelRun(actor, runId, [200]);
  await waitForRunStatus(actor, runId, "cancelled");
}

function assistantMessages(
  messages: readonly PagedChatMessage[],
): AssistantMessage[] {
  return messages.flatMap((message) => {
    return message.role === "assistant" ? [message] : [];
  });
}

function userMessages(messages: readonly PagedChatMessage[]): UserMessage[] {
  return messages.flatMap((message) => {
    return message.role === "user" ? [message] : [];
  });
}

function eventBackedContents(
  messages: readonly PagedChatMessage[],
  runId: string,
): AssistantMessage[] {
  return assistantMessages(messages).filter((message) => {
    return (
      message.runId === runId &&
      message.content !== null &&
      message.runLifecycleEvent === undefined
    );
  });
}

function recommendedFollowupMessages(
  messages: readonly PagedChatMessage[],
  runId: string,
): AssistantMessage[] {
  return assistantMessages(messages).filter((message) => {
    return (
      message.runId === runId &&
      message.runLifecycleEvent === undefined &&
      (message.recommendedFollowups?.length ?? 0) > 0
    );
  });
}

function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

function modelProviderSecretPlaceholder(
  type: ModelProviderType,
  secretName: string,
): string {
  const placeholder =
    getModelProviderFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing model provider placeholder for ${secretName}`);
  }
  return placeholder;
}

function modelProvidersClient() {
  return setupApp({ context })(zeroModelProvidersMainContract);
}

function chatMessagesClient() {
  return setupApp({ context })(chatMessagesContract);
}

function sessionHeaders(actor: ApiTestUser): {
  readonly authorization: string;
} {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

/** Org-admin model provider upsert through the public route. */
async function upsertOrgModelProvider(
  actor: ApiTestUser,
  body: {
    readonly type:
      | "anthropic-api-key"
      | "deepseek-api-key"
      | "openai-api-key"
      | "openrouter-api-key"
      | "vm0";
    readonly secret?: string;
  },
): Promise<{ readonly providerId: string; readonly created: boolean }> {
  const response = await accept(
    modelProvidersClient().upsert({
      headers: sessionHeaders(actor),
      body,
    }),
    [200, 201],
  );
  return {
    providerId: response.body.provider.id,
    created: response.body.created,
  };
}

async function readThreadComputerUseHostId(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  return (await readThreadProjection(actor, threadId)).computerUseHostId;
}

async function readThreadProjection(actor: ApiTestUser, threadId: string) {
  const snapshot = await chat.getThreadSnapshot(actor);
  const events: ChatThreadEvent[] = [];
  let cursor = snapshot.latestEventId;

  for (let page = 0; page < 20; page++) {
    const response = await chat.requestThreadEvents(
      actor,
      cursor ? { sinceEventId: cursor } : {},
      [200],
    );
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }

    events.push(...response.body.events);
    if (!response.body.hasMore) {
      break;
    }

    const lastEvent = response.body.events.at(-1);
    if (!lastEvent) {
      throw new Error("Expected paginated chat thread events");
    }
    cursor = lastEvent.id;
  }

  const thread = replayChatThreadEvents(snapshot.chatThreads, events).find(
    (candidate) => {
      return candidate.id === threadId;
    },
  );
  if (!thread) {
    throw new Error("Expected chat thread event projection");
  }
  return thread;
}

/**
 * Raw chat send through the Hono app, for statuses the typed contract does
 * not model (precedent: requestListAutomationsRaw in api-bdd-runs).
 */
async function requestSendMessageRaw(
  actor: ApiTestUser,
  body: ChatRunSendBody,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers = sessionHeaders(actor);
  const app = createApp({ signal: context.signal });
  const response = await app.request("/api/zero/chat/messages", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  return { status: response.status, body: responseBody };
}

/** Chat send authenticated by a run-scoped sandbox bearer token. */
async function requestSendMessageWithBearer(
  token: string,
  body: { readonly agentId: string; readonly prompt: string },
  statuses: readonly (201 | 401 | 403)[],
) {
  return await accept(
    chatMessagesClient().send({
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    statuses,
  );
}

describe("CHAT-02: web chat send and client ids", () => {
  it("creates a web chat run with client-provided ids", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const clientThreadId = randomUUID();
    const clientMessageId = randomUUID();
    const prompt = "hello from bdd web chat";
    const first = await chat.requestSendMessage(
      actor,
      { agentId, prompt, clientThreadId, clientMessageId },
      [201],
    );
    if (first.status !== 201 || first.body.runId === null) {
      throw new Error("Expected the first chat send to create a run");
    }
    expect(first.body.threadId).toBe(clientThreadId);
    expect(first.body.status).toBe("pending");
    const runId = first.body.runId;
    const pendingBinding = await readThreadSessionBinding(
      context,
      clientThreadId,
    );
    expect(pendingBinding.agent_session_run_id).toBe(runId);
    expect(pendingBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(pendingBinding.run_session_id).toBe(pendingBinding.agent_session_id);
    expect(sandboxOperationEventsForRun(runId)).toContainEqual({
      _time: expect.any(String),
      source: "api",
      op_type: "chat_thread_session_binding_persisted",
      sandbox_type: "chat",
      duration_ms: 0,
      success: true,
      run_id: runId,
      chat_thread_id: clientThreadId,
      agent_session_id: pendingBinding.agent_session_id,
      agent_session_run_id: runId,
      binding_action: "initialized",
      run_status: "pending",
    });

    const timingEvents = apiDispatchTimingEventsForRun(runId);
    expectApiDispatchActions(
      timingEvents,
      API_DISPATCH_ZERO_WEB_CHAT_PRE_CREATE_ACTION_TYPES,
    );
    expectApiDispatchSpanKind(
      timingEvents,
      API_DISPATCH_ZERO_WEB_CHAT_PRE_CREATE_ACTION_TYPES,
      "nested",
    );
    expectApiDispatchSpanKind(
      timingEvents,
      ["api_dispatch_pre_create_agent_run"],
      "top_level",
    );
    expect(timingEvents).toContainEqual(
      expect.objectContaining({
        op_type: "api_dispatch_prepare_run_callbacks",
        span_kind: "nested",
        run_callback_internal_count_bucket: "1",
        run_callback_http_count_bucket: "0",
      }),
    );
    expectNoApiDispatchActions(
      timingEvents,
      API_DISPATCH_ZERO_INTERNAL_ENTRYPOINT_ACTION_TYPES,
    );
    expectApiDispatchTimingEventsNotToLeak(timingEvents, [
      prompt,
      clientThreadId,
      clientMessageId,
      agentId,
    ]);

    const run = await api.readRun(actor, runId);
    expect(run.prompt).toBe(prompt);
    expect(run.appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(run.appendSystemPrompt).not.toContain("# Artifact Template Context");

    const messages = await waitForThreadMessages(
      actor,
      clientThreadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === clientMessageId &&
            message.runId === runId
          );
        });
      },
    );
    const userRows = userMessages(messages.messages);
    expect(userRows).toHaveLength(2);
    expect(userRows).toContainEqual(
      expect.objectContaining({
        id: clientMessageId,
        content: prompt,
      }),
    );
    expect(userRows).toContainEqual(
      expect.objectContaining({
        content: prompt,
        runId,
        revokesMessageId: clientMessageId,
      }),
    );
    const original = userRows.find((message) => {
      return message.id === clientMessageId;
    });
    expect(original).toMatchObject({
      id: clientMessageId,
      content: prompt,
    });
    expect(original?.runId).toBeUndefined();

    await expect(chat.readThread(actor, clientThreadId)).resolves.toStrictEqual(
      {
        lastReadAt: null,
      },
    );

    // A pre-created client thread with no runs cannot be sent into.
    const emptyClientThreadId = randomUUID();
    const created = await chat.createThread(actor, {
      agentId,
      title: "Pre-created client thread",
      clientThreadId: emptyClientThreadId,
    });
    expect(created.id).toBe(emptyClientThreadId);
    const emptyThreadSend = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "send into the pre-created thread",
        clientThreadId: emptyClientThreadId,
      },
      [400],
    );
    expectApiError(emptyThreadSend.body);
    expect(emptyThreadSend.body.error.message).toBe(
      "Client thread id is already in use",
    );
  }, 90_000);

  it("rejects unauthenticated, unknown-agent, and foreign private-agent sends", async () => {
    const unauthenticated = await chat.requestSendMessage(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Private chat-send guard agent",
      visibility: "private",
    });

    const unknownAgent = await chat.requestSendMessage(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(unknownAgent.body);
    expect(unknownAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const forbidden = await chat.requestSendMessage(
      peer,
      { agentId: agent.agentId, prompt: "hello" },
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  }, 30_000);
});

describe("CHAT-02: interrupting active chat runs", () => {
  it("interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "long task to interrupt",
    });

    const interruptId = randomUUID();
    const interrupted = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientMessageId: interruptId,
      },
      [201],
    );
    if (interrupted.status !== 201) {
      throw new Error("Expected the interrupt send to be accepted");
    }
    expect(interrupted.body.runId).toBeNull();
    await waitForRunStatus(actor, first.runId, "cancelled");

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return message.interruptsRunId === first.runId;
          }) &&
          assistantMessages(items).some((message) => {
            return (
              message.runId === first.runId &&
              message.runLifecycleEvent === "cancelled"
            );
          })
        );
      },
    );
    const interruptRows = userMessages(messages.messages).filter((message) => {
      return message.interruptsRunId === first.runId;
    });
    expect(interruptRows).toHaveLength(1);
    expect(interruptRows[0]).toMatchObject({ id: interruptId, content: null });
    expect(
      assistantMessages(messages.messages).filter((message) => {
        return (
          message.runId === first.runId &&
          message.runLifecycleEvent === "cancelled"
        );
      }),
    ).toHaveLength(1);

    // Replaying the interrupt (same or fresh client id) stays idempotent.
    const replayedInterrupt = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientMessageId: interruptId,
      },
      [201],
    );
    expect(replayedInterrupt.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    const afterReplays = await chat.listThreadMessages(actor, first.threadId);
    expect(
      userMessages(afterReplays.messages).filter((message) => {
        return message.interruptsRunId === first.runId;
      }),
    ).toHaveLength(1);

    // A run that went terminal without an interrupt row cannot be interrupted.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "cancelled through the cancel api",
    });
    await cancelChatRun(actor, second.runId);
    const lateInterrupt = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: second.runId,
        clientMessageId: randomUUID(),
      },
      [400],
    );
    expectApiError(lateInterrupt.body);
    expect(lateInterrupt.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );

    // The interrupt's client message id is burned for normal sends.
    const reusedInterruptId = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the interrupt client id",
        clientMessageId: interruptId,
      },
      [409],
    );
    expectApiError(reusedInterruptId.body);
    expect(reusedInterruptId.body.error.message).toBe(
      "clientMessageId is already in use",
    );

    // Both cancelled rounds surface as incomplete context for the next run.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "resume after interruptions",
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).toContain("RUN_STATUS: cancelled");
    expect(appended).toContain("User: long task to interrupt");
    expect(appended).not.toContain("# Web Chat Run Context");
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: queueing and recalling messages", () => {
  it("queues, retries, and recalls messages behind an active run", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "anchor active run",
    });

    const queuedId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientMessageId: queuedId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued send to be accepted");
    }
    expect(queued.body.runId).toBeNull();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const queuedRetry = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientMessageId: queuedId,
      },
      [201],
    );
    expect(queuedRetry.body).toStrictEqual(queued.body);
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-opus-4-6",
    );

    // Another user's send cannot claim the queued message's client id.
    const stranger = bdd.user();
    await api.ensureOrgModelProvider(stranger);
    const strangerAgent = await bdd.createAgent(stranger, {
      displayName: "Cross-user client-id agent",
    });
    const strangerThread = await chat.createThread(stranger, {
      agentId: strangerAgent.agentId,
      title: "Cross-user conflict thread",
    });
    const crossUser = await chat.requestSendMessage(
      stranger,
      {
        agentId: strangerAgent.agentId,
        threadId: strangerThread.id,
        prompt: "cross-user retry",
        clientMessageId: queuedId,
      },
      [409],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.message).toBe(
      "clientMessageId is already in use",
    );
    const strangerMessages = await chat.listThreadMessages(
      stranger,
      strangerThread.id,
    );
    expect(strangerMessages.messages).toStrictEqual([]);

    const beforeRecall = await chat.listThreadMessages(actor, first.threadId);
    expect(
      userMessages(beforeRecall.messages).filter((message) => {
        return message.id === queuedId;
      }),
    ).toHaveLength(1);

    const recalled = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesMessageId: queuedId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the recall send to be accepted");
    }
    expect(recalled.body.runId).toBeNull();

    const repeatedRecall = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesMessageId: queuedId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    const afterRepeated = await chat.listThreadMessages(actor, first.threadId);

    // Run-associated messages cannot be recalled.
    const associated = userMessages(afterRepeated.messages).find((message) => {
      return message.runId === first.runId;
    });
    if (!associated) {
      throw new Error("Expected the active run's user message to be listed");
    }
    const rejectedRecall = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesMessageId: associated.id,
        clientMessageId: randomUUID(),
      },
      [400],
    );
    expectApiError(rejectedRecall.body);
    expect(rejectedRecall.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );

    await cancelChatRun(actor, first.runId);
    expect((await api.readRun(actor, first.runId)).status).toBe("cancelled");
  }, 90_000);

  it("keeps a queued message when recall targets another owned thread", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "cross-thread recall anchor",
    });
    const queuedMessageId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "must remain queued in the original thread",
        clientMessageId: queuedMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const otherThread = await chat.createThread(actor, {
      agentId,
      title: "Cross-thread recall target",
    });
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: otherThread.id,
        revokesMessageId: queuedMessageId,
        clientMessageId: randomUUID(),
      },
      [201, 400],
    );

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the original queued message to create a run");
    }
    expect(promoted.content).toBe("must remain queued in the original thread");
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02: org queue markers", () => {
  it("drains queued chat runs when an interrupt request aborts post-cancel", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const controller = new AbortController();

    const blocker = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "occupy org concurrency before interrupt abort" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queued = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "drain after interrupt abort" },
      [201],
    );
    if (queued.status !== 201 || queued.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queued.body.status).toBe("queued");

    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "queue:changed") {
        const error = new Error("abort after interrupt cancel commit");
        error.name = "AbortError";
        controller.abort(error);
      }
      return Promise.resolve(undefined);
    });

    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: blocker.body.threadId,
        interruptsRunId: blocker.body.runId,
        clientMessageId: randomUUID(),
      },
      [201],
      controller.signal,
    );

    await waitForRunStatus(actor, blocker.body.runId, "cancelled");
    await waitForRunStatus(actor, queued.body.runId, "pending");
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(queued.body.runId);
    expect(claim.prompt).toBe("drain after interrupt abort");

    await api.requestCancelRun(actor, queued.body.runId, [200]);
  });

  it("marks queued chat runs and revokes the marker on dequeue", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "occupy org concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queuedRun = await chat.requestSendMessage(
      actor,
      { agentId, prompt: "wait behind the active run" },
      [201],
    );
    if (queuedRun.status !== 201 || queuedRun.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queuedRun.body.status).toBe("queued");
    const queuedBinding = await readThreadSessionBinding(
      context,
      queuedRun.body.threadId,
    );
    expect(queuedBinding.agent_session_run_id).toBe(queuedRun.body.runId);
    expect(queuedBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(queuedBinding.run_session_id).toBe(queuedBinding.agent_session_id);
    expect(sandboxOperationEventsForRun(queuedRun.body.runId)).toContainEqual({
      _time: expect.any(String),
      source: "api",
      op_type: "chat_thread_session_binding_persisted",
      sandbox_type: "chat",
      duration_ms: 0,
      success: true,
      run_id: queuedRun.body.runId,
      chat_thread_id: queuedRun.body.threadId,
      agent_session_id: queuedBinding.agent_session_id,
      agent_session_run_id: queuedRun.body.runId,
      binding_action: "initialized",
      run_status: "queued",
    });

    const queuedThread = queuedRun.body.threadId;
    const beforeDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return message.runId === queuedRun.body.runId;
          }) &&
          assistantMessages(items).some((message) => {
            return message.runEventId === "queue:queued";
          })
        );
      },
    );
    const queuedRunUserRows = userMessages(beforeDequeue.messages);
    expect(queuedRunUserRows).toHaveLength(2);
    const queuedRunMessage = queuedRunUserRows.find((message) => {
      return message.runId === queuedRun.body.runId;
    });
    expect(queuedRunMessage).toMatchObject({
      content: "wait behind the active run",
      runId: queuedRun.body.runId,
    });
    expect(queuedRunMessage?.revokesMessageId).toBeDefined();
    const queuedRunOriginal = queuedRunUserRows.find((message) => {
      return message.id === queuedRunMessage?.revokesMessageId;
    });
    expect(queuedRunOriginal?.content).toBe("wait behind the active run");
    expect(queuedRunOriginal?.runId).toBeUndefined();
    const marker = assistantMessages(beforeDequeue.messages).find((message) => {
      return message.runEventId === "queue:queued";
    });
    if (!marker) {
      throw new Error("Expected an assistant queue marker");
    }
    expect(marker).toMatchObject({
      content: "Waiting in queue...",
      runId: queuedRun.body.runId,
    });

    // The queued run still counts as the thread's active run, so a presentation
    // runbook selection queues as an unassociated message carrying that
    // selection.
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "presentation",
      selection: {
        templateId: template.templateId,
      },
    };
    const templateMessageId = randomUUID();
    const queuedTemplate = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: queuedThread,
        prompt: "template queued deck",
        generationTemplate,
        clientMessageId: templateMessageId,
      },
      [201],
    );
    expect(queuedTemplate.body).toMatchObject({ runId: null });
    const withTemplate = await chat.listThreadMessages(actor, queuedThread);
    const templateMessage = userMessages(withTemplate.messages).find(
      (message) => {
        return message.id === templateMessageId;
      },
    );
    expect(templateMessage?.generationTemplate).toStrictEqual(
      generationTemplate,
    );

    const queueBefore = await api.readRunQueue(actor);
    expect(queueBefore.body.queue).toHaveLength(1);
    expect(queueBefore.body.queue[0]).toMatchObject({
      runId: queuedRun.body.runId,
    });

    // Recall the queued template message so the dequeue does not auto-send it.
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: queuedThread,
        revokesMessageId: templateMessageId,
        clientMessageId: randomUUID(),
      },
      [201],
    );

    // Interrupting the blocking run drains the org queue and revokes the
    // queue marker on the dequeued run's thread.
    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: blocker.body.threadId,
        interruptsRunId: blocker.body.runId,
        clientMessageId: randomUUID(),
      },
      [201],
    );

    await waitForRunStatus(actor, blocker.body.runId, "cancelled");
    await waitForRunStatus(actor, queuedRun.body.runId, "pending");
    const afterDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return assistantMessages(items).some((message) => {
          return message.runEventId === "queue:dequeued";
        });
      },
    );
    const revoker = assistantMessages(afterDequeue.messages).find((message) => {
      return message.runEventId === "queue:dequeued";
    });
    if (!revoker) {
      throw new Error("Expected an assistant queue-dequeued revoker");
    }
    expect(revoker).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
      revokesMessageId: marker.id,
    });
    const queueAfter = await api.readRunQueue(actor);
    expect(queueAfter.body.queue).toHaveLength(0);

    await cancelChatRun(actor, queuedRun.body.runId);
    expect((await api.readRun(actor, queuedRun.body.runId)).status).toBe(
      "cancelled",
    );
  }, 90_000);
});

describe("CHAT-02: dispatch failure", () => {
  it("fails the run and delivers the terminal chat callback when dispatch cannot start", async () => {
    const { actor, agentId } = await entitledChatActor();
    const routeRequests = chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const messageId = randomUUID();

    const sent = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "fail before worker start",
        clientMessageId: messageId,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to still create a run");
    }
    expect(sent.body.status).toBe("failed");
    await flushWaitUntilForTest();
    expect(
      firstAssistantMessageEligibilityEventsForRun(sent.body.runId),
    ).toStrictEqual([
      expect.objectContaining({
        op_type: "first_assistant_message_eligible",
        sandbox_type: "runner",
        duration_ms: 0,
        success: true,
        run_id: sent.body.runId,
      }),
    ]);

    const run = await api.readRun(actor, sent.body.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("RUNNER_DEFAULT_GROUP");
    await expect(
      readThreadSessionBinding(context, sent.body.threadId),
    ).resolves.toMatchObject({
      agent_session_id: null,
      agent_session_run_id: null,
      run_session_id: null,
    });

    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return (
            message.runId === sent.body.runId &&
            message.runLifecycleEvent === "failed"
          );
        });
      },
    );
    const failedMarker = assistantMessages(messages.messages).find(
      (message) => {
        return (
          message.runId === sent.body.runId &&
          message.runLifecycleEvent === "failed"
        );
      },
    );
    if (!failedMarker) {
      throw new Error("Expected a failed lifecycle marker");
    }
    expect(failedMarker.error).toStrictEqual(expect.any(String));
    expect(userMessages(messages.messages)).toContainEqual(
      expect.objectContaining({
        content: "fail before worker start",
        revokesMessageId: messageId,
        runId: sent.body.runId,
      }),
    );
    const replay = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "fail before worker start",
        clientMessageId: messageId,
      },
      [201],
    );
    expect(replay.body).toMatchObject({
      runId: sent.body.runId,
      threadId: sent.body.threadId,
      status: "failed",
    });
    await flushWaitUntilForTest();
    expect(
      firstAssistantMessageEligibilityEventsForRun(sent.body.runId),
    ).toHaveLength(1);
    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).not.toContainEqual(
      expect.objectContaining({ runId: sent.body.runId }),
    );
    await api.requestClaimRunnerJob(true, sent.body.runId, [404]);
    expect(routeRequests()).toBe(0);
  }, 60_000);
});

describe("CHAT-02: admission without spendable credits", () => {
  it("blocks admission for model-first sends through visible chat messages", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    const agent = await bdd.createAgent(actor, {
      displayName: "Pro-suspend chat agent",
    });
    if (!actor.orgId) {
      throw new Error("Expected pro-suspend chat actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: true,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const clientMessageId = randomUUID();
    const sendBody: ChatRunSendBody = {
      agentId: agent.agentId,
      prompt: "blocked by suspended plan",
      model: "claude-sonnet-4-6",
      clientMessageId,
    };
    const sent = await chat.requestSendMessage(actor, sendBody, [201]);
    if (sent.status !== 201) {
      throw new Error("Expected the blocked send to return 201 without a run");
    }
    expect(sent.body.runId).toBeNull();

    const messages = await chat.listThreadMessages(actor, sent.body.threadId);
    const blockedUsers = userMessages(messages.messages);
    expect(blockedUsers).toHaveLength(2);
    const queuedUser = blockedUsers.find((message) => {
      return message.id === clientMessageId;
    });
    if (!queuedUser) {
      throw new Error("Expected the original queued user message");
    }
    expect(queuedUser).toMatchObject({
      content: "blocked by suspended plan",
    });
    expect(queuedUser.runId).toBeUndefined();
    expect(queuedUser.error).toBeUndefined();
    const blockedUser = blockedUsers.find((message) => {
      return message.revokesMessageId === clientMessageId;
    });
    if (!blockedUser) {
      throw new Error("Expected an insufficient-credits replacement message");
    }
    expect(blockedUser).toMatchObject({
      content: "blocked by suspended plan",
      error: "insufficient_credits",
      revokesMessageId: clientMessageId,
    });
    expect(blockedUser.runId).toBeUndefined();
    const guidance = assistantMessages(messages.messages)[0];
    if (!guidance) {
      throw new Error("Expected insufficient-credits assistant guidance");
    }
    expect(guidance.content).toContain("Buy more credits");
    expect(guidance.error).toBe("insufficient_credits");

    const appended = await chat.listThreadMessages(actor, sent.body.threadId, {
      sinceSeqId: queuedUser.seqId,
    });
    expect(appended.messages).toStrictEqual([
      expect.objectContaining({
        id: blockedUser.id,
        revokesMessageId: clientMessageId,
        error: "insufficient_credits",
      }),
      expect.objectContaining({
        id: guidance.id,
        error: "insufficient_credits",
      }),
    ]);

    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).toHaveLength(0);
    expect(queue.body.concurrency.active).toBe(0);

    const retry = await chat.requestSendMessage(
      actor,
      { ...sendBody, threadId: sent.body.threadId },
      [201],
    );
    expect(retry.body).toStrictEqual(sent.body);
    const afterRetry = await chat.listThreadMessages(actor, sent.body.threadId);
    expect(afterRetry.messages).toHaveLength(3);
  }, 60_000);
});

describe("CHAT-02: Zero Mail link delivery", () => {
  it("delivers a linked Gmail draft exactly once through the agent reply", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.ZeroMail]: true },
    );
    mockGmailConnectorOAuth({
      accessToken: "gmail-agent-reply-token",
      email: "sender@example.com",
    });
    const oauth = await connectors.startOauth(actor, "gmail", "oauth");
    const oauthState = new URL(oauth.authorizationUrl).searchParams.get(
      "state",
    );
    if (!oauthState) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "gmail-agent-reply-code",
      state: oauthState,
    });
    await api.enableAgentConnectors(actor, agentId, ["gmail"]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Create a Gmail draft and let me review it",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const gmailDraftId = "r-agent-reply-draft";
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/:draftId",
        ({ params, request }) => {
          expect(params.draftId).toBe(gmailDraftId);
          expect(request.headers.get("authorization")).toBe(
            "Bearer gmail-agent-reply-token",
          );
          expect(new URL(request.url).searchParams.get("format")).toBe("full");
          return HttpResponse.json({
            id: gmailDraftId,
            message: {
              id: "gmail-agent-reply-message",
              threadId: "gmail-agent-reply-thread",
              payload: {
                partId: "",
                mimeType: "text/plain",
                filename: "",
                headers: [
                  { name: "From", value: "Sender <sender@example.com>" },
                  { name: "To", value: "recipient@example.com" },
                  { name: "Subject", value: "Review this draft" },
                ],
                body: { size: 9, data: "TWFpbCBib2R5" },
              },
            },
          });
        },
      ),
    );

    const linked = await accept(
      setupApp({ context })(zeroMailContract).linkDraft({
        headers: {
          authorization: `Bearer ${zeroTokenFromClaim(claim)}`,
        },
        body: {
          threadId: run.threadId,
          agentId,
          gmailDraftId,
        },
      }),
      [200],
    );
    const beforeReply = await chat.listThreadMessages(actor, run.threadId);
    expect(
      assistantMessages(beforeReply.messages).filter((message) => {
        return message.content?.includes(linked.body.mailDraftUrl);
      }),
    ).toHaveLength(0);

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, linked.body.mailDraftUrl),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    const completed = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return assistantMessages(messages).some((message) => {
          return message.content === linked.body.mailDraftUrl;
        });
      },
    );
    expect(
      assistantMessages(completed.messages).filter((message) => {
        return message.content?.includes(linked.body.mailDraftUrl);
      }),
    ).toStrictEqual([
      expect.objectContaining({
        content: linked.body.mailDraftUrl,
        runId: run.runId,
      }),
    ]);
  });
});

describe("CHAT-02: model-first provider policies", () => {
  it("adds Codex image upload guidance for web chat Codex sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ZeroMail]: true,
      },
    );

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt:
        "generate an image in web chat using the aurora-21210 color palette",
      model: "gpt-5.6-luna",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(claim.cliAgentType).toBe("codex");
    expect(appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(appendSystemPrompt).toContain("zero web upload-file -h");
    expect(appendSystemPrompt).toContain("zero mail link <gmail-draft-id>");
    expect(appendSystemPrompt).toContain(
      "GET /gmail/v1/users/me/settings/sendAs",
    );
    expect(appendSystemPrompt).toContain("append that signature exactly once");
    expect(appendSystemPrompt).toContain(
      "return the link from the command to the user",
    );
    expect(appendSystemPrompt).toContain(
      "add `--callback-prompt <prompt>` to `zero mail link`",
    );
    expect(appendSystemPrompt).toContain(
      "confirm the send against Gmail before reporting it",
    );
    expect(appendSystemPrompt).toContain(
      "`zero workflow automation list <workflow>` shows one workflow's triggers",
    );
    expect(appendSystemPrompt).toContain(
      "Never send a reply automatically; the user always sends",
    );
    expect(appendSystemPrompt).toContain(CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET);
    expect(appendSystemPrompt).not.toContain("When running in Codex");
    let previousSectionIndex = -1;
    for (const section of [
      "# Agent Identity",
      "# Agent Tools",
      "# Current User Info",
      "# Current Integration",
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    ]) {
      const sectionIndex = appendSystemPrompt.indexOf(section);
      expect(sectionIndex).toBeGreaterThan(previousSectionIndex);
      previousSectionIndex = sectionIndex;
    }
    await cancelChatRun(actor, run.runId);
  });

  it("routes model policy providers into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId: deepseekId } = await upsertOrgModelProvider(actor, {
      type: "deepseek-api-key",
      secret: "selected-deepseek-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-pro",
        isDefault: true,
        defaultProviderType: "deepseek-api-key",
        credentialScope: "org",
        modelProviderId: deepseekId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected deepseek provider",
      model: "deepseek-v4-pro",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder("deepseek-api-key", "DEEPSEEK_API_KEY"),
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe(
      "https://api.deepseek.com/anthropic",
    );
    expect(environment.ANTHROPIC_MODEL).toBe("deepseek-v4-pro");
    expect(environment.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();

    // The new thread's initial model is recorded on the created event. The
    // send route does not emit a model_selection_updated event.
    const thread = await chat.readThread(actor, run.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    expect(thread).not.toHaveProperty("modelProviderId");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: run.threadId,
        selectedModel: "deepseek-v4-pro",
      }),
    );
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: run.threadId,
        selectedModel: "deepseek-v4-pro",
      }),
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
    expect((await api.readRun(actor, run.runId)).status).toBe("completed");

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "follow up without a send-time model override",
    });
    const { claim: followUpClaim } = await claimChatRun(
      runnerGroup,
      followUp.runId,
    );
    const followUpEnvironment = claimEnvironment(followUpClaim);
    expect(followUpEnvironment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder("deepseek-api-key", "DEEPSEEK_API_KEY"),
    );
    expect(followUpEnvironment.ANTHROPIC_BASE_URL).toBe(
      "https://api.deepseek.com/anthropic",
    );
    expect(followUpEnvironment.ANTHROPIC_MODEL).toBe("deepseek-v4-pro");
    await cancelChatRun(actor, followUp.runId);

    // A vm0 provider pin in an entitled org passes the spendable-credits
    // admission. The outcome past admission is race-dependent on the shared
    // database: 503 when no vm0 execution key exists (no public provisioning
    // surface), 201 when another suite's alive legacy test has seeded a
    // global vm0 key. Both prove the credits-ok admission arm.
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const vm0Send = await requestSendMessageRaw(actor, {
      agentId,
      prompt: "vm0-backed admission with spendable credits",
      model: "claude-sonnet-4-6",
    });
    expect([201, 503]).toContain(vm0Send.status);
    if (vm0Send.status === 503) {
      expectApiError(vm0Send.body);
      expect(vm0Send.body.error.message).toContain(
        "No model provider configured",
      );
    } else {
      const vm0Body = vm0Send.body as { readonly runId: string | null };
      if (vm0Body.runId !== null) {
        await api.requestCancelRun(actor, vm0Body.runId, [200]);
      }
    }
  }, 90_000);

  it("recovers a removed thread model through the current workspace route", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start before the thread model is removed",
      model: "claude-sonnet-4-6",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);

    await seedVm0ManagedModelKey("gpt-5.6-terra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const recovered = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue through the current workspace default",
    });
    const recoveredClaim = await claimChatRun(runnerGroup, recovered.runId);
    expect(recoveredClaim.claim.cliAgentType).toBe("codex");
    expect(recoveredClaim.claim.resumeSession).toBeNull();
    const recoveredEnvironment = claimEnvironment(recoveredClaim.claim);
    expect(recoveredEnvironment.OPENAI_MODEL).toBe("gpt-5.6-terra");
    expect(recoveredEnvironment.ANTHROPIC_MODEL).toBeUndefined();

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === first.threadId &&
          event.selectedModel === "gpt-5.6-terra"
        );
      }),
    ).toHaveLength(1);

    await cancelChatRun(actor, recovered.runId);
  }, 90_000);

  it("does not overwrite a concurrent explicit thread model selection", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-4-6",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const [sent, updated] = await Promise.all([
      chat.requestSendMessage(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send while choosing a new sticky model",
        },
        [201],
      ),
      chat.requestUpdateThreadModelSelection(
        actor,
        thread.id,
        "claude-sonnet-5",
        [204],
      ),
    ]);
    expect(updated.status).toBe(204);
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the concurrent send to create a run");
    }
    const racedClaim = await claimChatRun(runnerGroup, sent.body.runId);
    expect(["claude-opus-4-6", "claude-sonnet-5"]).toContain(
      claimEnvironment(racedClaim.claim).ANTHROPIC_MODEL,
    );
    await cancelChatRun(actor, sent.body.runId);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue on the explicit sticky model",
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    expect(claimEnvironment(followUpClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "claude-sonnet-5"
        );
      }),
    ).toHaveLength(1);
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "claude-opus-4-6"
        );
      }).length,
    ).toBeLessThanOrEqual(1);
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("passes Codex fast mode only for feature-enabled ChatGPT subscription GPT 5.5 and GPT 5.6 sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const actorWithOrg = { ...actor, orgId };

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
      {
        model: "gpt-5.5",
        isDefault: false,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const switchOffThreadId = randomUUID();
    const switchOff = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "run codex fast with switch off",
        clientThreadId: switchOffThreadId,
        model: "gpt-5.6-sol",
        runOptions: { codexServiceTier: "fast" },
      },
      [400],
    );
    expectApiError(switchOff.body);
    expect(switchOff.body.error.message).toBe(
      "Codex fast mode is not enabled for this workspace",
    );
    await chat.requestReadThread(actor, switchOffThreadId, [404]);

    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.CodexFastMode]: true,
    });

    const fast = await sendChatRun(actor, {
      agentId,
      prompt: "run codex fast",
      model: "gpt-5.6-sol",
      runOptions: { codexServiceTier: "fast" },
    });
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );
    const { claim } = await claimChatRun(runnerGroup, fast.runId);
    const environment = claimEnvironment(claim);
    expect(claim.cliAgentType).toBe("codex");
    expect(environment.OPENAI_MODEL).toBe("gpt-5.6-sol");
    expect(environment.VM0_CODEX_SERVICE_TIER).toBe("fast");
    expect(environment.CHATGPT_ACCESS_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "codex-oauth-token",
        "CHATGPT_ACCESS_TOKEN",
      ),
    );
    await cancelChatRun(actor, fast.runId);
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    const invalidFastPatch = await chat.requestUpdateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5",
      [400],
      { codexServiceTier: "fast" },
    );
    expectApiError(invalidFastPatch.body);
    expect(invalidFastPatch.body.error.message).toBe(
      "Codex fast mode is only available for ChatGPT (Codex) GPT 5.5 and GPT 5.6 runs",
    );
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    await chat.updateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5",
      {
        codexServiceTier: null,
      },
    );
    expect(
      (await readThreadProjection(actor, fast.threadId)).serviceTier,
    ).toBeNull();
    const updatedFastThreadEvents = await chat.requestThreadEvents(
      actor,
      {},
      [200],
    );
    expect(updatedFastThreadEvents.status).toBe(200);
    if (updatedFastThreadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: fast.threadId,
        selectedModel: "claude-sonnet-5",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: fast.threadId,
        serviceTier: "priority",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "service_tier_updated",
        chatThreadId: fast.threadId,
        serviceTier: null,
      }),
    );

    const standard = await sendChatRun(actor, {
      agentId,
      threadId: fast.threadId,
      prompt: "run codex standard",
      model: "gpt-5.5",
    });
    expect(
      (await readThreadProjection(actor, standard.threadId)).serviceTier,
    ).toBeNull();
    const { claim: standardClaim } = await claimChatRun(
      runnerGroup,
      standard.runId,
    );
    const standardEnvironment = claimEnvironment(standardClaim);
    expect(standardEnvironment.OPENAI_MODEL).toBe("gpt-5.5");
    expect(standardEnvironment.VM0_CODEX_SERVICE_TIER).toBeUndefined();
    await cancelChatRun(actor, standard.runId);

    const rejectedThreadId = randomUUID();
    const rejected = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "Claude cannot use Codex fast mode",
        clientThreadId: rejectedThreadId,
        model: "claude-sonnet-5",
        runOptions: { codexServiceTier: "fast" },
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "Codex fast mode is only available for ChatGPT (Codex) GPT 5.5 and GPT 5.6 runs",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);
  }, 90_000);

  it("normalizes persisted fast mode after the current provider route changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    const { providerId: openAiProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "rerouted-openai-key",
      },
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.CodexFastMode]: true },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start fast before the provider route changes",
      model: "gpt-5.5",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.5",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openAiProviderId,
      },
    ]);
    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue from a client that still has fast cached",
      runOptions: { codexServiceTier: "fast" },
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    const environment = claimEnvironment(followUpClaim.claim);
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("openai-api-key", "OPENAI_API_KEY"),
    );
    expect(environment.OPENAI_MODEL).toBe("gpt-5.5");
    expect(environment.VM0_CODEX_SERVICE_TIER).toBeUndefined();
    expect(
      (await readThreadProjection(actor, first.threadId)).serviceTier,
    ).toBeNull();
    await expectNoThreadModelUpdateEvent(actor, first.threadId, "gpt-5.5");
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("routes OpenRouter provider pins through runtime model aliases and firewall auth", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected openrouter provider",
      model: "claude-opus-4-7",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "openrouter-api-key",
        "OPENROUTER_API_KEY",
      ),
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(environment.ANTHROPIC_API_KEY).toBe("");
    expect(environment.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.7");
    expect(environment.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      "anthropic/claude-opus-4.7",
    );
    expect(environment.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      "anthropic/claude-opus-4.7",
    );
    expect(environment.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBeUndefined();

    if (!claim.encryptedSecrets) {
      throw new Error("Expected OpenRouter claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected OpenRouter firewall auth to resolve");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer test-openrouter-key",
    );
    expect(resolved.body.resolvedSecrets).toStrictEqual(["OPENROUTER_API_KEY"]);

    const thread = await chat.readThread(actor, run.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    expect(thread).not.toHaveProperty("modelProviderId");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: run.threadId,
        selectedModel: "claude-opus-4-7",
      }),
    );

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 90_000);

  it("routes vm0 Kimi through Moonshot attachment-disabled env bindings", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keySuffix = randomUUID();

    await replaceBddVm0ApiKeys({
      vendor: "moonshot",
      model: "kimi-k2.7-code",
      keys: [
        {
          apiKey: `vm0-key-bdd-dev-seed-${keySuffix}`,
          label: "dev-seed",
        },
      ],
    });

    let runId: string | null = null;
    const cancelRunIfCreated = async () => {
      if (runId) {
        await api.requestCancelRun(actor, runId, [200]);
      }
    };
    const deleteVm0KimiKeys = async () => {
      await deleteBddVm0ApiKeys({
        vendor: "moonshot",
        model: "kimi-k2.7-code",
      });
    };
    const cleanupRunAndKeys = async () => {
      await Promise.all([deleteVm0KimiKeys(), cancelRunIfCreated()]);
    };

    await (async () => {
      await api.updateOrgModelPolicies(actor, [
        {
          model: "kimi-k2.7-code",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);

      const run = await sendChatRun(actor, {
        agentId,
        prompt: "run with the selected vm0 kimi provider",
        model: "kimi-k2.7-code",
      });
      runId = run.runId;

      const { claim } = await claimChatRun(runnerGroup, run.runId);
      const environment = claimEnvironment(claim);
      expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(
        modelProviderSecretPlaceholder("moonshot-api-key", "MOONSHOT_API_KEY"),
      );
      expect(environment.ANTHROPIC_BASE_URL).toBe(
        "https://api.moonshot.ai/anthropic",
      );
      expect(environment.ANTHROPIC_MODEL).toBe("kimi-k2.7-code");
      expect(environment.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
    })().then(cleanupRunAndKeys, async (error: unknown) => {
      await cleanupRunAndKeys();
      throw error;
    });
  }, 90_000);

  it("prefers dev-seed vm0 managed keys over concurrent test keys", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keySuffix = randomUUID();
    const fakeKey = `vm0-key-bdd-fake-${keySuffix}`;
    const devSeedKey = `vm0-key-bdd-dev-seed-${keySuffix}`;
    let runId: string | null = null;

    onTestFinished(async () => {
      await Promise.all([
        deleteBddVm0ApiKeys({ vendor: "zai", model: "glm-5.2" }),
        ...(runId ? [api.requestCancelRun(actor, runId, [200])] : []),
      ]);
    });

    await replaceBddVm0ApiKeys({
      vendor: "zai",
      model: "glm-5.2",
      keys: [
        {
          apiKey: fakeKey,
          label: `bdd-fake-${keySuffix}`,
        },
        {
          apiKey: devSeedKey,
          label: "dev-seed",
        },
      ],
    });

    await api.updateOrgModelPolicies(actor, [
      {
        model: "glm-5.2",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected vm0 provider",
      model: "glm-5.2",
    });
    runId = run.runId;

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder("zai-api-key", "ZAI_API_KEY"),
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe(
      "https://api.z.ai/api/anthropic",
    );
    expect(environment.ANTHROPIC_MODEL).toBe("glm-5.2");

    if (!claim.encryptedSecrets) {
      throw new Error("Expected vm0 claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("ZAI_API_KEY")}`,
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected vm0 firewall auth to resolve");
    }
    const authorization = resolved.body.headers.Authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new Error("Expected vm0 firewall auth to return a bearer token");
    }
    await expect(
      hasVm0ApiKeyLabel({
        vendor: "zai",
        model: "glm-5.2",
        apiKey: authorization.slice("Bearer ".length),
        label: "dev-seed",
      }),
    ).resolves.toBeTruthy();
  }, 90_000);
  it("rejects legacy blank OpenRouter provider secrets during firewall auth", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await overwriteModelProviderSecretForTests(context.signal, {
      providerId,
      secretName: "OPENROUTER_API_KEY",
      secret: "   ",
    });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with a legacy blank openrouter provider",
      model: "claude-opus-4-7",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    if (!claim.encryptedSecrets) {
      throw new Error("Expected OpenRouter claim to carry encrypted secrets");
    }

    const rejected = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [424],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 60_000);
});

describe("CHAT-02: run-level model overrides", () => {
  it("uses send model overrides without mutating the thread model while preserving same-family sessions", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-4-6",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const firstPrompt = "first turn on the default opus policy";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-opus-4-6",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-6",
    );
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "opus answer")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "opus answer";
      });
    });
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-opus-4-6",
    );
    expect(
      (await api.readRun(actor, first.runId)).result?.agentSessionId,
    ).toMatch(/[0-9a-f-]{36}/);

    // A run-level override of another model in the same family resumes the CLI
    // session while carrying the prior web round as context.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "switch to sonnet",
      model: "claude-sonnet-4-6",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(`- LOG_COMMAND: zero logs ${first.runId} --all`);
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain("Assistant: opus answer");
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-4-6",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);

    // Follow-ups without a send model override go back to the thread's stored
    // model. Both models remain in the Claude family, so session continuity is
    // preserved.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on the thread model",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    expect(claimEnvironment(thirdClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-6",
    );
    await cancelChatRun(actor, third.runId);
  }, 90_000);

  it("resumes the CLI session across same-family model switches", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-4-6",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start on opus before switching within Claude",
      model: "claude-opus-4-6",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet in the same session",
      model: "claude-sonnet-4-6",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-4-6",
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("lazily adopts the latest eligible session for a legacy unbound thread", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish history before lazy adoption",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    await clearThreadSessionBinding(context, first.threadId);
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: null,
      agent_session_run_id: null,
    });

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "adopt the historical session",
    });
    const secondBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(secondBinding).toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: second.runId,
      run_session_id: firstBinding.agent_session_id,
    });
    expect(sandboxOperationEventsForRun(second.runId)).toContainEqual(
      expect.objectContaining({
        op_type: "chat_thread_session_binding_persisted",
        chat_thread_id: first.threadId,
        agent_session_id: firstBinding.agent_session_id,
        agent_session_run_id: second.runId,
        binding_action: "adopted",
      }),
    );
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("retries preparation when the canonical conversation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for snapshot retry");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the checkpoint snapshot",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });
    const secondPromise = sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after the checkpoint changes",
    });
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(1);

    await clearThreadSessionConversation(context, first.threadId);
    admissionLock.release();
    await admissionLock.done;
    const second = await secondPromise;

    const retryEvents = sandboxOperationEvents().filter((event) => {
      return (
        event.op_type === "chat_thread_session_binding_retry" &&
        event.chat_thread_id === first.threadId
      );
    });
    expect(retryEvents).toContainEqual(
      expect.objectContaining({
        agent_session_id: firstBinding.agent_session_id,
        binding_action: "retried",
        resolution_action: "reused",
        retry_reason: "session_changed",
      }),
    );
    const secondBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(secondBinding).toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: second.runId,
      run_session_id: firstBinding.agent_session_id,
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("re-resolves a sticky model through the current provider policy", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin sonnet model-first",
      model: "claude-sonnet-4-6",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const originalBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the original route to bind a session");
    }
    const pinned = await chat.readThread(actor, first.threadId);
    expect(pinned).not.toHaveProperty("selectedModel");
    expect(pinned).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-4-6",
    );

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "rerouted-claude-oauth-token",
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the provider policy reroute",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    const environment = claimEnvironment(secondClaim.claim);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "claude-code-oauth-token",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after).not.toHaveProperty("selectedModel");
    expect(after).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-4-6",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-4-6",
    );
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);

    const { providerId: openRouterProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openrouter-api-key",
        secret: "rerouted-openrouter-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openRouterProviderId,
      },
    ]);

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the upstream provider changes",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(claimEnvironment(thirdClaim.claim).ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "openrouter-api-key",
        "OPENROUTER_API_KEY",
      ),
    );
    expect(thirdClaim.claim.cliAgentType).toBe("claude-code");
    expect(thirdClaim.claim.resumeSession).toBeNull();
    await completeChatRunOk(third.runId, thirdClaim.sandboxHeaders);
    const rotatedBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(rotatedBinding.agent_session_id).not.toBe(
      originalBinding.agent_session_id,
    );
    expect(rotatedBinding).toMatchObject({
      agent_session_run_id: third.runId,
      run_session_id: rotatedBinding.agent_session_id,
    });
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-4-6",
    );

    const fourth = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after the canonical session rotates",
    });
    const fourthBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(fourthBinding).toMatchObject({
      agent_session_id: rotatedBinding.agent_session_id,
      agent_session_run_id: fourth.runId,
      run_session_id: rotatedBinding.agent_session_id,
    });
    const fourthClaim = await claimChatRun(runnerGroup, fourth.runId);
    expect(fourthClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${third.runId}`,
    );
    await cancelChatRun(actor, fourth.runId);
  }, 90_000);

  it("rejects invalid model selections without creating visible state", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid model selection agent",
    });

    // Chat send only accepts supported run models.
    const vm0ThreadId = randomUUID();
    const invalidModel = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unsupported vm0 model",
        clientThreadId: vm0ThreadId,
        model: "codex",
      },
      [400],
    );
    expectApiError(invalidModel.body);
    expect(invalidModel.body.error.message).toBe(
      "model: Invalid model selection",
    );
    await chat.requestReadThread(actor, vm0ThreadId, [404]);

    const unavailableThreadId = randomUUID();
    const unavailable = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a supported model outside workspace policy",
        clientThreadId: unavailableThreadId,
        model: "gpt-5.6-terra",
      },
      [400],
    );
    expectApiError(unavailable.body);
    expect(unavailable.body.error.message).toBe(
      "The selected model is not available in this workspace",
    );
    await chat.requestReadThread(actor, unavailableThreadId, [404]);

    // Removed sentinel models fail contract validation.
    for (const selectedModel of [
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
    ]) {
      const removedThreadId = randomUUID();
      const removed = await chat.requestSendMessage(
        actor,
        {
          agentId: agent.agentId,
          prompt: `removed ${selectedModel}`,
          clientThreadId: removedThreadId,
          model: selectedModel,
        },
        [400],
      );
      expectApiError(removed.body);
      expect(removed.body.error).toMatchObject({
        code: "BAD_REQUEST",
        message: "model: Invalid model selection",
      });
      await chat.requestReadThread(actor, removedThreadId, [404]);
    }

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);
});

describe("CHAT-02: incomplete-round context", () => {
  it("injects incomplete rounds and truncates old content chronologically", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "first incomplete",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await failChatRun(first.runId, firstClaim.sandboxHeaders, "boom one");
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the failed run to retain its session binding");
    }

    const longPrompt = `second ${"x".repeat(4100)}`;
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: longPrompt,
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await failChatRun(second.runId, secondClaim.sandboxHeaders, "boom two");
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: second.runId,
      run_session_id: firstBinding.agent_session_id,
    });

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after two failures",
    });
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: third.runId,
      run_session_id: firstBinding.agent_session_id,
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended.split("RUN_STATUS: failed")).toHaveLength(3);
    expect(appended).toContain("User: first incomplete");
    expect(appended.indexOf("User: first incomplete")).toBeLessThan(
      appended.indexOf("User: second"),
    );
    expect(appended).toContain("...[truncated]");
    expect(appended).not.toContain("retry after two failures");
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: initial thinking indicator", () => {
  it("persists a fast assistant thinking marker with paragraphs for active web chat runs", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");

    let thinkingAuthorization: string | null = null;
    let thinkingPromptPayload = "";
    const titleResponse = "Launch Checklist";
    const thinkingResponse =
      "Reviewing the launch request and recent context.\n\nOrganizing the checklist into practical sections before the main response starts.";
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          let responseContent = "Unrelated completion";
          if (systemContent.includes("Generate a short, descriptive title")) {
            responseContent = titleResponse;
          }
          if (systemContent.includes("Write user-visible progress copy")) {
            thinkingAuthorization = request.headers.get("authorization");
            thinkingPromptPayload = payload.messages
              .map((message) => {
                return message.content;
              })
              .join("\n\n");
            responseContent = thinkingResponse;
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: responseContent },
              },
            ],
          });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Draft a launch checklist",
    });

    const page = await waitForThreadMessages(actor, run.threadId, (items) => {
      return assistantMessages(items).some((message) => {
        return (
          message.runId === run.runId &&
          message.content === null &&
          message.thinking === thinkingResponse
        );
      });
    });
    await waitForThreadTitle(actor, run.threadId, titleResponse);
    const marker = assistantMessages(page.messages).find((message) => {
      return (
        message.runId === run.runId && message.thinking === thinkingResponse
      );
    });
    expect(marker).toMatchObject({
      role: "assistant",
      content: null,
      runId: run.runId,
      runEventId: "thinking:initial",
      thinking: thinkingResponse,
    });
    expect(thinkingAuthorization).toBe("Bearer thinking-key");
    expect(thinkingPromptPayload).toContain("few short paragraphs");
    expect(thinkingPromptPayload).toContain(
      "Match the current user's language",
    );
    expect(thinkingPromptPayload).toContain("Draft a launch checklist");
    await flushWaitUntilForTest();
    expect(firstAssistantMessageEventsForRun(run.runId)).toStrictEqual([]);

    await cancelChatRun(actor, run.runId);
  });
});

describe("CHAT-02: prior rounds and thread titles", () => {
  it("carries prior completed rounds, generates the thread title, and accepts immutable follow-up revokes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "title-key");
    let upstreamAuthorization: string | null = null;
    let titleRequests = 0;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          upstreamAuthorization = request.headers.get("authorization");
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (systemContent.includes("concise follow-up prompts")) {
            return HttpResponse.json({
              choices: [
                {
                  message: {
                    content: JSON.stringify([
                      { prompt: "Summarize the migration steps", kind: "talk" },
                    ]),
                  },
                },
              ],
            });
          }
          if (systemContent.includes("Generate a short, descriptive title")) {
            titleRequests += 1;
            return HttpResponse.json({
              choices: [{ message: { content: "**Migration Plan**" } }],
            });
          }
          return HttpResponse.json({
            choices: [{ message: { content: "Generated summary" } }],
          });
        },
      ),
    );

    const firstPrompt = "plan the API migration";
    const first = await sendChatRun(actor, { agentId, prompt: firstPrompt });
    await waitForThreadTitle(actor, first.threadId, "Migration Plan");
    expect(titleRequests).toBe(1);
    expect(upstreamAuthorization).toBe("Bearer title-key");

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Assistant migration answer"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterFirst = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return recommendedFollowupMessages(items, first.runId).some(
          (message) => {
            return (message.recommendedFollowups?.length ?? 0) > 0;
          },
        );
      },
    );
    const recommender = recommendedFollowupMessages(
      afterFirst.messages,
      first.runId,
    ).find((message) => {
      return (message.recommendedFollowups?.length ?? 0) > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups message");
    }
    expect(recommender.runLifecycleEvent).toBeUndefined();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow-up question",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Migration Plan");
    expect(titleRequests).toBe(1);
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(`- LOG_COMMAND: zero logs ${first.runId} --all`);
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain("Assistant: Assistant migration answer");
    expect(appended).toContain("- RELATIVE_INDEX: 0");
    expect(appended).not.toContain("follow-up question");

    await cancelChatRun(actor, second.runId);

    await chat.renameThread(actor, first.threadId, "Manual Migration Title");
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "manual title should stay",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Manual Migration Title");
    expect(titleRequests).toBe(1);
    await cancelChatRun(actor, third.runId);

    const normalFollowup = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "use the recommended follow-up",
        revokesMessageId: recommender.id,
      },
      [201],
    );
    if (normalFollowup.status !== 201) {
      throw new Error("Expected recommended follow-up send to succeed");
    }
    const normalFollowupRunId = normalFollowup.body.runId;
    if (normalFollowupRunId === null) {
      throw new Error("Expected recommended follow-up send to create a run");
    }
    const afterFollowup = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesMessageId === recommender.id &&
            message.runId === normalFollowupRunId
          );
        });
      },
    );
    expect(
      userMessages(afterFollowup.messages).some((message) => {
        return message.revokesMessageId === recommender.id;
      }),
    ).toBeTruthy();
    await cancelChatRun(actor, normalFollowupRunId);
  }, 90_000);
});

describe("CHAT-02: generation templates and attachments", () => {
  it("uses the structured message document for the enabled runtime path", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.StructuredPrompt]: true },
    );

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const fileId = randomUUID();
    const referencedThreadId = randomUUID();
    const mailDraftId = randomUUID();
    const feedbackPrompt =
      `Feedback on 2 parts of an email draft (mail draft ID: ${mailDraftId}):\n\n` +
      "> First quote\n\nClarify this point\n\n---\n\n" +
      `> Second quote\n\nAdd supporting evidence from [Roadmap](/chats/${referencedThreadId})`;
    const prompt =
      `Review [Roadmap](/chats/${referencedThreadId}) now\n\n` + feedbackPrompt;
    const displayText = [
      `[Template: ${style.title}]`,
      "[File: brief.pdf]",
      "Review [Chat thread: Roadmap] now",
      feedbackPrompt,
    ].join("\n\n");
    const structuredPrompt: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        {
          type: "file",
          fileId,
          filenameSnapshot: "brief.pdf",
          contentType: "application/pdf",
        },
        { type: "text", text: "Review " },
        {
          type: "chat_thread",
          threadId: referencedThreadId,
          titleSnapshot: "Roadmap",
        },
        { type: "text", text: " now" },
        {
          type: "feedback",
          quote: "First quote",
          note: [{ type: "text", text: "Clarify this point" }],
          source: {
            type: "mail",
            id: mailDraftId,
            status: "draft",
          },
        },
        {
          type: "feedback",
          quote: "Second quote",
          note: [
            { type: "text", text: "Add supporting evidence from " },
            {
              type: "chat_thread",
              threadId: referencedThreadId,
              titleSnapshot: "Roadmap",
            },
          ],
          source: {
            type: "mail",
            id: mailDraftId,
            status: "draft",
          },
        },
      ],
    };

    const sent = await sendChatRun(actor, {
      agentId,
      prompt,
      structuredPrompt,
      generationTemplate,
      attachFiles: [
        {
          id: fileId,
          filename: "brief.pdf",
          contentType: "application/pdf",
          size: 42,
        },
      ],
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `Select ${style.title} illustration template`,
        `[Web file] brief.pdf (application/pdf)\n   [ID] ${fileId}`,
        prompt,
      ].join("\n\n"),
    );
    expect(run.appendSystemPrompt).toContain("# Artifact Template Context");
    expect(run.appendSystemPrompt).toContain(style.illustrationStyleId);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.messages).find((item) => {
      return item.runId === sent.runId;
    });
    expect(message).toMatchObject({
      content: displayText,
      structuredPrompt,
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("falls back to the legacy runtime path for enabled old clients", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.StructuredPrompt]: true },
    );

    const fileId = randomUUID();
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "legacy client attachment",
      attachFiles: [
        {
          id: fileId,
          filename: "legacy.txt",
          contentType: "text/plain",
          size: 12,
        },
      ],
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        "legacy client attachment",
        `[Web file] legacy.txt (text/plain)\n   [ID] ${fileId}`,
      ].join("\n\n"),
    );
    await cancelChatRun(actor, sent.runId);
  }, 60_000);

  it("renders generation template guidance into the run system prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }

    const presentation = await sendChatRun(actor, {
      agentId,
      prompt: "make a launch deck",
      generationTemplate: {
        type: "presentation",
        selection: {
          colorSystemId: template.colorSystemId,
          templateId: template.templateId,
        },
      },
    });
    const presentationRun = await api.readRun(actor, presentation.runId);
    expect(presentationRun.prompt).toBe("make a launch deck");
    const presentationPrompt = presentationRun.appendSystemPrompt ?? "";
    expect(presentationPrompt).toContain("# Artifact Template Context");
    expect(presentationPrompt).toContain(
      "The user deliberately selected this artifact template",
    );
    expect(presentationPrompt).toContain(
      "It does not force you to generate: the user's prompt decides the task",
    );
    expect(presentationPrompt).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(presentationPrompt).not.toContain("Selected design system");
    // Runbook flow: pull the selected self-contained runbook package; the
    // retired multi-resource generation command is not surfaced.
    expect(presentationPrompt).toContain(
      `zero resource pull ${template.templateId}-runbook --dir ./generated/resources`,
    );
    if (template.colorSystemId) {
      const colorToken = template.colorSystemId
        .replace("color-system:", "")
        .replaceAll("-", "_");
      expect(presentationPrompt).toContain(`"colorSystem": "${colorToken}"`);
    }
    expect(presentationPrompt).toContain(
      "all user-visible slide content, with the first slide visible before JavaScript runs",
    );
    expect(presentationPrompt).toContain("--artifact-kind presentation-html");
    expect(presentationPrompt).not.toContain(
      "zero generate presentation --design-system",
    );
    expect(presentationPrompt).not.toContain("- Artifact type: presentation");
    await cancelChatRun(actor, presentation.runId);

    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!videoTemplate) {
      throw new Error("Expected the epic-grandeur video template");
    }
    const video = await sendChatRun(actor, {
      agentId,
      prompt: "make a product video",
      generationTemplate: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const videoRun = await api.readRun(actor, video.runId);
    const videoPrompt = videoRun.appendSystemPrompt ?? "";
    expect(videoPrompt).toContain("# Artifact Template Context");
    expect(videoPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(videoPrompt).toContain(
      `zero generate video --provider built-in --template ${videoTemplate.id}`,
    );
    await cancelChatRun(actor, video.runId);

    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0];
    if (!websiteTemplate) {
      throw new Error("Expected a registered website template");
    }
    const website = await sendChatRun(actor, {
      agentId,
      prompt: "make a campaign landing page",
      generationTemplate: {
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      },
    });
    const websiteRun = await api.readRun(actor, website.runId);
    const websitePrompt = websiteRun.appendSystemPrompt ?? "";
    expect(websitePrompt).toContain("# Artifact Template Context");
    expect(websitePrompt).toContain(
      `Template: ${websiteTemplate.title} (${websiteTemplate.id})`,
    );
    expect(websitePrompt).toContain(
      `zero resource pull ${websiteTemplate.resourceId} --dir ./generated/resources`,
    );
    expect(websitePrompt).toContain(
      `./generated/resources/${websiteTemplate.sourcePath}/render.mjs`,
    );
    expect(websitePrompt).toContain(
      `./generated/resources/${websiteTemplate.sourcePath}/resolve-images.mjs`,
    );
    expect(websitePrompt).toContain("zero host <output-dir> --site <slug>");
    await cancelChatRun(actor, website.runId);

    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.WebsiteTemplateV2]: true },
    );
    const websiteV2 = await sendChatRun(actor, {
      agentId,
      prompt: "make a v2 campaign landing page",
      generationTemplate: {
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      },
    });
    const websiteV2Run = await api.readRun(actor, websiteV2.runId);
    const websiteV2Prompt = websiteV2Run.appendSystemPrompt ?? "";
    expect(websiteV2Prompt).toContain(
      "zero resource pull template:black-slabs-v2 --dir ./generated/resources",
    );
    expect(websiteV2Prompt).toContain(
      `./generated/resources/${websiteTemplate.sourcePath}/render.mjs`,
    );
    await cancelChatRun(actor, websiteV2.runId);
  }, 90_000);

  it("switches an illustration run from GitHub to R2 through the user feature switch", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.illustrationStyleId === "image-style:ink-storefront";
    });
    if (!style) {
      throw new Error("Expected the ink-storefront illustration style");
    }

    const githubRun = await sendChatRun(actor, {
      agentId,
      prompt: "draw a flower shop",
      generationTemplate: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const githubPrompt =
      (await api.readRun(actor, githubRun.runId)).appendSystemPrompt ?? "";
    expect(githubPrompt).toContain(
      "Style source: vm0-ai/vm0-skills@main:illustration-template/ink-storefront",
    );
    expect(githubPrompt).not.toContain("private R2 registry resource");
    expect(githubPrompt).not.toContain("--style-source r2");
    await cancelChatRun(actor, githubRun.runId);

    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.ImageStyleR2]: true },
    );

    const r2Run = await sendChatRun(actor, {
      agentId,
      prompt: "draw a flower shop from R2",
      generationTemplate: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const r2Prompt =
      (await api.readRun(actor, r2Run.runId)).appendSystemPrompt ?? "";
    expect(r2Prompt).toContain(
      "Style source: private R2 registry resource image-style:ink-storefront",
    );
    expect(r2Prompt).toContain("--compile --style-source r2");
    expect(r2Prompt).toContain(
      "If the R2 source is unavailable, stop without generating; do not fall back to GitHub.",
    );
    expect(r2Prompt).not.toContain(
      "Style source: vm0-ai/vm0-skills@main:illustration-template/ink-storefront",
    );
    await cancelChatRun(actor, r2Run.runId);

    const githubOnlyRun = await sendChatRun(actor, {
      agentId,
      prompt: "draw a chibi hero",
      generationTemplate: {
        type: "illustration",
        selection: { illustrationStyleId: "image-style:chibi-hero" },
      },
    });
    const githubOnlyPrompt =
      (await api.readRun(actor, githubOnlyRun.runId)).appendSystemPrompt ?? "";
    expect(githubOnlyPrompt).toContain(
      "Style source: vm0-ai/vm0-skills@main:illustration-template/chibi-hero",
    );
    expect(githubOnlyPrompt).not.toContain("private R2 registry resource");
    expect(githubOnlyPrompt).not.toContain("--style-source r2");
    await cancelChatRun(actor, githubOnlyRun.runId);
  }, 90_000);

  it("is one-shot: a follow-up without re-attaching the style gets no template context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }

    // Turn 1: the user explicitly attaches the style — the live block is present.
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "draw a fox",
      generationTemplate: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const firstPrompt = (await api.readRun(actor, first.runId))
      .appendSystemPrompt;
    expect(firstPrompt).toContain("# Artifact Template Context");
    expect(firstPrompt).toContain(
      `zero generate image --provider built-in --style ${style.illustrationStyleId} --prompt "<user request>" --compile`,
    );
    expect(firstPrompt).toContain("Follow the returned packet completely");
    expect(firstPrompt).toContain(
      "If the source is unavailable, stop without generating",
    );
    expect(firstPrompt).toContain("--compiled-prompt");
    expect(firstPrompt).toContain(style.illustrationStyleId);

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "here is a fox")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "here is a fox";
      });
    });

    // Turn 2: a follow-up without re-attaching the style gets no template
    // context.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "another one",
    });
    const secondPrompt = (await api.readRun(actor, second.runId))
      .appendSystemPrompt;
    expect(secondPrompt).not.toContain("# Artifact Template Context");
    expect(secondPrompt).toContain("# Web Chat Run Context");
    expect(secondPrompt).not.toContain("Selected a template");
    expect(secondPrompt).not.toContain(style.illustrationStyleId);
    await waitForRunUserMessage(
      actor,
      first.threadId,
      second.runId,
      "another one",
    );
    await cancelChatRun(actor, second.runId);

    // Turn 3: attaching a video preset now only resolves the video template live
    // — templates no longer merge across turns or types.
    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!videoTemplate) {
      throw new Error("Expected the epic-grandeur video template");
    }
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "now make a video",
      generationTemplate: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const thirdPrompt = (await api.readRun(actor, third.runId))
      .appendSystemPrompt;
    expect(thirdPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(thirdPrompt).toContain(
      `zero generate video --provider built-in --template ${videoTemplate.id}`,
    );
    expect(thirdPrompt).toContain("# Incomplete Rounds Context");
    expect(thirdPrompt).not.toContain("# Web Chat Run Context");
    // The illustration style is gone entirely for this turn: it's not attached
    // to this message, and prior/incomplete context no longer repeats template
    // selections.
    expect(thirdPrompt).not.toContain(
      `zero generate image --provider built-in --style ${style.illustrationStyleId} --prompt "<user request>" --compile`,
    );
    expect(thirdPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, third.runId);

    // A brand-new thread starts clean: neither template carries over.
    const fresh = await sendChatRun(actor, { agentId, prompt: "draw a cat" });
    const freshPrompt = (await api.readRun(actor, fresh.runId))
      .appendSystemPrompt;
    expect(freshPrompt).not.toContain("# Artifact Template Context");
    // The base agent prompt always carries generic `zero generate` guidance, so
    // assert the absence of the template-specific command, not the bare verb.
    expect(freshPrompt).not.toContain(
      "zero generate image --provider built-in --style",
    );
    expect(freshPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, fresh.runId);
  }, 120_000);

  it("injects workflow templates as one-shot context without prior template selections", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    const workflowTemplate = WORKFLOW_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    if (!workflowTemplate) {
      throw new Error("Expected a registered workflow template");
    }

    const illustration = await sendChatRun(actor, {
      agentId,
      prompt: "draw a labeled inbox",
      generationTemplate: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const illustrationPrompt = (await api.readRun(actor, illustration.runId))
      .appendSystemPrompt;
    expect(illustrationPrompt).toContain("# Artifact Template Context");
    expect(illustrationPrompt).toContain(style.illustrationStyleId);
    await cancelChatRun(actor, illustration.runId);

    const workflow = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "create the workflow version",
      generationTemplate: {
        type: "workflow",
        selection: { workflowTemplateId: workflowTemplate.id },
      },
    });
    const workflowPrompt = (await api.readRun(actor, workflow.runId))
      .appendSystemPrompt;
    expect(workflowPrompt).toContain("# Workflow Template Context");
    expect(workflowPrompt).toContain(
      `Auto-inbox label (${workflowTemplate.id})`,
    );
    expect(workflowPrompt).toContain("Use the workflow-setup skill");
    expect(workflowPrompt).toContain(
      "Save the reusable workflow draft as soon as the template behavior is clear.",
    );
    expect(workflowPrompt).not.toContain("Before creating anything");
    expect(workflowPrompt).toContain("Gmail label-applied automation");
    expect(workflowPrompt).not.toContain("# Artifact Template Context");
    // The illustration run was cancelled, so only its message text is replayed
    // via "# Incomplete Rounds Context"; the style id is not.
    expect(workflowPrompt).toContain("# Incomplete Rounds Context");
    expect(workflowPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, workflow.runId);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "continue the thread",
    });
    const followUpPrompt = (await api.readRun(actor, followUp.runId))
      .appendSystemPrompt;
    // No explicit selection this turn, so there is no live block for either
    // type. Both earlier runs were cancelled, so the general "# Web Chat Run
    // Context" replay is suppressed in favor of resuming the existing session
    // (see prepareRecentChatContext).
    expect(followUpPrompt).not.toContain("# Workflow Template Context");
    expect(followUpPrompt).not.toContain(workflowTemplate.id);
    expect(followUpPrompt).not.toContain("# Artifact Template Context");
    expect(followUpPrompt).not.toContain("# Web Chat Run Context");
    expect(followUpPrompt).toContain("# Incomplete Rounds Context");
    expect(followUpPrompt).not.toContain("Selected a template");
    expect(followUpPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, followUp.runId);
  }, 120_000);

  it("rejects unknown generation template selections", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid template agent",
    });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }

    const arms: readonly {
      readonly generationTemplate: GenerationTemplateRequest;
      readonly message: string;
    }[] = [
      {
        generationTemplate: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        // A runbook with an unknown color system is still rejected by the
        // runbook flow.
        generationTemplate: {
          type: "presentation",
          selection: {
            colorSystemId: "color-system:missing",
            templateId: template.templateId,
          },
        },
        message: "Unknown generation template color system",
      },
      {
        // A runbook id without a package is unknown; presentations are
        // runbook-only, so there is no separate "wrong target type" path.
        generationTemplate: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        generationTemplate: {
          type: "video",
          selection: { stylePresetId: "video-style:missing" },
        },
        message: "Unknown video template",
      },
      {
        generationTemplate: {
          type: "workflow",
          selection: { workflowTemplateId: "workflow-template:missing" },
        },
        message: "Unknown workflow template",
      },
      {
        generationTemplate: {
          type: "website",
          selection: { websiteTemplateId: "website-template:missing" },
        },
        message: "Unknown website template",
      },
    ];
    for (const arm of arms) {
      const rejected = await chat.requestSendMessage(
        actor,
        {
          agentId: agent.agentId,
          prompt: "make something from a bad template",
          generationTemplate: arm.generationTemplate,
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toBe(arm.message);
    }

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);

  it("persists attachments and injects them into the run prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const filename = "diagram final 100%.png";

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read this file",
      attachFiles: [
        { id: fileId, filename, contentType: "image/png", size: 42 },
      ],
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filename} (image/png)`);
    expect(created.prompt).toContain(`[ID] ${fileId}`);
    expect(created.appendSystemPrompt).toContain("zero web download-file -h");
    expect(created.appendSystemPrompt).toContain("zero web upload-file -h");

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (message.attachFiles?.length ?? 0) > 0;
        });
      },
    );
    const attached = userMessages(messages.messages)[0]?.attachFiles?.[0];
    expect(attached).toMatchObject({
      id: fileId,
      filename,
      contentType: "image/png",
      size: 42,
      url: expect.stringContaining(`${fileId}/diagram_final_100_.png`),
    });
    await cancelChatRun(actor, run.runId);
  }, 60_000);
});

describe("CHAT-02: queued attachments on auto-send", () => {
  it("preserves structured part order when a queued message is promoted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.StructuredPrompt]: true },
    );

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the structured queue item",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const queuedId = randomUUID();
    const queuedPrompt =
      "queued structured text\n\n" +
      "Feedback on this part of your reply:\n\n" +
      "> Queued quote\n\nRevise after the anchor completes";
    const structuredPrompt: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId,
          filenameSnapshot: "ordered.txt",
          contentType: "text/plain",
        },
        { type: "text", text: "queued structured text" },
        {
          type: "feedback",
          quote: "Queued quote",
          note: [{ type: "text", text: "Revise after the anchor completes" }],
        },
      ],
    };
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: queuedPrompt,
        structuredPrompt,
        clientMessageId: queuedId,
        attachFiles: [
          {
            id: fileId,
            filename: "ordered.txt",
            contentType: "text/plain",
            size: 12,
          },
        ],
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the structured queued message to auto-send");
    }
    expect(promoted.structuredPrompt).toStrictEqual(structuredPrompt);

    const run = await api.readRun(actor, promoted.runId);
    expect(run.prompt).toBe(
      [
        `[Web file] ordered.txt (text/plain)\n   [ID] ${fileId}`,
        queuedPrompt,
      ].join("\n\n"),
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("carries queued attachments into the auto-sent follow-up run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the queued attachment",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const queuedId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued with attachment",
        clientMessageId: queuedId,
        attachFiles: [
          {
            id: fileId,
            filename: "notes.txt",
            contentType: "text/plain",
            size: 12,
          },
        ],
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Completing the anchor run promotes the queued message into a fresh
    // run whose prompt carries the resolved attachment references.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to auto-send into a run");
    }
    expect(promoted.content).toBe("queued with attachment");
    expect(promoted.attachFiles?.[0]).toMatchObject({
      id: fileId,
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: expect.stringContaining(`${fileId}/notes.txt`),
    });
    const original = userMessages(messages.messages).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original).toMatchObject({
      id: queuedId,
      content: "queued with attachment",
    });
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queued with attachment");
    expect(followUp.prompt).toContain("[Web file] notes.txt (text/plain)");
    expect(followUp.prompt).toContain(`[ID] ${fileId}`);
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02/FILE-03: computer-use host grants", () => {
  it("grants computer-use capability only for a selected host", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { hostId, hostToken } = await cu.startComputerUseHost(actor);

    // The thread's sticky host is not exposed by any read route, so the
    // grant is observed through the run token issued to each claim: a
    // granted token can create write commands on the host, an ungranted
    // token cannot, and no run token can ever post chat sends.
    const plain = await sendChatRun(actor, {
      agentId,
      prompt: "no computer use selected",
    });
    const plainClaim = await claimChatRun(runnerGroup, plain.runId);
    const plainToken = zeroTokenFromClaim(plainClaim.claim);
    const deniedCommand = await cu.requestCreateComputerUseWriteCommand(
      { bearer: plainToken },
      [403],
    );
    expect(deniedCommand.status).toBe(403);
    const deniedSend = await requestSendMessageWithBearer(
      plainToken,
      { agentId, prompt: "sandbox tokens cannot chat" },
      [403],
    );
    expectApiError(deniedSend.body);
    expect(deniedSend.body.error.message).toContain("agent-run:write");
    await cancelChatRun(actor, plain.runId);

    // Selecting an online host pins it to the thread and grants the run
    // token computer-use write access on that host.
    const granted = await sendChatRun(actor, {
      agentId,
      prompt: "open the remote browser",
      computerUseHostId: hostId,
    });
    const grantedRun = await api.readRun(actor, granted.runId);
    expect(grantedRun.appendSystemPrompt).toContain("# Computer Use");
    expect(grantedRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on Zero Desktop.",
    );
    expect(grantedRun.appendSystemPrompt).not.toContain(hostId);
    const grantedClaim = await claimChatRun(runnerGroup, granted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(grantedClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, granted.runId);

    // Follow-up sends without the field stay granted via the sticky host.
    const sticky = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "keep using the same host",
    });
    const stickyClaim = await claimChatRun(runnerGroup, sticky.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(stickyClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, sticky.runId);

    // An explicit null clears the sticky host: the next run on the same
    // thread is no longer granted.
    const cleared = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "drop the host",
      computerUseHostId: null,
    });
    const clearedClaim = await claimChatRun(runnerGroup, cleared.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(clearedClaim.claim) },
      [403],
    );
    await cancelChatRun(actor, cleared.runId);

    mockNow(now() + 91_000);
    const staleGranted = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "use the computer after it went offline",
      computerUseHostId: hostId,
    });
    const staleRun = await api.readRun(actor, staleGranted.runId);
    expect(staleRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on Zero Desktop.",
    );
    clearMockNow();
    const staleClaim = await claimChatRun(runnerGroup, staleGranted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: zeroTokenFromClaim(staleClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, staleGranted.runId);
  }, 120_000);

  it("rejects unusable computer-use host selections", async () => {
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use guard agent",
    });

    const unknownHost = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unknown host",
        computerUseHostId: randomUUID(),
      },
      [404],
    );
    expectApiError(unknownHost.body);
    expect(unknownHost.body.error.message).toBe("Computer-use host not found");

    // Stopping a host revokes it, so an explicit selection reports it as
    // missing rather than offline, and clears any thread binding immediately.
    const stopped = await cu.startComputerUseHost(actor);
    const stoppedPinned = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin the host before stopping it",
        computerUseHostId: stopped.hostId,
      },
      [201],
    );
    if (stoppedPinned.status !== 201) {
      throw new Error("Expected the stopped-host pin send to be accepted");
    }
    await cu.stopComputerUseHost(stopped.hostToken);
    await expect(
      readThreadComputerUseHostId(actor, stoppedPinned.body.threadId),
    ).resolves.toBeNull();
    const revokedHost = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stopped host",
        computerUseHostId: stopped.hostId,
      },
      [404],
    );
    expectApiError(revokedHost.body);
    expect(revokedHost.body.error.message).toBe("Computer-use host not found");

    // Installation-backed hosts stop as temporary offline devices, so thread
    // bindings survive and reconnect to the same host id on the next start.
    const installationId = randomUUID();
    const installed = await cu.startComputerUseHost(actor, { installationId });
    const installedPinned = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin the durable host before stopping it",
        computerUseHostId: installed.hostId,
      },
      [201],
    );
    if (installedPinned.status !== 201) {
      throw new Error("Expected the installed-host pin send to be accepted");
    }
    await cu.stopComputerUseHost(installed.hostToken);
    await expect(
      readThreadComputerUseHostId(actor, installedPinned.body.threadId),
    ).resolves.toBe(installed.hostId);
    const stoppedInstalledHost = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: installedPinned.body.threadId,
        prompt: "use a stopped durable host",
        computerUseHostId: installed.hostId,
      },
      [201],
    );
    expect(stoppedInstalledHost.body).toMatchObject({
      threadId: installedPinned.body.threadId,
    });
    const reconnected = await cu.startComputerUseHost(actor, {
      installationId,
    });
    expect(reconnected.hostId).toBe(installed.hostId);

    // A valid sticky host remains usable for later non-explicit sends.
    const survivor = await cu.startComputerUseHost(actor);
    const survivorThread = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin a host for a later sticky send",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    if (survivorThread.status !== 201) {
      throw new Error("Expected the survivor send to be accepted");
    }

    // A host that stopped heartbeating goes stale-offline (status still
    // online, not revoked), but explicit selections are still accepted so the
    // run can use the host if it reconnects while running.
    mockNow(now() + 91_000);
    const offlineHostSend = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stale host",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    expect(offlineHostSend.body).toMatchObject({ runId: null });

    // The sticky-host fallthrough also tolerates a stale host instead of
    // failing: a send without the field on the pinned thread is accepted.
    const staleStickySend = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: survivorThread.body.threadId,
        prompt: "send while the sticky host is stale",
      },
      [201],
    );
    clearMockNow();
    expect(staleStickySend.body).toMatchObject({
      threadId: survivorThread.body.threadId,
    });
  }, 90_000);
});

describe("CHAT-02: shared user message queue", () => {
  it("dispatches idle-thread sends by appending a run-associated replacement", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const messageId = randomUUID();
    const structuredPrompt: UserMessageDocument = {
      version: 1,
      parts: [
        { type: "text", text: "queue-first " },
        {
          type: "chat_thread",
          threadId: randomUUID(),
          titleSnapshot: "direct dispatch",
        },
      ],
    };
    const sent = await chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt: "queue-first direct dispatch",
        structuredPrompt,
        clientMessageId: messageId,
      },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected an idle-thread queue-first send to dispatch");
    }
    const runId = sent.body.runId;

    // The queued row stays immutable. Claiming appends the run-associated
    // replacement and links it back to the queued row.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === messageId && message.runId === runId
          );
        });
      },
    );
    const rows = userMessages(messages.messages);
    expect(rows).toHaveLength(2);
    const claimed = rows.find((message) => {
      return message.revokesMessageId === messageId;
    });
    expect(claimed).toMatchObject({
      content: "queue-first direct dispatch",
      structuredPrompt,
      runId,
      revokesMessageId: messageId,
    });
    expect(claimed?.id).not.toBe(messageId);
    const queued = rows.find((message) => {
      return message.id === messageId;
    });
    if (!queued) {
      throw new Error("Expected the queued message");
    }
    expect(queued).toMatchObject({
      id: messageId,
      content: "queue-first direct dispatch",
      structuredPrompt,
    });
    expect(queued.runId).toBeUndefined();

    const replay = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "queue-first direct dispatch",
        clientMessageId: messageId,
      },
      [201],
    );
    expect(replay.body).toStrictEqual(sent.body);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${sent.body.threadId}`;
        });
      })
      .toBe(true);

    const claimedRun = await claimChatRun(runnerGroup, runId);
    expect(claimedRun.claim.prompt).toBe("queue-first direct dispatch");
    await expect
      .poll(() => {
        return apiDispatchActionTypes(apiDispatchTimingEventsForRun(runId)).has(
          "api_dispatch_claim_queue_first_message",
        );
      })
      .toBe(true);

    await cancelChatRun(actor, runId);
  }, 90_000);

  it("preserves real-agent preview mode across queued auto-sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "preview override queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const previewMessageId = randomUUID();
    const previewQueued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued real-agent preview run",
        clientMessageId: previewMessageId,
        realAgentInPreview: true,
      },
      [201],
    );
    expect(previewQueued.body).toMatchObject({ runId: null });

    const mockMessageId = randomUUID();
    const mockQueued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued preview mock run",
        clientMessageId: mockMessageId,
      },
      [201],
    );
    expect(mockQueued.body).toMatchObject({ runId: null });

    // Terminal callbacks and the cleanup safety sweep use the same queued
    // auto-send builder; finishing the anchor guarantees that builder owns both.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const previewMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === previewMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const previewRunId = userMessages(previewMessages.messages).find(
      (message) => {
        return message.revokesMessageId === previewMessageId;
      },
    )?.runId;
    if (!previewRunId) {
      throw new Error("Expected the preview override message to auto-send");
    }

    const previewClaim = await claimChatRun(runnerGroup, previewRunId);
    expect(previewClaim.claim.prompt).toBe("queued real-agent preview run");
    expect(previewClaim.claim.realAgentInPreview).toBeTruthy();
    await cancelChatRun(actor, previewRunId);

    const mockMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === mockMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const mockRunId = userMessages(mockMessages.messages).find((message) => {
      return message.revokesMessageId === mockMessageId;
    })?.runId;
    if (!mockRunId) {
      throw new Error("Expected the default preview message to auto-send");
    }

    const mockClaim = await claimChatRun(runnerGroup, mockRunId);
    expect(mockClaim.claim.prompt).toBe("queued preview mock run");
    expect(mockClaim.claim.realAgentInPreview).toBeUndefined();
    await cancelChatRun(actor, mockRunId);
  }, 90_000);

  it("appends a claimed queued message after messages that are still queued", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "multiple queue order anchor",
    });

    const firstId = randomUUID();
    const firstPrompt = "first queued transcript message";
    const first = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: firstPrompt,
        clientMessageId: firstId,
      },
      [201],
    );
    expect(first.body).toMatchObject({ runId: null });

    const secondId = randomUUID();
    const secondPrompt = "second queued transcript message";
    const second = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: secondPrompt,
        clientMessageId: secondId,
      },
      [201],
    );
    expect(second.body).toMatchObject({ runId: null });

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === firstId && message.runId !== undefined
          );
        });
      },
    );
    const users = userMessages(messages.messages);
    const firstOriginal = users.find((message) => {
      return message.id === firstId;
    });
    const firstClaimed = users.find((message) => {
      return message.revokesMessageId === firstId;
    });
    if (!firstOriginal || !firstClaimed?.runId) {
      throw new Error("Expected the first queued message to be claimed");
    }
    expect(Date.parse(firstClaimed.createdAt)).toBeGreaterThan(
      Date.parse(firstOriginal.createdAt),
    );

    const replacedIds = new Set(
      users.flatMap((message) => {
        return message.revokesMessageId ? [message.revokesMessageId] : [];
      }),
    );
    const visibleQueuedPrompts = users
      .filter((message) => {
        return (
          !replacedIds.has(message.id) &&
          (message.content === firstPrompt || message.content === secondPrompt)
        );
      })
      .map((message) => {
        return message.content;
      });
    expect(visibleQueuedPrompts).toStrictEqual([secondPrompt, firstPrompt]);

    await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesMessageId: secondId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    await cancelChatRun(actor, firstClaimed.runId);
  }, 90_000);

  it("dispatches an idle send while thread-list publication is pending", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const publicationStarted = createDeferredPromise<void>(context.signal);
    const releasePublication = createDeferredPromise<void>(context.signal);
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "threadListChanged") {
        if (!publicationStarted.settled()) {
          publicationStarted.resolve(undefined);
        }
        return releasePublication.promise;
      }
      return Promise.resolve(undefined);
    });

    const prompt = "dispatch while thread list publication is pending";
    const send = chat.requestSendMessage(
      actor,
      {
        agentId,
        prompt,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    let sendSettled = false;
    const sendOutcome = send.then(
      (value) => {
        sendSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        sendSettled = true;
        return { ok: false as const, error };
      },
    );
    onTestFinished(async () => {
      if (!releasePublication.settled()) {
        releasePublication.resolve(undefined);
      }
      await sendOutcome;
    });

    await publicationStarted.promise;
    await expect
      .poll(() => {
        return sendSettled;
      })
      .toBeTruthy();
    expect(releasePublication.settled()).toBeFalsy();
    const outcome = await sendOutcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    const sent = outcome.value;
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the pending publication not to gate dispatch");
    }
    await waitForRunUserMessage(
      actor,
      sent.body.threadId,
      sent.body.runId,
      prompt,
    );

    await expect
      .poll(async () => {
        const runList = await api.listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          limit: 100,
        });
        return runList.runs.some((run) => {
          return run.prompt === prompt;
        });
      })
      .toBe(true);

    const threadListPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic]) => {
        return topic === "threadListChanged";
      },
    );
    expect(threadListPublishes).toHaveLength(1);
    releasePublication.resolve(undefined);
    await cancelChatRun(actor, sent.body.runId);
  }, 90_000);

  it("keeps a queued send drainable when thread-list publication fails", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "thread list publication failure anchor",
    });
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some(([topic]) => {
          return topic === "threadListChanged";
        });
      })
      .toBe(true);
    context.mocks.ably.publish.mockClear();

    let failedThreadListPublish = false;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "threadListChanged" && !failedThreadListPublish) {
        failedThreadListPublish = true;
        return Promise.reject(new Error("thread list publication failed"));
      }
      return Promise.resolve(undefined);
    });

    const queuedMessageId = randomUUID();
    const queuedBody = {
      agentId,
      threadId: anchor.threadId,
      prompt: "queued send survives thread list publication failure",
      clientMessageId: queuedMessageId,
    };
    const queued = await chat.requestSendMessage(actor, queuedBody, [201]);
    expect(queued.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    expect(failedThreadListPublish).toBeTruthy();

    const retried = await chat.requestSendMessage(actor, queuedBody, [201]);
    expect(retried.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    const threadListPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic]) => {
        return topic === "threadListChanged";
      },
    );
    expect(threadListPublishes).toHaveLength(1);

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to remain drainable");
    }
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("serializes a terminal drain against an idle queue-first send", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "terminal drain race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    // Hold the real org admission lock after the inline send has persisted its
    // queue-first row. This lets both the inline path and terminal callback
    // drain reach the final atomic launch boundary before either can claim it.
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });

    const callbackQueryStarted = createDeferredPromise<void>(context.signal);
    const releaseCallbackQuery = createDeferredPromise<void>(context.signal);
    onTestFinished(async () => {
      if (!releaseCallbackQuery.settled()) {
        releaseCallbackQuery.resolve(undefined);
      }
      admissionLock.release();
      await admissionLock.done;
    });

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = typeof args[0] === "string" ? args[0] : "";
      if (!apl.includes("['agent-run-events']")) {
        return Promise.resolve([]);
      }
      if (!callbackQueryStarted.settled()) {
        callbackQueryStarted.resolve(undefined);
      }
      return releaseCallbackQuery.promise.then(() => {
        return [assistantEvent(0, "terminal callback race complete")];
      });
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await callbackQueryStarted.promise;
    // Completing the anchor also starts the org run-queue drain. Pin that
    // known waiter first so the next two waiters identify the inline send and
    // the terminal callback's chat-message drain respectively.
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const prompt = "terminal drain and inline send share one claim";
    const messageId = randomUUID();
    const send = chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientMessageId: messageId,
      },
      [201],
    );
    await expect
      .poll(async () => {
        const messages = await chat.listThreadMessages(actor, anchor.threadId);
        return messages.messages.some((message) => {
          return message.id === messageId;
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBe(2);

    releaseCallbackQuery.resolve(undefined);
    await expect.poll(admissionLock.waiterCount).toBe(3);
    admissionLock.release();

    const sent = await send;
    await admissionLock.done;
    await flushWaitUntilForTest();
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected one race winner to own the queued message");
    }

    const messages = await chat.listThreadMessages(actor, anchor.threadId);
    const claimed = userMessages(messages.messages).filter((message) => {
      return (
        message.revokesMessageId === messageId && message.runId !== undefined
      );
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.runId).toBe(sent.body.runId);
    const queued = userMessages(messages.messages).find((message) => {
      return message.id === messageId;
    });
    if (!queued) {
      throw new Error("Expected the queued message");
    }
    expect(queued.runId).toBeUndefined();

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    const candidates = runList.runs.filter((run) => {
      return run.prompt === prompt;
    });
    expect(candidates).toStrictEqual([
      expect.objectContaining({
        id: sent.body.runId,
        status: expect.stringMatching(/^(queued|pending|running)$/),
      }),
    ]);

    await cancelChatRun(actor, sent.body.runId);
  }, 90_000);

  it("preserves an appended claim when recall races the queue drain", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "recall claim race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const messageId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "recall races the appended claim",
        clientMessageId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Pin the terminal drain ahead of the callback drain at run admission,
    // then make the claim and recall queue behind the exact message row in a
    // test-owned order.
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    const messageQueueLock = await holdChatMessageQueueItemFixture({
      threadId: anchor.threadId,
      messageId,
      signal: context.signal,
    });

    const callbackQueryStarted = createDeferredPromise<void>(context.signal);
    const releaseCallbackQuery = createDeferredPromise<void>(context.signal);
    onTestFinished(async () => {
      if (!releaseCallbackQuery.settled()) {
        releaseCallbackQuery.resolve(undefined);
      }
      admissionLock.release();
      messageQueueLock.release();
      await Promise.all([admissionLock.done, messageQueueLock.done]);
    });

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = typeof args[0] === "string" ? args[0] : "";
      if (!apl.includes("['agent-run-events']")) {
        return Promise.resolve([]);
      }
      if (!callbackQueryStarted.settled()) {
        callbackQueryStarted.resolve(undefined);
      }
      return releaseCallbackQuery.promise.then(() => {
        return [assistantEvent(0, "recall claim race complete")];
      });
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await callbackQueryStarted.promise;
    await expect.poll(admissionLock.waiterCount).toBe(1);
    releaseCallbackQuery.resolve(undefined);
    await expect.poll(admissionLock.waiterCount).toBe(2);
    admissionLock.release();
    await admissionLock.done;
    await expect.poll(messageQueueLock.blockedWaiterCount).toBe(1);

    const recall = Promise.allSettled([
      chat.requestSendMessage(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          revokesMessageId: messageId,
          clientMessageId: randomUUID(),
        },
        [400],
      ),
    ]);
    await expect.poll(messageQueueLock.blockedWaiterCount).toBe(2);
    messageQueueLock.release();

    const [recallResult] = await recall;
    if (recallResult.status === "rejected") {
      throw recallResult.reason;
    }
    const recalled = recallResult.value;
    expectApiError(recalled.body);
    expect(recalled.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );
    await messageQueueLock.done;
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === messageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const claimed = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === messageId;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queue drain to append a claimed message");
    }
    const original = userMessages(messages.messages).find((message) => {
      return message.id === messageId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(claimed.content).toBe("recall races the appended claim");

    await cancelChatRun(actor, claimed.runId);
  }, 90_000);

  it("lets recall win without deadlocking an atomic queue-first drain", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "recall-first queue race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const prompt = "recall wins the atomic queue-first race";
    const messageId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientMessageId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    const messageQueueLock = await holdChatMessageQueueItemFixture({
      threadId: anchor.threadId,
      messageId,
      signal: context.signal,
    });

    // Stage the callback drain at org admission before recall reaches the queue
    // row. The direct waiter proves recall is first; the transitive count after
    // admission opens proves the drain is queued behind it.
    const callbackQueryStarted = createDeferredPromise<void>(context.signal);
    const releaseCallbackQuery = createDeferredPromise<void>(context.signal);
    onTestFinished(async () => {
      if (!releaseCallbackQuery.settled()) {
        releaseCallbackQuery.resolve(undefined);
      }
      admissionLock.release();
      messageQueueLock.release();
      await Promise.all([admissionLock.done, messageQueueLock.done]);
    });

    context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
      const apl = typeof args[0] === "string" ? args[0] : "";
      if (!apl.includes("['agent-run-events']")) {
        return Promise.resolve([]);
      }
      if (!callbackQueryStarted.settled()) {
        callbackQueryStarted.resolve(undefined);
      }
      return releaseCallbackQuery.promise.then(() => {
        return [assistantEvent(0, "recall-first queue race complete")];
      });
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await callbackQueryStarted.promise;
    await expect.poll(admissionLock.waiterCount).toBe(1);

    releaseCallbackQuery.resolve(undefined);
    await expect.poll(admissionLock.waiterCount).toBe(2);

    const recall = Promise.allSettled([
      chat.requestSendMessage(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          revokesMessageId: messageId,
          clientMessageId: randomUUID(),
        },
        [201],
      ),
    ]);
    await expect.poll(messageQueueLock.directBlockedWaiterCount).toBe(1);

    admissionLock.release();
    await admissionLock.done;
    await expect
      .poll(messageQueueLock.blockedWaiterCount)
      .toBeGreaterThanOrEqual(2);
    messageQueueLock.release();

    const [recallResult] = await recall;
    if (recallResult.status === "rejected") {
      throw recallResult.reason;
    }
    const recalled = recallResult.value;
    expect(recalled.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    await messageQueueLock.done;
    await flushWaitUntilForTest();

    await expect
      .poll(() => {
        return sandboxOperationEvents().some((event) => {
          return (
            event.op_type === "api_dispatch_claim_queue_first_message" &&
            event.queue_first_claim_result === "lost" &&
            event.queue_first_launch_outcome === "claim_lost"
          );
        });
      })
      .toBe(true);

    const messages = await chat.listThreadMessages(actor, anchor.threadId);
    expect(userMessages(messages.messages)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesMessageId: messageId,
      }),
    );
    expect(
      userMessages(messages.messages).filter((message) => {
        return message.revokesMessageId === messageId && message.runId;
      }),
    ).toHaveLength(0);

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runList.runs.filter((run) => {
        return run.prompt === prompt;
      }),
    ).toHaveLength(0);
  }, 90_000);

  it("does not publish a queued auto-send after thread deletion wins", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "thread deletion after queue-first launch anchor",
    });
    await claimChatRun(runnerGroup, anchor.runId);
    const messageId = randomUUID();
    const prompt = "queued auto-send deleted before its marker";
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientMessageId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "hold org concurrency during thread deletion",
    });

    // Force the auto-send onto the org queue, then pause its post-commit queue
    // signal before the marker transaction begins. Cancelling the anchor emits
    // the first queue signal; the queued launch emits the second.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const queuePublishStarted = createDeferredPromise<void>(context.signal);
    const releaseQueuePublish = createDeferredPromise<void>(context.signal);
    let queueChangedPublishes = 0;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "queue:changed") {
        queueChangedPublishes++;
        if (queueChangedPublishes === 2) {
          queuePublishStarted.resolve(undefined);
          return releaseQueuePublish.promise;
        }
      }
      return Promise.resolve(undefined);
    });
    onTestFinished(() => {
      if (!releaseQueuePublish.settled()) {
        releaseQueuePublish.resolve(undefined);
      }
    });

    await cancelChatRun(actor, anchor.runId);
    await queuePublishStarted.promise;

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    const autoRun = runList.runs.find((run) => {
      return run.prompt === prompt;
    });
    expect(autoRun).toMatchObject({ status: "queued" });
    if (!autoRun) {
      throw new Error("Expected the committed queued auto-send run");
    }

    // Hold a child message row so deletion owns the thread lock while the
    // post-commit marker reaches that exact parent/child race.
    const messageLock = await holdChatMessageFixture({
      threadId: anchor.threadId,
      messageId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      messageLock.release();
      await messageLock.done;
    });
    const deletion = chat.deleteThread(actor, anchor.threadId);
    await expect.poll(messageLock.blockedWaiterCount).toBeGreaterThanOrEqual(1);

    context.mocks.ably.publish.mockClear();
    releaseQueuePublish.resolve(undefined);
    await expect.poll(messageLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    messageLock.release();

    await Promise.all([messageLock.done, deletion]);
    await flushWaitUntilForTest();
    expect(
      apiDispatchActionTypes(apiDispatchTimingEventsForRun(autoRun.id)),
    ).not.toContain(
      "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals",
    );
    const publishedTopics = context.mocks.ably.publish.mock.calls.map(
      ([topic]) => {
        return topic;
      },
    );
    expect(publishedTopics).not.toContain(
      `chatThreadMessageCreated:${anchor.threadId}`,
    );
    expect(publishedTopics).not.toContain(
      `chatThreadRunCreated:${anchor.threadId}`,
    );
    await waitForRunStatus(actor, autoRun.id, "cancelled");
    await chat.requestReadThread(actor, anchor.threadId, [404]);
    await cancelChatRun(actor, blocker.runId);
  });

  it("appends replacements on auto-send and keeps queued recalls idempotent", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor run",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first waits for the anchor",
        clientMessageId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // A second queued message can be recalled before dispatch.
    const recalledId = randomUUID();
    const toRecall = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first message to recall",
        clientMessageId: recalledId,
      },
      [201],
    );
    expect(toRecall.body).toMatchObject({ runId: null });
    const recalled = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesMessageId: recalledId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({ runId: null });

    // A repeated recall stays idempotent.
    const repeatedRecall = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesMessageId: recalledId,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({ runId: null });

    // Completing the anchor auto-sends the queued message by appending a
    // run-associated replacement while preserving the queued row.
    context.mocks.ably.publish.mockClear();
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to append a replacement");
    }
    expect(promoted.content).toBe("queue-first waits for the anchor");
    const original = userMessages(messages.messages).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(Date.parse(promoted.createdAt)).toBeGreaterThan(
      Date.parse(original.createdAt),
    );
    const appended = await chat.listThreadMessages(actor, anchor.threadId, {
      sinceSeqId: original.seqId,
    });
    expect(appended.messages).toContainEqual(
      expect.objectContaining({
        id: promoted.id,
        revokesMessageId: queuedId,
        runId: promoted.runId,
      }),
    );
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${anchor.threadId}`;
        });
      })
      .toBe(true);

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queue-first waits for the anchor");
    expect(followUp.appendSystemPrompt ?? "").not.toContain(
      "queue-first message to recall",
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("auto-fires queued messages when the active run is cancelled", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor to cancel",
    });
    await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendMessage(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first fires after cancel",
        clientMessageId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Cancelling the anchor frees the thread; the cancel side effects drain
    // the queue, so the queued message gets a fresh associated row without
    // waiting for a completed-run callback or another send (#21392).
    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesMessageId === queuedId &&
            typeof message.runId === "string" &&
            message.runId !== anchor.runId
          );
        });
      },
    );
    const fired = userMessages(messages.messages).find((message) => {
      return message.revokesMessageId === queuedId;
    });
    if (!fired?.runId) {
      throw new Error("Expected the queued message to fire after cancel");
    }
    expect(fired.content).toBe("queue-first fires after cancel");
    const original = userMessages(messages.messages).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, fired.runId);
    expect(followUp.prompt).toContain("queue-first fires after cancel");
    await cancelChatRun(actor, fired.runId);
  }, 90_000);
});
