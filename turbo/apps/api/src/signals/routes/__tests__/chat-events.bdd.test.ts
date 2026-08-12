import { createHash, randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@vm0/core";
import { replayChatThreadEvents } from "@vm0/core/chat-thread-event-replay";
import { avatarTemplateStylePresetId } from "@vm0/core/avatar-template";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadsContract,
  resolveChatEventRecommendedFollowups,
  type ChatRunOptionsRequest,
  type ChatThreadEvent,
  type GenerationTemplateRequest,
  type ChatEvent,
  type UserMessageDocument,
  type UserMessageInputDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
  clientVersionWithTag,
} from "@vm0/api-contracts/contracts/client-headers";
import { isChatRunTerminalEventType } from "@vm0/api-contracts/contracts/chat-events";
import { cronSteerRunTimeBudgetContract } from "@vm0/api-contracts/contracts/cron";
import {
  ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@vm0/api-contracts/contracts/runners";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import {
  getModelProviderFirewall,
  type ModelProviderType,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroModelProviderConnectionsByIdContract,
  zeroModelProviderConnectionsMainContract,
} from "@vm0/api-contracts/contracts/zero-model-provider-gateways";
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { backdateRunStartedAtFixture } from "../../../test-fixtures/agent-runs";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
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
import { readAgentRunState$ } from "./helpers/agent-run-callback";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  clearThreadSessionBinding,
  readRunAutonomyBudgetFixture,
  readThreadSessionBinding,
  seedVm0ManagedModelKey as seedVm0ManagedModelKeyState,
  setRunAutonomyBudgetFixture,
} from "./helpers/runtime-state";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { overwriteModelProviderSecretForTests } from "./helpers/zero-model-provider-state";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  createUnassociatedThreadBoundAgentRunFixture,
  createUnassociatedThreadBoundZeroRunFixture,
} from "../../../test-fixtures/thread-bound-run-admission";
import {
  acquireBddVm0ApiKey,
  completeRunWithoutCallbacksFixture,
  deleteAgentRunFixture,
  holdCheckpointReadsFixture,
  holdChatEventFixture,
  holdChatEventQueueItemFixture,
  holdChatThreadRowLockFixture,
  holdOrgAdmissionLockFixture,
  holdThreadSessionBindingClearFixture,
  holdThreadSessionConversationChangesFixture,
  holdThreadSessionConversationClearFixture,
  readCanonicalChatEventStorageFixture,
  readChatEventContextFixture,
  releaseBddVm0ApiKey,
  replayPendingChatInputQueueEventFixture,
  replaceThreadSessionBindingFixture,
  timeoutRunWithoutCallbacksFixture,
} from "../../../test-fixtures/chat-events";
import { cronSteerRunTimeBudgetRoutes } from "../cron-steer-run-time-budget";
import { zeroChatEventsRoutes } from "../zero-chat-events";
import { zeroChatThreadRoutes } from "../zero-chat-threads";
import { zeroMailRoutes } from "../zero-mail";
import { zeroModelProviderGatewayRoutes } from "../zero-model-provider-gateways";
import { zeroModelProvidersRoutes } from "../zero-model-providers";

const TEST_APP_ROUTES = Object.freeze([
  ...zeroChatEventsRoutes,
  ...zeroChatThreadRoutes,
  ...zeroMailRoutes,
  ...zeroModelProviderGatewayRoutes,
  ...zeroModelProvidersRoutes,
]);

/**
 * CHAT-02 / RUN-01 / CHAIN-CHAT: the web chat send route end to end.
 *
 * Every Given is constructed through public APIs (Stripe-webhook entitlement,
 * org model provider/policy routes, runner heartbeat/claim, sandbox report
 * webhooks, feature-switch and computer-use host routes) and every Then is a
 * response body, messages page, thread/run read, queue read, claim payload,
 * or captured chat-callback delivery. Storage migration cases also assert the
 * queue-only transport row lifecycle directly.
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
const authDevice = createAuthDeviceApiActions(context);
const authDeviceSupport = createAuthDeviceSupportApi(context);
const routeMocks = createZeroRouteMocks(context);
const runStateStore = createStore();
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET = "okou web upload-file -f <path>";
const RUN_TIME_BUDGET_STEER_AT_MS = 115 * 60 * 1000;
// This pins the strict feedback shape shipped by the previous App build. Its
// reader rejects unknown keys, so this schema must consume the projected wire
// part rather than the current additive contract.
const previousAppFeedbackPartSchema = z
  .object({
    type: z.literal("feedback"),
    quote: z.string().min(1),
    note: z
      .array(
        z
          .object({
            type: z.literal("text"),
            text: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    source: z
      .object({
        type: z.literal("mail"),
        id: z.string().min(1),
        status: z.enum(["draft", "sent"]),
        sentId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

An active goal allows unfinished work to continue in a later run. An existing goal already provides that continuity and remains unchanged. If no goal exists, the unfinished outcome needs to be captured in a new goal before this run ends.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;
const API_DISPATCH_ZERO_WEB_CHAT_PRE_CREATE_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_load_and_authorize_agent",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_validate_model_selection",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_feature_switches",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_validate_codex_service_tier",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_initial_thread_model_pin",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_thread",
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
  "api_dispatch_pre_create_zero_resolve_thread_session",
] as const;
const API_DISPATCH_THREAD_SESSION_RESOLUTION_ACTION_TYPE =
  "api_dispatch_pre_create_zero_resolve_thread_session";
const API_DISPATCH_WEB_CHAT_SESSION_PROMPT_ACTION_TYPE =
  "api_dispatch_pre_create_zero_web_chat_resolve_session_prompt_context";
const API_DISPATCH_EXISTING_THREAD_PERSISTED_MODEL_ACTION_TYPE =
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_existing_thread_resolve_persisted_model";
const API_DISPATCH_REMOVED_EARLY_SESSION_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_existing_thread_session_context_parallel",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_existing_thread_resolve_session",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_existing_thread_load_incomplete_context",
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_prepare_recent_chat_context",
] as const;
const API_DISPATCH_EXISTING_THREAD_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_existing_thread_load_snapshot",
  API_DISPATCH_EXISTING_THREAD_PERSISTED_MODEL_ACTION_TYPE,
  API_DISPATCH_WEB_CHAT_SESSION_PROMPT_ACTION_TYPE,
] as const;
const API_DISPATCH_EXPLICIT_EXISTING_THREAD_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_existing_thread_load_snapshot",
  API_DISPATCH_WEB_CHAT_SESSION_PROMPT_ACTION_TYPE,
] as const;
const API_DISPATCH_ZERO_INTERNAL_ENTRYPOINT_ACTION_TYPES = [
  "api_dispatch_pre_create_zero_entrypoint_gap",
] as const;
const API_DISPATCH_THREAD_SESSION_BINDING_ACTION_TYPES = [
  "api_dispatch_validate_thread_session_snapshot_thread",
] as const;
const API_DISPATCH_QUEUE_FIRST_ADMISSION_ACTION_TYPES = [
  "api_dispatch_resolve_queue_first_admission",
] as const;
const API_DISPATCH_QUEUE_FIRST_CLAIM_PHASE_ACTION_TYPES = [
  "api_dispatch_resolve_queue_first_claim_snapshot",
  "api_dispatch_persist_queue_first_replacement",
] as const;
const API_DISPATCH_REUSED_THREAD_READ_ACTION_TYPES = [
  "api_dispatch_queue_first_thread_lock_wait",
  "api_dispatch_load_thread_session_binding",
] as const;
const API_DISPATCH_ATOMIC_PERSISTENCE_ACTION_TYPES = [
  "api_dispatch_persist_atomic_launch",
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

type UserMessage = Extract<
  ChatEvent,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.rejected"
      | "control.interrupt"
      | "control.revoke";
  }
>;
type AssistantMessage = Exclude<ChatEvent, UserMessage>;
type PromptMessage = Extract<ChatEvent, { eventType: "input.prompt" }>;
type FailedMessage = Extract<ChatEvent, { eventType: "run.failed" }>;
type OutputMessage = Extract<ChatEvent, { eventType: "output.message" }>;
type FollowupsEvent = Extract<ChatEvent, { eventType: "output.followups" }>;
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
  readonly userMessage?: UserMessageInputDocument;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly clientEventId?: string;
  readonly model?: SupportedRunModel;
  readonly runOptions?: ChatRunOptionsRequest;
  readonly template?: GenerationTemplateRequest;
  readonly computerUseHostId?: string | null;
  readonly revokesEventId?: string;
  readonly captureNetworkBodies?: boolean;
}

/**
 * Template markers render inline, so a client that wants the template on its
 * own line sends the blank line as an explicit text part.
 */
function userMessageWithTemplate(
  prompt: string,
  template: GenerationTemplateRequest,
): UserMessageInputDocument {
  const titleSnapshot = `${template.type[0]?.toUpperCase()}${template.type.slice(1)} template`;
  return {
    version: 1,
    parts: [
      { type: "text", text: prompt },
      { type: "text", text: "\n\n" },
      { type: "template", titleSnapshot, template },
    ],
  };
}

const openRouterBodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  max_tokens: z.number().optional(),
  reasoning: z.object({ effort: z.literal("none") }).optional(),
});

async function entitledChatActor(
  options: ApiTestUserOptions = {},
): Promise<EntitledChatActor> {
  const actor = bdd.user(options);
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(
    actor,
    options.orgId === STAFF_ORG_ID
      ? {
          customerId: "cus_bdd_chat_events_staff",
          subscriptionId: "sub_bdd_chat_events_staff",
        }
      : {},
  );
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat messages agent",
    description: "Exercises the web chat send route.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId };
}

async function seedVm0ManagedModelKey(selectedModel: string): Promise<string> {
  const fixture = await seedVm0ManagedModelKeyState(context, selectedModel);
  return fixture.selectedModel;
}

async function sendChatRun(
  actor: ApiTestUser,
  body: ChatRunSendBody,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const { template, ...canonicalBody } = body;
  const requestBody = {
    ...canonicalBody,
    ...(template === undefined
      ? {}
      : { userMessage: userMessageWithTemplate(body.prompt, template) }),
    clientEventId: body.clientEventId ?? randomUUID(),
  };
  const sent = await chat.requestSendEvent(actor, requestBody, [201]);
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
            message.revokesEventId === requestBody.clientEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    runId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === requestBody.clientEventId;
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
  const sandboxHeaders = {
    authorization: `Bearer ${claim.sandboxToken}`,
  };
  return {
    claim,
    sandboxHeaders,
  };
}

/**
 * The time-budget sweep is global, so it can only be driven from a file that
 * ages its own runs through `backdateRunStartedAtFixture`. Every other suite
 * claims runs at the current time and therefore stays outside the window.
 */
async function runSteerRunTimeBudgetCron(): Promise<void> {
  await accept(
    setupApp({ context, routes: cronSteerRunTimeBudgetRoutes })(
      cronSteerRunTimeBudgetContract,
    ).steer({ headers: { authorization: "Bearer test-cron-secret" } }),
    [200],
  );
}

/** Age one claimed run to the given elapsed runtime. */
async function ageClaimedRun(runId: string, elapsedMs: number): Promise<void> {
  await backdateRunStartedAtFixture({
    runId,
    startedAt: new Date(now() - elapsedMs),
  });
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

function firstAssistantEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return sandboxOperationEventsForRun(runId).filter((event) => {
    return event.op_type === "api_to_first_assistant_message";
  });
}

function firstAssistantEligibilityEventsForRun(
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
  predicate: (messages: readonly ChatEvent[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await expect
    .poll(async () => {
      page = await chat.listThreadEvents(actor, threadId);
      return predicate(page.events);
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
      return (
        message.runId === runId && chatEventDisplayText(message) === content
      );
    });
  });
}

async function waitForRunStatus(
  actor: ApiTestUser,
  runId: string,
  status:
    | "cancelled"
    | "completed"
    | "failed"
    | "pending"
    | "running"
    | "timeout",
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
    readonly activeInputDeliveryIds?: readonly string[];
    readonly cliAgentType?: "claude-code" | "codex";
    readonly lastEventSequence?: number;
  } = {},
): Promise<void> {
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  if (stagedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId, events: stagedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
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
      ...(options.activeInputDeliveryIds === undefined
        ? {}
        : { activeInputDeliveryIds: [...options.activeInputDeliveryIds] }),
      ...(options.lastEventSequence === undefined
        ? stagedOutputEvents.length === 0
          ? {}
          : {
              lastEventSequence: Math.max(
                ...stagedOutputEvents.map((event) => {
                  return event.sequenceNumber;
                }),
              ),
            }
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

async function cancelChatRun(
  actor: ApiTestUser,
  runId: string,
  sandboxHeaders?: { readonly authorization: string },
): Promise<void> {
  await api.requestCancelRun(actor, runId, [200]);
  await waitForRunStatus(actor, runId, "cancelled");
  if (sandboxHeaders) {
    await failChatRun(runId, sandboxHeaders, "Run cancelled");
    await flushWaitUntilForTest();
  }
}

function assistantMessages(messages: readonly ChatEvent[]): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

function userMessages(messages: readonly ChatEvent[]): UserMessage[] {
  return messages.filter(isUserMessage);
}

function isUserMessage(message: ChatEvent): message is UserMessage {
  switch (message.eventType) {
    case "input.prompt":
    case "input.automation":
    case "input.rejected":
    case "control.interrupt":
    case "control.revoke": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function eventBackedContents(
  messages: readonly ChatEvent[],
  runId: string,
): OutputMessage[] {
  return messages.filter((message): message is OutputMessage => {
    return message.eventType === "output.message" && message.runId === runId;
  });
}

function recommendedFollowupEvents(
  messages: readonly ChatEvent[],
  runId: string,
): FollowupsEvent[] {
  return messages.filter((message): message is FollowupsEvent => {
    return (
      message.eventType === "output.followups" &&
      message.runId === runId &&
      resolveChatEventRecommendedFollowups(message).length > 0
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
  return setupApp({ context, routes: zeroModelProvidersRoutes })(
    zeroModelProvidersMainContract,
  );
}

function modelProviderConnectionsClient() {
  return setupApp({ context, routes: zeroModelProviderGatewayRoutes })(
    zeroModelProviderConnectionsMainContract,
  );
}

function modelProviderConnectionsByIdClient() {
  return setupApp({ context, routes: zeroModelProviderGatewayRoutes })(
    zeroModelProviderConnectionsByIdContract,
  );
}

function chatEventsClient() {
  return setupApp({ context, routes: zeroChatEventsRoutes })(
    chatEventsContract,
  );
}

function chatThreadsClient() {
  return setupApp({ context, routes: zeroChatThreadRoutes })(
    chatThreadsContract,
  );
}

function chatThreadEventsClient() {
  return setupApp({ context, routes: zeroChatThreadRoutes })(
    chatThreadEventsContract,
  );
}

describe("CHAT-02: thread run admission invariant", () => {
  it("rejects thread-bound run creation without a queue association at both service boundaries", async () => {
    await expect(createUnassociatedThreadBoundZeroRunFixture()).rejects.toThrow(
      "Thread-bound Zero run requires a queue-first association",
    );

    await expect(
      createUnassociatedThreadBoundAgentRunFixture(),
    ).rejects.toThrow("Thread-bound run requires a queue-first association");

    await expect(
      createUnassociatedThreadBoundZeroRunFixture(""),
    ).rejects.toThrow(
      "Thread-bound Zero run requires a queue-first association",
    );

    await expect(
      createUnassociatedThreadBoundAgentRunFixture(""),
    ).rejects.toThrow("Thread-bound run requires a queue-first association");
  });
});

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
      | "deepseek"
      | "openai-api-key"
      | "openrouter-api-key"
      | "vercel-ai-gateway"
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
  let cursor = snapshot.latestSeqId;

  for (let page = 0; page < 20; page++) {
    const response = await chat.requestThreadEvents(
      actor,
      cursor ? { sinceSeqId: cursor } : {},
      [200],
    );
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }

    const sequencedEvents = response.body.events.map((event) => {
      if (event.seqId === undefined) {
        throw new Error("Expected chat thread event sequence ID");
      }
      return { ...event, seqId: event.seqId };
    });
    events.push(...sequencedEvents);
    if (!response.body.hasMore) {
      break;
    }

    const lastEvent = sequencedEvents.at(-1);
    if (!lastEvent) {
      throw new Error("Expected paginated chat thread events");
    }
    cursor = lastEvent.seqId;
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
async function requestSendEventRaw(
  actor: ApiTestUser,
  body: ChatRunSendBody & {
    readonly userMessage: UserMessageInputDocument;
    readonly hasTextContent: boolean;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers = sessionHeaders(actor);
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  const response = await app.request("/api/zero/chat/events", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  return { status: response.status, body: responseBody };
}

/** Chat send authenticated by a run-scoped sandbox bearer token. */
async function requestSendEventWithBearer(
  token: string,
  body: {
    readonly agentId: string;
    readonly clientEventId?: string;
    readonly prompt: string;
    readonly threadId?: string;
    readonly userMessage?: UserMessageInputDocument;
  },
  statuses: readonly (201 | 400 | 401 | 403 | 409)[],
) {
  return await accept(
    chatEventsClient().send({
      headers: { authorization: `Bearer ${token}` },
      body: {
        ...body,
        hasTextContent: true,
        userMessage:
          body.userMessage ??
          ({
            version: 1,
            parts: [{ type: "text", text: body.prompt }],
          } satisfies UserMessageInputDocument),
      },
    }),
    statuses,
  );
}

describe("CHAT-02: web chat send and client ids", () => {
  it("creates a web chat run with client-provided ids", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const clientThreadId = randomUUID();
    const clientEventId = randomUUID();
    const prompt = "hello from bdd web chat";
    const model = await chat.getDefaultCreateThreadModel(actor);
    const first = await accept(
      chatEventsClient().send({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          prompt,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
          hasTextContent: true,
          clientThreadId,
          clientEventId,
          model,
        },
      }),
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
    expectApiDispatchSpanKind(
      timingEvents,
      API_DISPATCH_THREAD_SESSION_BINDING_ACTION_TYPES,
      "nested",
    );
    expectApiDispatchSpanKind(
      timingEvents,
      [
        "api_dispatch_admission_lock_held",
        "api_dispatch_claim_queue_first_message",
        ...API_DISPATCH_QUEUE_FIRST_ADMISSION_ACTION_TYPES,
      ],
      "nested",
    );
    expectNoApiDispatchActions(
      timingEvents,
      API_DISPATCH_REUSED_THREAD_READ_ACTION_TYPES,
    );
    expectNoApiDispatchActions(
      timingEvents,
      API_DISPATCH_EXISTING_THREAD_ACTION_TYPES,
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
      clientEventId,
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
            message.revokesEventId === clientEventId && message.runId === runId
          );
        });
      },
    );
    const userRows = userMessages(messages.events);
    expect(userRows).toHaveLength(2);
    expect(userRows).toContainEqual(
      expect.objectContaining({
        id: clientEventId,
        content: null,
      }),
    );
    expect(userRows).toContainEqual(
      expect.objectContaining({
        content: null,
        runId,
        revokesEventId: clientEventId,
      }),
    );
    const original = userRows.find((message) => {
      return message.id === clientEventId;
    });
    expect(original).toMatchObject({
      id: clientEventId,
      threadId: clientThreadId,
      eventType: "input.prompt",
      content: null,
    });
    expect(original?.runId).toBeUndefined();
    expect(original).not.toHaveProperty("revokesEventId");

    const originalById = await chat.getThreadEvent(
      actor,
      clientThreadId,
      clientEventId,
    );
    expect(originalById).toMatchObject({
      id: clientEventId,
      threadId: clientThreadId,
      eventType: "input.prompt",
      content: null,
    });
    expect(originalById).not.toHaveProperty("revokesEventId");

    const eventPage = await accept(
      chatThreadEventsClient().list({
        headers: sessionHeaders(actor),
        params: { threadId: clientThreadId },
        query: { limit: 50 },
      }),
      [200],
    );
    const originalEvent = eventPage.body.events.find((event) => {
      return event.id === clientEventId;
    });
    expect(originalEvent).toMatchObject({
      id: clientEventId,
      threadId: clientThreadId,
      eventType: "input.prompt",
      content: null,
    });
    await expect(
      accept(
        chatThreadEventsClient().get({
          headers: sessionHeaders(actor),
          params: { threadId: clientThreadId, eventId: clientEventId },
        }),
        [200],
      ),
    ).resolves.toMatchObject({
      body: {
        id: clientEventId,
        threadId: clientThreadId,
        eventType: "input.prompt",
      },
    });

    await expect(chat.readThread(actor, clientThreadId)).resolves.toStrictEqual(
      {
        lastReadAt: null,
        cancellationRecoveryPending: false,
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
    const emptyThreadSend = await chat.requestSendEvent(
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
    const unauthenticated = await chat.requestSendEvent(
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

    const unknownAgent = await chat.requestSendEvent(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(unknownAgent.body);
    expect(unknownAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const forbidden = await chat.requestSendEvent(
      peer,
      { agentId: agent.agentId, prompt: "hello" },
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  }, 30_000);

  it("passes request-scoped network body capture into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const captured = await sendChatRun(actor, {
      agentId,
      prompt: "capture this run's network bodies",
      captureNetworkBodies: true,
    });
    const capturedClaim = await claimChatRun(runnerGroup, captured.runId);
    expect(capturedClaim.claim.captureNetworkBodies).toBeTruthy();
    await cancelChatRun(actor, captured.runId);

    const ordinary = await sendChatRun(actor, {
      agentId,
      prompt: "keep ordinary network logging metadata-only",
    });
    const ordinaryClaim = await claimChatRun(runnerGroup, ordinary.runId);
    expect(ordinaryClaim.claim.captureNetworkBodies).toBeUndefined();
    await cancelChatRun(actor, ordinary.runId);
  });
});

describe("CHAT-02: interrupting active chat runs", () => {
  it("interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "long task to interrupt",
    });
    await api.heartbeatRunner(runnerGroup);
    const firstClaim = await api.claimRunnerJob(first.runId);
    context.mocks.ably.publish.mockClear();

    const interruptId = randomUUID();
    const interrupted = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: interruptId,
      },
      [201],
    );
    if (interrupted.status !== 201) {
      throw new Error("Expected the interrupt send to be accepted");
    }
    expect(interrupted.body.runId).toBeNull();
    await waitForRunStatus(actor, first.runId, "cancelled");
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: first.runId,
      mode: "cooperative",
    });
    await webhooks.requestAgentComplete(
      { runId: first.runId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return (
              message.eventType === "control.interrupt" &&
              message.interruptsRunId === first.runId
            );
          }) &&
          assistantMessages(items).some((message) => {
            return (
              message.eventType === "run.cancelled" &&
              message.runId === first.runId &&
              message.runLifecycleEvent === "cancelled"
            );
          })
        );
      },
    );
    const interruptRows = userMessages(messages.events).filter((message) => {
      return (
        message.eventType === "control.interrupt" &&
        message.interruptsRunId === first.runId
      );
    });
    expect(interruptRows).toHaveLength(1);
    expect(interruptRows[0]).toMatchObject({ id: interruptId, content: null });
    expect(interruptRows[0]).not.toHaveProperty("runId");
    const [storedInterrupt] = await readCanonicalChatEventStorageFixture([
      interruptId,
    ]);
    expect(storedInterrupt).toMatchObject({
      payload: null,
      runId: first.runId,
    });
    expect(
      assistantMessages(messages.events).filter((message) => {
        return (
          message.eventType === "run.cancelled" &&
          message.runId === first.runId &&
          message.runLifecycleEvent === "cancelled"
        );
      }),
    ).toHaveLength(1);
    expect(
      assistantMessages(messages.events).filter((message) => {
        return (
          message.runId === first.runId &&
          isChatRunTerminalEventType(message.eventType)
        );
      }),
    ).toHaveLength(1);

    // Replaying the interrupt (same or fresh client id) stays idempotent.
    const replayedInterrupt = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: interruptId,
      },
      [201],
    );
    expect(replayedInterrupt.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const afterReplays = await chat.listThreadEvents(actor, first.threadId);
    expect(
      userMessages(afterReplays.events).filter((message) => {
        return (
          message.eventType === "control.interrupt" &&
          message.interruptsRunId === first.runId
        );
      }),
    ).toHaveLength(1);

    // A run that went terminal without an interrupt row cannot be interrupted.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "cancelled through the cancel api",
    });
    await cancelChatRun(actor, second.runId);
    const lateInterrupt = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: second.runId,
        clientEventId: randomUUID(),
      },
      [400],
    );
    expectApiError(lateInterrupt.body);
    expect(lateInterrupt.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );

    // The interrupt's client message id is burned for normal sends.
    const reusedInterruptId = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the interrupt client id",
        clientEventId: interruptId,
      },
      [409],
    );
    expectApiError(reusedInterruptId.body);
    expect(reusedInterruptId.body.error.message).toBe(
      "clientEventId is already in use",
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
  it("lets a running runner claim pending input prompts for steer", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "anchor active input run",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(active.runId);

    const firstPendingEventId = randomUUID();
    const secondPendingEventId = randomUUID();
    const activeFileId = randomUUID();
    chat.mockCompletedUploadObject(actor, activeFileId, "steer-notes.txt", 17);
    context.mocks.ably.publish.mockClear();
    const firstPending = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "first steer message",
        clientEventId: firstPendingEventId,
      },
      [201],
    );
    const secondPending = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "second steer message",
        clientEventId: secondPendingEventId,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: activeFileId,
              filenameSnapshot: "steer-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "second steer message" },
          ],
        },
      },
      [201],
    );
    if (firstPending.status !== 201 || secondPending.status !== 201) {
      throw new Error("Expected both pending sends to be accepted");
    }
    expect(firstPending.body.runId).toBeNull();
    expect(secondPending.body.runId).toBeNull();
    await expect(
      readChatEventContextFixture(firstPendingEventId),
    ).resolves.toMatchObject({
      contextType: "web",
      contextId: null,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
      runId: active.runId,
    });

    await expect(
      api.listRunnerActiveInputs(claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([firstPendingEventId, secondPendingEventId]);
    await expect(
      api.claimRunnerActiveInputs(claim.sandboxToken, active.runId, [
        secondPendingEventId,
        firstPendingEventId,
      ]),
    ).resolves.toBe(
      [
        "first steer message",
        `[Web file] steer-notes.txt (text/plain)\n   [ID] ${activeFileId}`,
        "second steer message",
      ].join("\n\n"),
    );
    await expect(
      api.listRunnerActiveInputs(claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([]);

    const events = await chat.listThreadEvents(actor, active.threadId);
    const firstClaimed = userMessages(events.events).find((message) => {
      return message.revokesEventId === firstPendingEventId;
    });
    if (!firstClaimed) {
      throw new Error("Expected the first web message replacement");
    }
    await expect(
      readChatEventContextFixture(firstClaimed.id),
    ).resolves.toMatchObject({
      contextType: "web",
      contextId: null,
    });
    for (const pendingEventId of [firstPendingEventId, secondPendingEventId]) {
      const claimedEvent = events.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.runId === active.runId &&
          event.revokesEventId === pendingEventId
        );
      });
      if (!claimedEvent || claimedEvent.eventType !== "input.prompt") {
        throw new Error("Expected the pending active input to be claimed");
      }
      expect(
        claimedEvent.userMessage.parts.some((part) => {
          return part.type === "model";
        }),
      ).toBeFalsy();
    }

    const emptyControlPayloadBytes = Buffer.byteLength(
      JSON.stringify({ type: "active-input", text: "" }),
      "utf8",
    );
    const exactLimitPendingEventId = randomUUID();
    const exactLimitPending = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - emptyControlPayloadBytes,
        ),
        clientEventId: exactLimitPendingEventId,
      },
      [201],
    );
    if (exactLimitPending.status !== 201) {
      throw new Error("Expected the exact-limit pending send to be accepted");
    }
    expect(exactLimitPending.body.runId).toBeNull();
    const exactLimitPrompt = await api.claimRunnerActiveInputs(
      claim.sandboxToken,
      active.runId,
      [exactLimitPendingEventId],
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({ type: "active-input", text: exactLimitPrompt }),
        "utf8",
      ),
    ).toBe(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES);

    const oversizedPendingEventId = randomUUID();
    const oversizedPending = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES),
        clientEventId: oversizedPendingEventId,
      },
      [201],
    );
    if (oversizedPending.status !== 201) {
      throw new Error("Expected the oversized pending send to be accepted");
    }
    expect(oversizedPending.body.runId).toBeNull();
    const oversizedConflict = await api.claimRunnerActiveInputsConflict(
      claim.sandboxToken,
      active.runId,
      [oversizedPendingEventId],
    );
    expectApiError(oversizedConflict);
    expect(oversizedConflict.error.message).toBe(
      "Active input batch exceeds runner control payload limit",
    );
    await expect(
      api.listRunnerActiveInputs(claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([oversizedPendingEventId]);

    const afterOversizedClaim = await chat.listThreadEvents(
      actor,
      active.threadId,
    );
    expect(
      userMessages(afterOversizedClaim.events).some((event) => {
        return event.revokesEventId === oversizedPendingEventId;
      }),
    ).toBeFalsy();
    expect(userMessages(afterOversizedClaim.events)).toContainEqual(
      expect.objectContaining({
        runId: active.runId,
        revokesEventId: exactLimitPendingEventId,
      }),
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: oversizedPendingEventId,
      },
      [201],
    );

    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("reserves rich inputs one at a time and settles concurrent receipts once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "anchor durable active input delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const fileId = randomUUID();
    chat.mockCompletedUploadObject(actor, fileId, "delivery-notes.txt", 23);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "first durable steer",
        clientEventId: firstEventId,
      },
      [201],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "second durable steer",
        clientEventId: secondEventId,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "delivery-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "second durable steer" },
          ],
        },
      },
      [201],
    );

    const reservations = await Promise.all([
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ]);
    const [firstReservation, concurrentReservation] = reservations;
    if (
      firstReservation.outcome !== "reserved" ||
      concurrentReservation.outcome !== "reserved"
    ) {
      throw new Error("Expected both concurrent reservations to succeed");
    }
    expect(concurrentReservation).toStrictEqual(firstReservation);
    expect(firstReservation.eventIds).toStrictEqual([firstEventId]);
    expect(firstReservation.prompt).toBe("first durable steer");

    // Model a lost first response: retry must retrieve the same durable delivery.
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual(firstReservation);

    context.mocks.ably.publish.mockClear();
    const receipts = await Promise.all([
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
    ]);
    expect(receipts).toStrictEqual([
      { outcome: "delivered" },
      { outcome: "delivered" },
    ]);
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
      runId: active.runId,
    });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === "active-input";
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);

    await expect(
      api.listRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([secondEventId]);
    const secondReservation = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (secondReservation.outcome !== "reserved") {
      throw new Error("Expected the second input to be reserved");
    }
    expect(secondReservation.deliveryId).not.toBe(firstReservation.deliveryId);
    expect(secondReservation.eventIds).toStrictEqual([secondEventId]);
    expect(secondReservation.prompt).toBe(
      [
        `[Web file] delivery-notes.txt (text/plain)\n   [ID] ${fileId}`,
        "second durable steer",
      ].join("\n\n"),
    );
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        secondReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(2);
    await expect(
      api.listRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([]);
    const events = await chat.listThreadEvents(actor, active.threadId);
    const replacements = events.events.filter((event) => {
      return (
        event.runId === active.runId &&
        (event.revokesEventId === firstEventId ||
          event.revokesEventId === secondEventId)
      );
    });
    expect(
      replacements.map((event) => {
        return event.revokesEventId;
      }),
    ).toStrictEqual([firstEventId, secondEventId]);
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("finalizes delivered input from completion receipts exactly once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "complete a durable delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "accepted before completion",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected completion input to be reserved");
    }

    const history = `bdd chat session history ${active.runId}`;
    await webhooks.requestAgentCheckpoint(
      {
        runId: active.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${active.runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(history)
          .digest("hex"),
      },
      claimed.sandboxHeaders,
      [200],
    );
    const checkpointGate = await holdCheckpointReadsFixture({
      signal: context.signal,
    });
    onTestFinished(async () => {
      checkpointGate.release();
      await checkpointGate.done;
    });
    const completion = webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 0,
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await expect
      .poll(checkpointGate.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    checkpointGate.release();
    await checkpointGate.done;
    await expect(completion).resolves.toMatchObject({
      body: { success: true, status: "completed" },
    });
    await flushWaitUntilForTest();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const duplicate = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "late fallback completion",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(duplicate.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
  }, 90_000);

  it("settles delivered input with the terminal run transition", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "complete with a durable delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "settle with the terminal transition",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected terminal input to be reserved");
    }

    await completeChatRunOk(active.runId, claimed.sandboxHeaders, {
      activeInputDeliveryIds: [reserved.deliveryId],
    });
    await flushWaitUntilForTest();

    expect((await api.readRun(actor, active.runId)).status).toBe("completed");
    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
  }, 90_000);

  it("finalizes a late receipt without replaying terminal callbacks", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "leave a legacy terminal delivery open",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "finalize after the terminal transition",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected late completion input to be reserved");
    }
    await completeRunWithoutCallbacksFixture({ runId: active.runId });

    const completed = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "duplicate fallback",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completed.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
  }, 90_000);

  it("releases prompts and expires budget input before draining in FIFO order", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "finalize an unconfirmed delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const releasedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "released queue head",
        clientEventId: releasedEventId,
      },
      [201],
    );
    await ageClaimedRun(active.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    await runSteerRunTimeBudgetCron();
    const pendingEventIds = await api.listRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    expect(pendingEventIds).toHaveLength(2);
    const budgetEventId = pendingEventIds.find((eventId) => {
      return eventId !== releasedEventId;
    });
    if (!budgetEventId) {
      throw new Error("Expected a pending budget input");
    }
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the released prompt to be reserved");
    }
    expect(reserved.eventIds).toStrictEqual([releasedEventId]);
    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "later queue input",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected later input to remain queued");
    }
    expect(later.body.runId).toBeNull();

    await completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "rejected" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === releasedEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === releasedEventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the released queue head to be promoted");
    }
    expect(
      messages.events.filter((event) => {
        return (
          event.eventType === "control.revoke" &&
          event.revokesEventId === budgetEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);

    const successorClaim = await claimChatRun(runnerGroup, promoted.runId);
    await expect(
      api.listRunnerActiveInputs(
        successorClaim.claim.sandboxToken,
        promoted.runId,
      ),
    ).resolves.toStrictEqual([laterEventId]);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: laterEventId,
      },
      [201],
    );
    await cancelChatRun(actor, promoted.runId, successorClaim.sandboxHeaders);
  }, 90_000);

  it("keeps cancelled deliveries as barriers after recovery expiry", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "cancel with a held delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "accepted before cancellation",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected cancelled input to be reserved");
    }
    await api.requestCancelRun(actor, active.runId, [200]);
    await waitForRunStatus(actor, active.runId, "cancelled");

    mockNow(now() + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    onTestFinished(() => {
      clearMockNow();
    });
    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "wait behind stale cancellation recovery",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected post-cancellation input to remain queued");
    }
    expect(later.body.runId).toBeNull();
    const beforeCompletion = await chat.listThreadEvents(
      actor,
      active.threadId,
    );
    expect(
      userMessages(beforeCompletion.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);

    await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "Run cancelled",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    clearMockNow();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === laterEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === laterEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected the post-cancellation input to start a run");
    }
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === heldEventId &&
          message.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    const successorClaim = await claimChatRun(runnerGroup, successor);
    await cancelChatRun(actor, successor, successorClaim.sandboxHeaders);
  }, 90_000);

  it("keeps timed-out delivery input held until Runner completion", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "time out with an uncertain delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "release only after teardown completion",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected timeout input to be reserved");
    }
    await timeoutRunWithoutCallbacksFixture({ runId: active.runId });
    await waitForRunStatus(actor, active.runId, "timeout");

    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "wait behind the timed-out delivery",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected post-timeout input to remain queued");
    }
    expect(later.body.runId).toBeNull();

    await failChatRun(
      active.runId,
      claimed.sandboxHeaders,
      "Runner observed timed-out process exit",
    );
    await flushWaitUntilForTest();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "rejected" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === heldEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === heldEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected timed-out delivery input to be released");
    }
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);
    const successorClaim = await claimChatRun(runnerGroup, successor);
    await expect(
      api.listRunnerActiveInputs(successorClaim.claim.sandboxToken, successor),
    ).resolves.toStrictEqual([laterEventId]);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: laterEventId,
      },
      [201],
    );
    await cancelChatRun(actor, successor, successorClaim.sandboxHeaders);
  }, 90_000);

  it("cascades delivery state when its thread is deleted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "delete a thread with reserved input",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "delete this reserved input",
        clientEventId: randomUUID(),
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected deleted thread input to be reserved");
    }

    await chat.deleteThread(actor, active.threadId);
    const missingDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${claimed.claim.sandboxToken}`,
      active.runId,
      reserved.deliveryId,
      [403],
    );
    expectApiError(missingDelivery.body);
    await failChatRun(
      active.runId,
      claimed.sandboxHeaders,
      "Thread deleted during execution",
    );
    await flushWaitUntilForTest();

    const unrelated = await sendChatRun(actor, {
      agentId,
      prompt: "run after deleting another delivery thread",
    });
    const unrelatedClaim = await claimChatRun(runnerGroup, unrelated.runId);
    await cancelChatRun(actor, unrelated.runId, unrelatedClaim.sandboxHeaders);
  }, 90_000);

  it("classifies delivery lifecycle and authorization without route-level 404", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const emptyRun = await sendChatRun(actor, {
      agentId,
      prompt: "empty durable delivery",
    });
    const preclaimSandboxToken = api.sandboxTokenForRun(actor, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(preclaimSandboxToken, emptyRun.runId),
    ).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "run_not_running",
    });
    const emptyClaim = await claimChatRun(runnerGroup, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        emptyClaim.claim.sandboxToken,
        emptyRun.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const missingAuth = await api.requestReserveRunnerActiveInputsAs(
      undefined,
      emptyRun.runId,
      [401],
    );
    expectApiError(missingAuth.body);
    const cli = await api.createCliToken(actor);
    const wrongCredential = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${cli.token}`,
      emptyRun.runId,
      [403],
    );
    expectApiError(wrongCredential.body);

    const peer = bdd.user();
    const wrongTenantToken = api.sandboxTokenForRun(peer, emptyRun.runId);
    const wrongTenant = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${wrongTenantToken}`,
      emptyRun.runId,
      [403],
    );
    expectApiError(wrongTenant.body);
    const randomDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      emptyRun.runId,
      randomUUID(),
      [403],
    );
    expectApiError(randomDelivery.body);

    await cancelChatRun(actor, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        emptyClaim.claim.sandboxToken,
        emptyRun.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "terminal" });

    const heldRun = await sendChatRun(actor, {
      agentId,
      prompt: "hold durable delivery after termination",
    });
    const heldClaim = await claimChatRun(runnerGroup, heldRun.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: heldRun.threadId,
        prompt: "remain held",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      heldClaim.claim.sandboxToken,
      heldRun.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected an active-input delivery reservation");
    }
    const wrongRun = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      heldRun.runId,
      [403],
    );
    expectApiError(wrongRun.body);
    const crossDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      emptyRun.runId,
      reserved.deliveryId,
      [403],
    );
    expectApiError(crossDelivery.body);

    await cancelChatRun(actor, heldRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        heldClaim.claim.sandboxToken,
        heldRun.runId,
      ),
    ).resolves.toStrictEqual({
      outcome: "held",
      deliveryId: reserved.deliveryId,
      eventIds: [heldEventId],
    });
  }, 90_000);

  it("applies the delivery-aware payload limit without consuming rejection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "validate durable delivery payload limit",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const emptyDeliveryPayloadBytes = Buffer.byteLength(
      JSON.stringify({
        type: "active-input",
        deliveryId: randomUUID(),
        text: "",
      }),
      "utf8",
    );
    const exactEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - emptyDeliveryPayloadBytes,
        ),
        clientEventId: exactEventId,
      },
      [201],
    );
    const exact = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (exact.outcome !== "reserved") {
      throw new Error("Expected exact-limit delivery to be reserved");
    }
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "active-input",
          deliveryId: exact.deliveryId,
          text: exact.prompt,
        }),
        "utf8",
      ),
    ).toBe(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES);
    await api.recordRunnerActiveInputDelivery(
      claimed.claim.sandboxToken,
      active.runId,
      exact.deliveryId,
    );

    const oversizedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES -
            emptyDeliveryPayloadBytes +
            1,
        ),
        clientEventId: oversizedEventId,
      },
      [201],
    );
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "payload_too_large",
    });
    await expect(
      api.listRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([oversizedEventId]);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: oversizedEventId,
      },
      [201],
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("reserves and settles a run-scoped budget input", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "reserve the time budget warning",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    await ageClaimedRun(active.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    await runSteerRunTimeBudgetCron();
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the budget input to be reserved");
    }
    expect(reserved.prompt).toBe(RUN_TIME_BUDGET_MESSAGE);
    expect(reserved.eventIds).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    await expect(
      api.listRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([]);
    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.budget",
        runId: active.runId,
        revokesEventId: reserved.eventIds[0],
      }),
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("steers a run once when it reaches its time budget", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run until the time budget warning",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);

    await ageClaimedRun(active.runId, RUN_TIME_BUDGET_STEER_AT_MS - 60_000);
    await runSteerRunTimeBudgetCron();
    await expect(
      api.listRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([]);

    await ageClaimedRun(active.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    await runSteerRunTimeBudgetCron();
    const budgetEventIds = await api.listRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    expect(budgetEventIds).toHaveLength(1);
    await expect(
      api.claimRunnerActiveInputs(
        claimed.claim.sandboxToken,
        active.runId,
        budgetEventIds,
      ),
    ).resolves.toBe(RUN_TIME_BUDGET_MESSAGE);

    const publicEvents = await chat.listThreadEvents(actor, active.threadId);
    const budgetEvent = publicEvents.events.find((event) => {
      return (
        event.eventType === "input.budget" &&
        event.runId === active.runId &&
        chatEventDisplayText(event) === RUN_TIME_BUDGET_MESSAGE
      );
    });
    if (!budgetEvent || budgetEvent.eventType !== "input.budget") {
      throw new Error("Expected the run time budget input to be claimed");
    }
    expect(
      budgetEvent.userMessage.parts.some((part) => {
        return part.type === "model";
      }),
    ).toBeFalsy();

    await runSteerRunTimeBudgetCron();
    await expect(
      api.listRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([]);

    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("does not carry an unclaimed time budget input into a later run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "leave the budget input unclaimed",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await ageClaimedRun(first.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    await runSteerRunTimeBudgetCron();
    await expect(
      api.listRunnerActiveInputs(firstClaim.claim.sandboxToken, first.runId),
    ).resolves.toHaveLength(1);

    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "start a later run",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await expect(
      api.listRunnerActiveInputs(secondClaim.claim.sandboxToken, second.runId),
    ).resolves.toStrictEqual([]);
    await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
  }, 90_000);

  it("queues, retries, and recalls messages behind an active run", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "anchor active run",
    });

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientEventId: queuedId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued send to be accepted");
    }
    expect(queued.body.runId).toBeNull();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const queuedRetry = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queuedRetry.body).toStrictEqual(queued.body);
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-opus-4-8",
    );

    // Another user's send cannot claim the queued message's client id.
    const { actor: stranger, agentId: strangerAgentId } =
      await entitledChatActor();
    const strangerThread = await chat.createThread(stranger, {
      agentId: strangerAgentId,
      title: "Cross-user conflict thread",
    });
    const crossUser = await chat.requestSendEvent(
      stranger,
      {
        agentId: strangerAgentId,
        threadId: strangerThread.id,
        prompt: "cross-user retry",
        clientEventId: queuedId,
      },
      [409],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.message).toBe(
      "clientEventId is already in use",
    );
    const strangerMessages = await chat.listThreadEvents(
      stranger,
      strangerThread.id,
    );
    expect(strangerMessages.events).toStrictEqual([]);

    const strangerRun = await sendChatRun(stranger, {
      agentId: strangerAgentId,
      threadId: strangerThread.id,
      prompt: "first accepted event after the rejected id",
    });
    const acceptedStrangerMessages = await chat.listThreadEvents(
      stranger,
      strangerThread.id,
    );
    expect(acceptedStrangerMessages.events[0]?.seqId).toBe(1);
    await cancelChatRun(stranger, strangerRun.runId);

    const beforeRecall = await chat.listThreadEvents(actor, first.threadId);
    expect(
      userMessages(beforeRecall.events).filter((message) => {
        return message.id === queuedId;
      }),
    ).toHaveLength(1);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: queuedId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the recall send to be accepted");
    }
    expect(recalled.body.runId).toBeNull();

    const repeatedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: queuedId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    const afterRepeated = await chat.listThreadEvents(actor, first.threadId);

    // Run-associated messages cannot be recalled.
    const associated = userMessages(afterRepeated.events).find((message) => {
      return message.runId === first.runId;
    });
    if (!associated) {
      throw new Error("Expected the active run's user message to be listed");
    }
    const rejectedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: associated.id,
        clientEventId: randomUUID(),
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
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "must remain queued in the original thread",
        clientEventId: queuedMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const otherThread = await chat.createThread(actor, {
      agentId,
      title: "Cross-thread recall target",
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: otherThread.id,
        revokesEventId: queuedMessageId,
        clientEventId: randomUUID(),
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
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the original queued message to create a run");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe(
      "must remain queued in the original thread",
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02: org queue markers", () => {
  it("marks queued chat runs and revokes the marker on dequeue", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "occupy org concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queuedRun = await chat.requestSendEvent(
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
    const queuedTimingEvents = apiDispatchTimingEventsForRun(
      queuedRun.body.runId,
    );
    expectApiDispatchSpanKind(
      queuedTimingEvents,
      API_DISPATCH_ATOMIC_PERSISTENCE_ACTION_TYPES,
      "nested",
    );
    expectNoApiDispatchActions(queuedTimingEvents, [
      "api_dispatch_insert_run_record",
      "api_dispatch_persist_custom_connector_auth_refs",
      "api_dispatch_insert_agent_run_queue",
      "api_dispatch_count_agent_run_queue_depth",
      "api_dispatch_update_thread_session_binding",
    ]);
    expect(sandboxOperationEventsForRun(queuedRun.body.runId)).toContainEqual(
      expect.objectContaining({
        op_type: "enqueue_zero_run",
        queue_depth: 1,
      }),
    );
    expect(
      queuedTimingEvents.filter((event) => {
        return event.op_type === "api_dispatch_resolve_queue_first_admission";
      }),
    ).toHaveLength(1);

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
    const queuedRunUserRows = userMessages(beforeDequeue.events);
    expect(queuedRunUserRows).toHaveLength(2);
    const queuedRunMessage = queuedRunUserRows.find((message) => {
      return message.runId === queuedRun.body.runId;
    });
    expect(queuedRunMessage).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
    });
    expect(chatEventDisplayText(queuedRunMessage!)).toBe(
      "wait behind the active run",
    );
    expect(queuedRunMessage?.revokesEventId).toBeDefined();
    const queuedRunOriginal = queuedRunUserRows.find((message) => {
      return message.id === queuedRunMessage?.revokesEventId;
    });
    expect(queuedRunOriginal?.content).toBeNull();
    expect(chatEventDisplayText(queuedRunOriginal!)).toBe(
      "wait behind the active run",
    );
    expect(queuedRunOriginal?.runId).toBeUndefined();
    const marker = assistantMessages(beforeDequeue.events).find((message) => {
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
    const queuedTemplate = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: queuedThread,
        prompt: "template queued deck",
        userMessage: userMessageWithTemplate(
          "template queued deck",
          generationTemplate,
        ),
        clientEventId: templateMessageId,
      },
      [201],
    );
    expect(queuedTemplate.body).toMatchObject({ runId: null });
    const withTemplate = await chat.listThreadEvents(actor, queuedThread);
    const templateMessage = userMessages(withTemplate.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.id === templateMessageId
        );
      },
    );
    expect(templateMessage?.userMessage?.parts).toContainEqual(
      expect.objectContaining({
        type: "template",
        template: generationTemplate,
      }),
    );

    const queueBefore = await api.readRunQueue(actor);
    expect(queueBefore.body.queue).toHaveLength(1);
    expect(queueBefore.body.queue[0]).toMatchObject({
      runId: queuedRun.body.runId,
    });

    // Recall the queued template message so the dequeue does not auto-send it.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: queuedThread,
        revokesEventId: templateMessageId,
        clientEventId: randomUUID(),
      },
      [201],
    );

    // Interrupting the blocking run drains the org queue and revokes the
    // queue marker on the dequeued run's thread.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: blocker.body.threadId,
        interruptsRunId: blocker.body.runId,
        clientEventId: randomUUID(),
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
    const revoker = assistantMessages(afterDequeue.events).find((message) => {
      return message.runEventId === "queue:dequeued";
    });
    if (!revoker) {
      throw new Error("Expected an assistant queue-dequeued revoker");
    }
    expect(revoker).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
      revokesEventId: marker.id,
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

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "fail before worker start",
        clientEventId: messageId,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to still create a run");
    }
    expect(sent.body.status).toBe("failed");
    await flushWaitUntilForTest();
    expect(
      firstAssistantEligibilityEventsForRun(sent.body.runId),
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
            message.eventType === "run.failed" &&
            message.runId === sent.body.runId &&
            message.runLifecycleEvent === "failed"
          );
        });
      },
    );
    const failedMarker = assistantMessages(messages.events).find(
      (message): message is FailedMessage => {
        return (
          message.eventType === "run.failed" &&
          message.runId === sent.body.runId &&
          message.runLifecycleEvent === "failed"
        );
      },
    );
    if (!failedMarker) {
      throw new Error("Expected a failed lifecycle marker");
    }
    expect(failedMarker.error).toStrictEqual(expect.any(String));
    expect(userMessages(messages.events)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
        runId: sent.body.runId,
      }),
    );
    expect(
      userMessages(messages.events).some((message) => {
        return (
          message.revokesEventId === messageId &&
          chatEventDisplayText(message) === "fail before worker start"
        );
      }),
    ).toBeTruthy();
    const replay = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "fail before worker start",
        clientEventId: messageId,
      },
      [201],
    );
    expect(replay.body).toMatchObject({
      runId: sent.body.runId,
      threadId: sent.body.threadId,
      status: "failed",
    });
    await flushWaitUntilForTest();
    expect(firstAssistantEligibilityEventsForRun(sent.body.runId)).toHaveLength(
      1,
    );
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
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const clientEventId = randomUUID();
    const sendBody: ChatRunSendBody = {
      agentId: agent.agentId,
      prompt: "blocked by suspended plan",
      model: "claude-sonnet-5",
      clientEventId,
    };
    const sent = await chat.requestSendEvent(actor, sendBody, [201]);
    if (sent.status !== 201) {
      throw new Error("Expected the blocked send to return 201 without a run");
    }
    expect(sent.body.runId).toBeNull();

    const messages = await chat.listThreadEvents(actor, sent.body.threadId);
    const blockedUsers = userMessages(messages.events);
    expect(blockedUsers).toHaveLength(2);
    const queuedUser = blockedUsers.find((message) => {
      return (
        message.eventType === "input.prompt" && message.id === clientEventId
      );
    });
    if (!queuedUser) {
      throw new Error("Expected the original queued user message");
    }
    expect(queuedUser).toMatchObject({
      content: null,
    });
    expect(chatEventDisplayText(queuedUser)).toBe("blocked by suspended plan");
    expect(queuedUser.runId).toBeUndefined();
    const blockedUser = blockedUsers.find((message) => {
      return (
        message.eventType === "input.rejected" &&
        message.revokesEventId === clientEventId
      );
    });
    if (!blockedUser) {
      throw new Error("Expected an insufficient-credits replacement message");
    }
    expect(blockedUser).toMatchObject({
      content: null,
      error: "insufficient_credits",
      revokesEventId: clientEventId,
    });
    expect(chatEventDisplayText(blockedUser)).toBe("blocked by suspended plan");
    expect(blockedUser.runId).toBeUndefined();
    const guidance = assistantMessages(messages.events).find((message) => {
      return message.eventType === "output.error";
    });
    if (!guidance) {
      throw new Error("Expected insufficient-credits assistant guidance");
    }
    expect(guidance.content).toContain("Buy more credits");
    expect(guidance.error).toBe("insufficient_credits");

    const appended = await chat.listThreadEvents(actor, sent.body.threadId, {
      sinceSeqId: queuedUser.seqId,
    });
    expect(appended.events).toStrictEqual([
      expect.objectContaining({
        id: blockedUser.id,
        revokesEventId: clientEventId,
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

    const retry = await chat.requestSendEvent(
      actor,
      { ...sendBody, threadId: sent.body.threadId },
      [201],
    );
    expect(retry.body).toStrictEqual(sent.body);
    const afterRetry = await chat.listThreadEvents(actor, sent.body.threadId);
    expect(afterRetry.events).toHaveLength(3);
  }, 60_000);
});

describe("CHAT-02: Zero Mail link delivery", () => {
  it("delivers a linked Gmail draft exactly once through the agent reply", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
      setupApp({ context, routes: zeroMailRoutes })(zeroMailContract).linkDraft(
        {
          headers: {
            authorization: `Bearer ${zeroTokenFromClaim(claim)}`,
          },
          body: {
            threadId: run.threadId,
            agentId,
            gmailDraftId,
          },
        },
      ),
      [200],
    );
    const beforeReply = await chat.listThreadEvents(actor, run.threadId);
    expect(
      assistantMessages(beforeReply.events).filter((message) => {
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
      assistantMessages(completed.events).filter((message) => {
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
    chatCallbacks.failIfChatCallbackRouteIsFetched();

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
    expect(appendSystemPrompt).toContain("okou web upload-file -h");
    expect(appendSystemPrompt).toContain("okou mail link <gmail-draft-id>");
    expect(appendSystemPrompt).toContain(
      "GET /gmail/v1/users/me/settings/sendAs",
    );
    expect(appendSystemPrompt).toContain(
      "Include a `multipart/alternative` body",
    );
    expect(appendSystemPrompt).toContain(
      "Keep each plain-text paragraph on one logical line",
    );
    expect(appendSystemPrompt).toContain(
      "use HTML paragraph elements so Gmail wraps the message naturally",
    );
    expect(appendSystemPrompt).toContain("append that signature exactly once");
    expect(appendSystemPrompt).toContain(
      "return the link from the command to the user",
    );
    expect(appendSystemPrompt).toContain("Do not add a mail callback prompt");
    expect(appendSystemPrompt).toContain(
      "confirm the send against Gmail before reporting it",
    );
    expect(appendSystemPrompt).toContain(
      "`okou workflow automation list <workflow>` shows one workflow's triggers",
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
      type: "deepseek",
      secret: "selected-deepseek-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: deepseekId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected DeepSeek provider",
      model: "deepseek-v4-flash",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(environment.OPENAI_BASE_URL).toBe("https://api.deepseek.com/");
    expect(environment.OPENAI_MODEL).toBe("deepseek-v4-flash");
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
        selectedModel: "deepseek-v4-flash",
      }),
    );
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: run.threadId,
        selectedModel: "deepseek-v4-flash",
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
    expect(followUpEnvironment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(followUpEnvironment.OPENAI_BASE_URL).toBe(
      "https://api.deepseek.com/",
    );
    expect(followUpEnvironment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    await cancelChatRun(actor, followUp.runId);

    // A vm0 provider pin in an entitled org passes the spendable-credits
    // admission. The outcome past admission is race-dependent on the shared
    // database: 503 when no vm0 execution key exists (no public provisioning
    // surface), 201 when another suite's alive legacy test has seeded a
    // global vm0 key. Both prove the credits-ok admission arm.
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const vm0Prompt = "vm0-backed admission with spendable credits";
    const vm0Send = await requestSendEventRaw(actor, {
      agentId,
      prompt: vm0Prompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: vm0Prompt }],
      },
      model: "claude-sonnet-5",
      hasTextContent: true,
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

  it("routes DeepSeek V4 Flash through the native Responses adapter", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "deepseek",
      secret: "selected-deepseek-responses-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with DeepSeek Responses",
      model: "deepseek-v4-flash",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);

    expect(claim.cliAgentType).toBe("codex");
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(environment.OPENAI_BASE_URL).toBe("https://api.deepseek.com/");
    expect(environment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    expect(environment.ANTHROPIC_MODEL).toBeUndefined();
    expect(claim.codexRuntimeConfig).toMatchObject({
      providerId: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      envKey: "OPENAI_API_KEY",
      requiresOpenaiAuth: false,
      wireApi: "responses",
      supportsWebsockets: false,
      modelCatalog: {
        models: [
          expect.objectContaining({
            slug: "deepseek-v4-flash",
            default_reasoning_level: "high",
          }),
        ],
      },
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      cliAgentType: "codex",
    });

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue with DeepSeek Responses",
    });
    const { claim: followUpClaim } = await claimChatRun(
      runnerGroup,
      followUp.runId,
    );
    const followUpEnvironment = claimEnvironment(followUpClaim);
    expect(followUpClaim.cliAgentType).toBe("codex");
    expect(followUpClaim.resumeSession?.sessionId).toBe(`bdd-cli-${run.runId}`);
    expect(followUpClaim.codexRuntimeConfig?.providerId).toBe("deepseek");
    expect(followUpEnvironment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(followUpEnvironment.OPENAI_BASE_URL).toBe(
      "https://api.deepseek.com/",
    );
    expect(followUpEnvironment.OPENAI_MODEL).toBe("deepseek-v4-flash");

    await cancelChatRun(actor, followUp.runId);
  });

  it("resolves an unchanged existing thread without waiting for its row lock", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const thread = await chat.createThread(actor, { agentId });
    const prompt = "continue without reconciling the thread model";
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const [sent] = await Promise.all([
      sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        prompt,
      }),
      (async () => {
        await expect.poll(threadLock.firstBlockedStatementKind).toBe("update");
        threadLock.release();
        await threadLock.done;
      })(),
    ]);
    const timingEvents = apiDispatchTimingEventsForRun(sent.runId);
    expectApiDispatchSpanKind(
      timingEvents,
      [
        ...API_DISPATCH_EXISTING_THREAD_ACTION_TYPES,
        API_DISPATCH_THREAD_SESSION_RESOLUTION_ACTION_TYPE,
      ],
      "nested",
    );
    expectNoApiDispatchActions(
      timingEvents,
      API_DISPATCH_REMOVED_EARLY_SESSION_ACTION_TYPES,
    );
    expect(timingEvents).toContainEqual(
      expect.objectContaining({
        op_type:
          "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_thread",
        model_resolution_path: "read_only",
      }),
    );
    expectApiDispatchTimingEventsNotToLeak(timingEvents, [
      prompt,
      thread.id,
      agentId,
    ]);
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("recovers a removed thread model through the current workspace route", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start before the thread model is removed",
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

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

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });
    const [recovered] = await Promise.all([
      sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue through the current workspace default",
      }),
      (async () => {
        await expect
          .poll(threadLock.firstBlockedStatementKind)
          .toBe("select_for_update");
        threadLock.release();
        await threadLock.done;
      })(),
    ]);
    const timingEvents = apiDispatchTimingEventsForRun(recovered.runId);
    expectApiDispatchSpanKind(
      timingEvents,
      [
        ...API_DISPATCH_EXISTING_THREAD_ACTION_TYPES,
        API_DISPATCH_THREAD_SESSION_RESOLUTION_ACTION_TYPE,
      ],
      "nested",
    );
    expectNoApiDispatchActions(
      timingEvents,
      API_DISPATCH_REMOVED_EARLY_SESSION_ACTION_TYPES,
    );
    expect(timingEvents).toContainEqual(
      expect.objectContaining({
        op_type:
          "api_dispatch_pre_create_zero_web_chat_prepare_normal_send_resolve_thread",
        model_resolution_path: "locked_reconciliation",
      }),
    );
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
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
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
      chat.requestSendEvent(
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
    expect(["claude-opus-4-8", "claude-sonnet-5"]).toContain(
      claimEnvironment(racedClaim.claim).ANTHROPIC_MODEL,
    );
    await cancelChatRun(actor, sent.body.runId, racedClaim.sandboxHeaders);

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
          event.selectedModel === "claude-opus-4-8"
        );
      }).length,
    ).toBeLessThanOrEqual(1);
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("passes Codex fast mode only for feature-enabled GPT 5.6 sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const actorWithOrg = { ...actor, orgId };
    await seedVm0ManagedModelKey("gpt-5.6-sol");

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
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
    const switchOff = await chat.requestSendEvent(
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
    const fastMessages = await waitForThreadMessages(
      actor,
      fast.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === fast.runId;
        });
      },
    );
    const fastUserMessage = userMessages(fastMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.runId === fast.runId;
      },
    )?.userMessage;
    expect(
      fastUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    const fastClaim = await claimChatRun(runnerGroup, fast.runId);
    const environment = claimEnvironment(fastClaim.claim);
    expect(fastClaim.claim.cliAgentType).toBe("codex");
    expect(environment.OPENAI_MODEL).toBe("gpt-5.6-sol");
    expect(environment.VM0_CODEX_SERVICE_TIER).toBe("fast");
    expect(environment.OPENAI_API_KEY).toBeTruthy();
    expect(environment.CHATGPT_ACCESS_TOKEN).toBeUndefined();
    await cancelChatRun(actor, fast.runId, fastClaim.sandboxHeaders);
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
      "Codex fast mode is only available for GPT 5.6 runs",
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
      model: "gpt-5.6-luna",
    });
    expect(
      (await readThreadProjection(actor, standard.threadId)).serviceTier,
    ).toBeNull();
    const standardMessages = await waitForThreadMessages(
      actor,
      standard.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === standard.runId;
        });
      },
    );
    const standardUserMessage = userMessages(standardMessages.events).find(
      (event): event is PromptMessage => {
        return (
          event.eventType === "input.prompt" && event.runId === standard.runId
        );
      },
    )?.userMessage;
    expect(
      standardUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-5.6-luna",
    });
    const { claim: standardClaim } = await claimChatRun(
      runnerGroup,
      standard.runId,
    );
    const standardEnvironment = claimEnvironment(standardClaim);
    expect(standardEnvironment.OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(standardEnvironment.VM0_CODEX_SERVICE_TIER).toBeUndefined();
    await cancelChatRun(actor, standard.runId);

    const rejectedThreadId = randomUUID();
    const rejected = await chat.requestSendEvent(
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
      "Codex fast mode is only available for GPT 5.6 runs",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);
  }, 90_000);

  it("preserves persisted fast mode after the current provider route changes", async () => {
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
        model: "gpt-5.6-luna",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start fast before the provider route changes",
      model: "gpt-5.6-luna",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
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
    expect(environment.OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(environment.VM0_CODEX_SERVICE_TIER).toBe("fast");
    expect(
      (await readThreadProjection(actor, first.threadId)).serviceTier,
    ).toBe("priority");
    await expectNoThreadModelUpdateEvent(actor, first.threadId, "gpt-5.6-luna");
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
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected openrouter provider",
      model: "claude-opus-4-8",
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
    expect(environment.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.8");
    expect(environment.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      "anthropic/claude-opus-4.8",
    );
    expect(environment.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      "anthropic/claude-opus-4.8",
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
        selectedModel: "claude-opus-4-8",
      }),
    );

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 90_000);

  it("routes vm0 DeepSeek through native Responses env bindings", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keyFixtureId = randomUUID();

    // Keep a second DeepSeek fixture owner alive to cover vendor-unique row
    // arbitration instead of relying on another test file's scheduling.
    await seedVm0ManagedModelKey("deepseek-v4-flash");
    await acquireBddVm0ApiKey({
      fixtureId: keyFixtureId,
      vendor: "deepseek",
      apiKey: `vm0-key-bdd-dev-seed-${keyFixtureId}`,
    });

    let runId: string | null = null;
    const cancelRunIfCreated = async () => {
      if (runId) {
        await api.requestCancelRun(actor, runId, [200]);
      }
    };
    const releaseVm0DeepSeekKey = async () => {
      await releaseBddVm0ApiKey({ fixtureId: keyFixtureId });
    };
    const cleanupRunAndKeys = async () => {
      await Promise.all([releaseVm0DeepSeekKey(), cancelRunIfCreated()]);
    };

    await (async () => {
      await api.updateOrgModelPolicies(actor, [
        {
          model: "deepseek-v4-flash",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);

      const run = await sendChatRun(actor, {
        agentId,
        prompt: "run with the selected vm0 DeepSeek provider",
        model: "deepseek-v4-flash",
      });
      runId = run.runId;

      const { claim } = await claimChatRun(runnerGroup, run.runId);
      const environment = claimEnvironment(claim);
      expect(environment.OPENAI_API_KEY).toBe(
        modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
      );
      expect(environment.OPENAI_BASE_URL).toBe("https://api.deepseek.com/");
      expect(environment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    })().then(cleanupRunAndKeys, async (error: unknown) => {
      await cleanupRunAndKeys();
      throw error;
    });
  }, 90_000);

  it("selects a vm0 managed key by vendor", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keyFixtureId = randomUUID();
    const requestedApiKey = `vm0-key-bdd-dev-seed-${keyFixtureId}`;
    await seedVm0ManagedModelKey("claude-opus-4-8");

    let runId: string | null = null;

    onTestFinished(async () => {
      await Promise.all([
        releaseBddVm0ApiKey({ fixtureId: keyFixtureId }),
        ...(runId ? [api.requestCancelRun(actor, runId, [200])] : []),
      ]);
    });

    const acquiredApiKey = await acquireBddVm0ApiKey({
      fixtureId: keyFixtureId,
      vendor: "anthropic",
      apiKey: requestedApiKey,
    });
    expect(acquiredApiKey === requestedApiKey).toBeFalsy();

    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected vm0 provider",
      model: "claude-opus-4-8",
    });
    runId = run.runId;

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_API_KEY).toBe(
      modelProviderSecretPlaceholder("anthropic-api-key", "ANTHROPIC_API_KEY"),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-opus-4-8");

    if (!claim.encryptedSecrets) {
      throw new Error("Expected vm0 claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("ANTHROPIC_API_KEY")}`,
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected vm0 firewall auth to resolve");
    }
    const authorization = resolved.body.headers.Authorization;
    expect(authorization?.startsWith("Bearer ")).toBeTruthy();
    expect(authorization?.length ?? 0).toBeGreaterThan("Bearer ".length);
    expect(authorization === `Bearer ${acquiredApiKey}`).toBeTruthy();
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
        model: "claude-opus-4-8",
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
      model: "claude-opus-4-8",
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
        model: "claude-opus-4-8",
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

    const firstPrompt = "first turn on the default opus policy";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-opus-4-8",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-8",
    );
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "opus answer")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "opus answer";
      });
    });
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-opus-4-8",
    );
    expect(
      (await api.readRun(actor, first.runId)).result?.agentSessionId,
    ).toMatch(/[0-9a-f-]{36}/);

    // A run-level override of another model in the same family resumes the CLI
    // session, which already carries the prior web round, so the prompt does
    // not replay it.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "switch to sonnet",
      model: "claude-sonnet-5",
    });
    const secondTimingEvents = apiDispatchTimingEventsForRun(second.runId);
    expectApiDispatchSpanKind(
      secondTimingEvents,
      [
        ...API_DISPATCH_EXPLICIT_EXISTING_THREAD_ACTION_TYPES,
        API_DISPATCH_THREAD_SESSION_RESOLUTION_ACTION_TYPE,
      ],
      "nested",
    );
    expectNoApiDispatchActions(secondTimingEvents, [
      API_DISPATCH_EXISTING_THREAD_PERSISTED_MODEL_ACTION_TYPE,
    ]);
    expectNoApiDispatchActions(
      secondTimingEvents,
      API_DISPATCH_REMOVED_EARLY_SESSION_ACTION_TYPES,
    );
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("Assistant: opus answer");
    expect(appended).toContain("# This Chat Thread");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    expect(appended).toContain("`okou chat messages`");
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    await flushWaitUntilForTest();

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
      "claude-opus-4-8",
    );
    await cancelChatRun(actor, third.runId);
  }, 90_000);

  it("pins switched Codex accounts without rotating the thread session", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    const firewall = createFirewallApi(context);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "chat-codex-account-a",
      workspaceName: "Chat Account A",
    });
    const startedA = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedA.status !== 200) {
      throw new Error("Expected Codex account A auth to start");
    }
    const completedA = await authDevice.requestCodexComplete(
      actor,
      startedA.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedA.body) ||
      completedA.body.status !== "complete"
    ) {
      throw new Error("Expected Codex account A auth to complete");
    }
    const accountAId = completedA.body.provider.id;

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "chat-codex-account-b",
      workspaceName: "Chat Account B",
    });
    const startedB = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedB.status !== 200) {
      throw new Error("Expected Codex account B auth to start");
    }
    const completedB = await authDevice.requestCodexComplete(
      actor,
      startedB.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedB.body) ||
      completedB.body.status !== "complete"
    ) {
      throw new Error("Expected Codex account B auth to complete");
    }
    const accountBId = completedB.body.provider.id;

    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start with account A",
      model: "gpt-5.6-luna",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(
      firstClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountAId });

    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      accountBId,
    );
    if (!firstClaim.claim.encryptedSecrets) {
      throw new Error("Expected account A run to carry encrypted secrets");
    }
    const firstResolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${firstClaim.claim.sandboxToken}` },
      {
        encryptedSecrets: firstClaim.claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: firstClaim.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          firstClaim.claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (firstResolved.status !== 200) {
      throw new Error("Expected account A firewall auth to resolve");
    }
    expect(firstResolved.body.headers["ChatGPT-Account-ID"]).toBe(
      "chat-codex-account-a",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with account B",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(
      secondClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountBId });
    if (!secondClaim.claim.encryptedSecrets) {
      throw new Error("Expected account B run to carry encrypted secrets");
    }
    const secondResolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${secondClaim.claim.sandboxToken}` },
      {
        encryptedSecrets: secondClaim.claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: secondClaim.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          secondClaim.claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (secondResolved.status !== 200) {
      throw new Error("Expected account B firewall auth to resolve");
    }
    expect(secondResolved.body.headers["ChatGPT-Account-ID"]).toBe(
      "chat-codex-account-b",
    );
    expect(secondResolved.body.headers.Authorization).not.toBe(
      firstResolved.body.headers.Authorization,
    );

    await cancelChatRun(actor, second.runId);
    await authDeviceSupport.deletePersonalModelProvider(
      actor,
      "codex-oauth-token",
      [204],
    );
  }, 90_000);

  it("resumes the CLI session across same-family model switches", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
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

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start on opus before switching within Claude",
      model: "claude-opus-4-8",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet in the same session",
      model: "claude-sonnet-5",
    });
    expectApiDispatchSpanKind(
      apiDispatchTimingEventsForRun(second.runId),
      ["api_dispatch_validate_thread_session_snapshot_session"],
      "nested",
    );
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
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

  it("refuses a canonical session owned by another user and organization", async () => {
    const primary = await entitledChatActor();
    const foreign = await entitledChatActor();
    const runnerGroup = api.configureRunnerGroup();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const primaryFirst = await sendChatRun(primary.actor, {
      agentId: primary.agentId,
      prompt: "establish the correctly owned canonical session",
    });
    const primaryClaim = await claimChatRun(runnerGroup, primaryFirst.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(primaryFirst.runId, primaryClaim.sandboxHeaders);

    const foreignFirst = await sendChatRun(foreign.actor, {
      agentId: foreign.agentId,
      prompt: "establish a foreign canonical session",
    });
    const foreignClaim = await claimChatRun(runnerGroup, foreignFirst.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(foreignFirst.runId, foreignClaim.sandboxHeaders);

    const primaryBinding = await readThreadSessionBinding(
      context,
      primaryFirst.threadId,
    );
    const foreignBinding = await readThreadSessionBinding(
      context,
      foreignFirst.threadId,
    );
    if (!primaryBinding.agent_session_id || !foreignBinding.agent_session_id) {
      throw new Error("Expected both threads to establish canonical sessions");
    }
    await replaceThreadSessionBindingFixture({
      threadId: primaryFirst.threadId,
      sessionId: foreignBinding.agent_session_id,
      runId: foreignFirst.runId,
    });

    const primarySecond = await sendChatRun(primary.actor, {
      agentId: primary.agentId,
      threadId: primaryFirst.threadId,
      prompt: "continue without reusing the foreign session",
    });
    const repairedBinding = await readThreadSessionBinding(
      context,
      primaryFirst.threadId,
    );
    expect(repairedBinding).toMatchObject({
      agent_session_id: primaryBinding.agent_session_id,
      agent_session_run_id: primarySecond.runId,
      run_session_id: primaryBinding.agent_session_id,
    });
    expect(repairedBinding.agent_session_id).not.toBe(
      foreignBinding.agent_session_id,
    );
    expect(sandboxOperationEventsForRun(primarySecond.runId)).toContainEqual(
      expect.objectContaining({
        op_type: "chat_thread_session_binding_persisted",
        chat_thread_id: primaryFirst.threadId,
        agent_session_id: primaryBinding.agent_session_id,
        agent_session_run_id: primarySecond.runId,
        binding_action: "adopted",
      }),
    );
    const primarySecondClaim = await claimChatRun(
      runnerGroup,
      primarySecond.runId,
    );
    expect(primarySecondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${primaryFirst.runId}`,
    );
    await cancelChatRun(primary.actor, primarySecond.runId);
  }, 90_000);

  it("does not repeat preparation after a competing run changes the binding", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for binding admission");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const established = await sendChatRun(actor, {
      agentId,
      prompt: "establish the binding before competing sends",
    });
    const establishedClaim = await claimChatRun(runnerGroup, established.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(established.runId, establishedClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const firstRequest = {
      eventId: firstEventId,
      prompt: "first competing binding send",
      response: chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: established.threadId,
          prompt: "first competing binding send",
          clientEventId: firstEventId,
        },
        [201],
      ),
    } as const;
    // Make the queue head the first admission-lock waiter so the second
    // prepared request observes the binding committed by the first.
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const secondRequest = {
      eventId: secondEventId,
      prompt: "second competing binding send",
      response: chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: established.threadId,
          prompt: "second competing binding send",
          clientEventId: secondEventId,
        },
        [201],
      ),
    } as const;
    const requests = [firstRequest, secondRequest] as const;

    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(
          actor,
          established.threadId,
        );
        return requests.every(({ eventId }) => {
          return messages.events.some((event) => {
            return event.id === eventId;
          });
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBe(2);

    admissionLock.release();
    const responses = await Promise.all(
      requests.map(({ response }) => {
        return response;
      }),
    );
    await admissionLock.done;

    const winners = responses.flatMap((response, index) => {
      if (response.status !== 201 || response.body.runId === null) {
        return [];
      }
      return [
        {
          eventId: requests[index]!.eventId,
          runId: response.body.runId,
        },
      ];
    });
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) {
      throw new Error("Expected one competing send to create a run");
    }
    const loser = requests.find(({ eventId }) => {
      return eventId !== winner.eventId;
    });
    if (!loser) {
      throw new Error("Expected one competing send to lose admission");
    }
    expect(
      responses.filter((response) => {
        return response.status === 201 && response.body.runId === null;
      }),
    ).toHaveLength(1);

    const messages = await chat.listThreadEvents(actor, established.threadId);
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === winner.eventId &&
          message.runId === winner.runId
        );
      }),
    ).toHaveLength(1);
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === loser.eventId &&
          message.runId !== undefined
        );
      }),
    ).toHaveLength(0);
    const queuedLoser = userMessages(messages.events).find((message) => {
      return message.id === loser.eventId;
    });
    if (!queuedLoser) {
      throw new Error("Expected the losing message to remain queued");
    }
    expect(queuedLoser.runId).toBeUndefined();
    expect(chatEventDisplayText(queuedLoser)).toBe(loser.prompt);
    await expect(
      readThreadSessionBinding(context, established.threadId),
    ).resolves.toMatchObject({
      agent_session_run_id: winner.runId,
    });

    const staleBlockedAdmission = sandboxOperationEvents().find((event) => {
      return (
        event.op_type === "api_dispatch_resolve_queue_first_admission" &&
        event.queue_first_admission_result === "blocked" &&
        event.thread_session_snapshot_state === "binding_changed" &&
        event.queue_first_launch_outcome === "claim_lost"
      );
    });
    expect(staleBlockedAdmission).toBeDefined();
    const discardedRunId = staleBlockedAdmission?.run_id;
    if (typeof discardedRunId !== "string") {
      throw new Error("Expected blocked admission timing to identify its run");
    }
    const lostTimingEvents = apiDispatchTimingEventsForRun(discardedRunId);
    for (const actionType of [
      "api_dispatch_prepare_run_context",
      "api_dispatch_build_runner_job_payload",
      "api_dispatch_insert_run_with_concurrency",
      "api_dispatch_admission_lock_wait",
      "api_dispatch_resolve_queue_first_admission",
      "api_dispatch_claim_queue_first_message",
    ]) {
      expect(
        lostTimingEvents.filter((event) => {
          return event.op_type === actionType;
        }),
      ).toHaveLength(1);
    }
    expect(
      sandboxOperationEvents().filter((event) => {
        return (
          event.op_type === "chat_thread_session_binding_retry" &&
          event.chat_thread_id === established.threadId
        );
      }),
    ).toHaveLength(0);

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: established.threadId,
        revokesEventId: loser.eventId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    await cancelChatRun(actor, winner.runId);
  }, 90_000);

  it("retries preparation when the canonical binding changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for binding validation");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the binding snapshot",
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
    const messageId = randomUUID();
    const secondPromise = sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after the binding changes",
      clientEventId: messageId,
    });
    // The queue-first insert must complete before a fixture owns the parent
    // thread row; otherwise its FK check would block before session resolution.
    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(actor, first.threadId);
        return messages.events.some((message) => {
          return message.id === messageId;
        });
      })
      .toBe(true);

    const bindingClear = await holdThreadSessionBindingClearFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      bindingClear.release();
      await bindingClear.done;
    });
    admissionLock.release();
    await admissionLock.done;
    // Unlike the shared org advisory key, this row lock can only be reached
    // after the target preparation has captured its binding snapshot.
    await expect
      .poll(bindingClear.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);
    bindingClear.release();
    await bindingClear.done;
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
        retry_reason: "binding_changed",
      }),
    );
    const retryTimingEvents = apiDispatchTimingEventsForRun(second.runId);
    for (const actionType of [
      "api_dispatch_prepare_run_context",
      "api_dispatch_build_runner_job_payload",
      "api_dispatch_insert_run_with_concurrency",
      "api_dispatch_resolve_queue_first_admission",
    ]) {
      expect(
        retryTimingEvents.filter((event) => {
          return event.op_type === actionType;
        }),
      ).toHaveLength(2);
    }
    expect(retryTimingEvents).toContainEqual(
      expect.objectContaining({
        op_type: "api_dispatch_resolve_queue_first_admission",
        queue_first_admission_result: "idle",
        thread_session_snapshot_state: "binding_changed",
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
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("rebuilds Web prompt context when a stale retry rotates the session", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for binding validation");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const created = await accept(
      modelProviderConnectionsClient().create({
        headers: sessionHeaders(actor),
        body: {
          displayName: "Retry session gateway",
          secret: "retry-session-gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-5": "anthropic/claude-sonnet-4.6",
              },
            },
          ],
        },
      }),
      [201],
    );
    const surfaceId = created.body.surfaces[0]?.id;
    if (!surfaceId) {
      throw new Error("Expected the retry gateway to have a surface");
    }
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "vercel-ai-gateway",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: surfaceId,
      },
    ]);

    const anchorPrompt = "successful context before the incomplete round";
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: anchorPrompt,
      model: "claude-sonnet-5",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "successful context response"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const incompletePrompt = "failed context from the reusable session";
    const incomplete = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: incompletePrompt,
    });
    const incompleteClaim = await claimChatRun(runnerGroup, incomplete.runId);
    await failChatRun(
      incomplete.runId,
      incompleteClaim.sandboxHeaders,
      "expected retry context failure",
    );
    await flushWaitUntilForTest();
    const originalBinding = await readThreadSessionBinding(
      context,
      anchor.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the incomplete run to retain its session");
    }

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });
    const messageId = randomUUID();
    const retriedPromise = sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "rotate the prompt context during retry",
      clientEventId: messageId,
    });
    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(actor, anchor.threadId);
        return messages.events.some((message) => {
          return message.id === messageId;
        });
      })
      .toBe(true);

    const bindingClear = await holdThreadSessionBindingClearFixture({
      threadId: anchor.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      bindingClear.release();
      await bindingClear.done;
    });
    admissionLock.release();
    await admissionLock.done;
    await expect
      .poll(bindingClear.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);

    await accept(
      modelProviderConnectionsByIdClient().update({
        headers: sessionHeaders(actor),
        params: { id: created.body.id },
        body: {
          displayName: "Updated retry session gateway",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic-v2",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-5": "anthropic/claude-sonnet-4.6-v2",
              },
            },
          ],
        },
      }),
      [200],
    );
    bindingClear.release();
    await bindingClear.done;
    const retried = await retriedPromise;

    expect(
      sandboxOperationEvents().filter((event) => {
        return (
          event.op_type === "chat_thread_session_binding_retry" &&
          event.chat_thread_id === anchor.threadId
        );
      }),
    ).toContainEqual(
      expect.objectContaining({
        agent_session_id: originalBinding.agent_session_id,
        resolution_action: "reused",
        retry_reason: "binding_changed",
      }),
    );
    expect(sandboxOperationEventsForRun(retried.runId)).toContainEqual(
      expect.objectContaining({
        op_type: "chat_thread_session_binding_persisted",
        binding_action: "rotated",
      }),
    );
    const retriedRun = await api.readRun(actor, retried.runId);
    const appendSystemPrompt = retriedRun.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).toContain("# Web Chat Run Context");
    expect(appendSystemPrompt).toContain(anchorPrompt);
    expect(appendSystemPrompt).toContain(incompletePrompt);
    expect(appendSystemPrompt).not.toContain("# Incomplete Rounds Context");

    const retryTimingEvents = apiDispatchTimingEventsForRun(retried.runId);
    for (const actionType of [
      API_DISPATCH_THREAD_SESSION_RESOLUTION_ACTION_TYPE,
      API_DISPATCH_WEB_CHAT_SESSION_PROMPT_ACTION_TYPE,
    ]) {
      expect(
        retryTimingEvents.filter((event) => {
          return event.op_type === actionType;
        }),
      ).toHaveLength(2);
    }
    const retriedClaim = await claimChatRun(runnerGroup, retried.runId);
    expect(retriedClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, retried.runId);
  }, 90_000);

  it("replays only each prior run's final answer when a model family rotates the session", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId: codexProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "prior-round-trim-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);

    const firstPrompt = "plan the migration in several steps";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "narration: reading the first file"),
      assistantEvent(1, "narration: reading the second file"),
      assistantEvent(2, "final answer with the migration plan"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 2,
    });
    await flushWaitUntilForTest();
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "final answer with the migration plan";
      });
    });

    // Switching model family rotates the CLI session, so the prior round is
    // replayed. An agentic run emits one chat message per step; only its final
    // answer carries information the next run needs.
    await chat.updateThreadModelSelection(
      actor,
      first.threadId,
      "gpt-5.6-terra",
    );
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after the family switch",
    });
    const appended = (await api.readRun(actor, second.runId))
      .appendSystemPrompt;
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain(
      "Assistant: final answer with the migration plan",
    );
    expect(appended).not.toContain("narration: reading the first file");
    expect(appended).not.toContain("narration: reading the second file");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("retries preparation when the canonical conversation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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

    const conversationClear = await holdThreadSessionConversationClearFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      conversationClear.release();
      await conversationClear.done;
    });
    const secondPromise = sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after the checkpoint changes",
    });
    // The staged clear is still uncommitted, so the run resolves the pre-clear
    // snapshot and only blocks once its commit re-reads the session row.
    await expect
      .poll(conversationClear.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);

    conversationClear.release();
    await conversationClear.done;
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
    const retryTimingEvents = apiDispatchTimingEventsForRun(second.runId);
    for (const actionType of [
      "api_dispatch_prepare_run_context",
      "api_dispatch_build_runner_job_payload",
      "api_dispatch_insert_run_with_concurrency",
      "api_dispatch_resolve_queue_first_admission",
    ]) {
      expect(
        retryTimingEvents.filter((event) => {
          return event.op_type === actionType;
        }),
      ).toHaveLength(2);
    }
    expect(retryTimingEvents).toContainEqual(
      expect.objectContaining({
        op_type: "api_dispatch_resolve_queue_first_admission",
        queue_first_admission_result: "idle",
        thread_session_snapshot_state: "session_changed",
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

  it("fails after every canonical session preparation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the snapshot before retry exhaustion",
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

    const preparationAttempts = 3;
    const conversationChanges =
      await holdThreadSessionConversationChangesFixture({
        threadId: first.threadId,
        changeCount: preparationAttempts,
        signal: context.signal,
      });
    onTestFinished(async () => {
      conversationChanges.releaseAll();
      await conversationChanges.done;
    });
    const retryPrompt = "exhaust every session preparation attempt";
    const failedPromise = requestSendEventRaw(actor, {
      agentId,
      threadId: first.threadId,
      clientEventId: randomUUID(),
      prompt: retryPrompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: retryPrompt }],
      },
      hasTextContent: true,
    });

    for (let attempt = 0; attempt < preparationAttempts; attempt += 1) {
      await expect
        .poll(conversationChanges.blockedWaiterCount)
        .toBeGreaterThanOrEqual(1);
      if (attempt + 1 < preparationAttempts) {
        conversationChanges.queueNextChange();
        await expect.poll(conversationChanges.queuedChangeIsBlocked).toBe(true);
      }
      conversationChanges.release();
      if (attempt + 1 < preparationAttempts) {
        await expect
          .poll(conversationChanges.stagedChangeCount)
          .toBe(attempt + 2);
      }
    }
    await conversationChanges.done;
    const failed = await failedPromise;
    expect(failed).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });

    const retryEvents = sandboxOperationEvents().filter((event) => {
      return (
        event.op_type === "chat_thread_session_binding_retry" &&
        event.chat_thread_id === first.threadId
      );
    });
    expect(retryEvents).toHaveLength(preparationAttempts);
    expect(retryEvents).toStrictEqual(
      expect.arrayContaining(
        Array.from({ length: preparationAttempts }, () => {
          return expect.objectContaining({
            agent_session_id: firstBinding.agent_session_id,
            binding_action: "retried",
            resolution_action: "reused",
            retry_reason: "session_changed",
          });
        }),
      ),
    );
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toStrictEqual(firstBinding);
  }, 90_000);

  it("rotates after a custom gateway is deleted and replaced by its legacy adapter", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const created = await accept(
      modelProviderConnectionsClient().create({
        headers: sessionHeaders(actor),
        body: {
          displayName: "Deleted session gateway",
          secret: "deleted-session-gateway-secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com/anthropic",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {
                "claude-sonnet-5": "anthropic/claude-sonnet-4.6",
              },
            },
          ],
        },
      }),
      [201],
    );
    const surfaceId = created.body.surfaces[0]?.id;
    if (!surfaceId) {
      throw new Error("Expected the custom gateway to have a surface");
    }
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "vercel-ai-gateway",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: surfaceId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish a custom gateway session",
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const originalBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the custom gateway route to bind a session");
    }

    await accept(
      modelProviderConnectionsByIdClient().delete({
        headers: sessionHeaders(actor),
        params: { id: created.body.id },
      }),
      [204],
    );
    const { providerId: legacyProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "vercel-ai-gateway",
        secret: "replacement-legacy-vercel-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "vercel-ai-gateway",
        credentialScope: "org",
        modelProviderId: legacyProviderId,
      },
    ]);

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "rotate away from the deleted custom surface",
    });
    const rotatedBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(rotatedBinding.agent_session_id).not.toBe(
      originalBinding.agent_session_id,
    );
    expect(rotatedBinding).toMatchObject({
      agent_session_run_id: second.runId,
      run_session_id: rotatedBinding.agent_session_id,
    });
    expect(sandboxOperationEventsForRun(second.runId)).toContainEqual(
      expect.objectContaining({
        op_type: "chat_thread_session_binding_persisted",
        chat_thread_id: first.threadId,
        agent_session_id: rotatedBinding.agent_session_id,
        agent_session_run_id: second.runId,
        binding_action: "rotated",
      }),
    );
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("rotates from the latest session run when binding provenance is deleted", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the original provider route",
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "advance binding provenance on the same route",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    // Settle terminal materialization before simulating later retention.
    await flushWaitUntilForTest();
    const originalBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the original route to bind a session");
    }

    await deleteAgentRunFixture({ runId: second.runId });
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: originalBinding.agent_session_id,
      agent_session_run_id: null,
      run_session_id: null,
    });

    const { providerId: openRouterProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openrouter-api-key",
        secret: "provenance-fallback-openrouter-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openRouterProviderId,
      },
    ]);

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "rotate after the provenance run is removed",
    });
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
    expect(sandboxOperationEventsForRun(third.runId)).toContainEqual(
      expect.objectContaining({
        op_type: "chat_thread_session_binding_persisted",
        chat_thread_id: first.threadId,
        agent_session_id: rotatedBinding.agent_session_id,
        agent_session_run_id: third.runId,
        binding_action: "rotated",
      }),
    );
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, third.runId);
  }, 90_000);

  it("re-resolves a sticky model through the current provider policy", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin sonnet model-first",
      model: "claude-sonnet-5",
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
      "claude-sonnet-5",
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
        model: "claude-sonnet-5",
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
    expect(environment.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after).not.toHaveProperty("selectedModel");
    expect(after).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
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
        model: "claude-sonnet-5",
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
      "claude-sonnet-5",
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
    const invalidModel = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unsupported vm0 model",
        clientThreadId: vm0ThreadId,
        model: "codex" as never,
      },
      [400],
    );
    expectApiError(invalidModel.body);
    expect(invalidModel.body.error.message).toBe("Invalid input");
    await chat.requestReadThread(actor, vm0ThreadId, [404]);

    const unavailableThreadId = randomUUID();
    const unavailable = await chat.requestSendEvent(
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
      const removed = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: `removed ${selectedModel}`,
          clientThreadId: removedThreadId,
          model: selectedModel as never,
        },
        [400],
      );
      expectApiError(removed.body);
      expect(removed.body.error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Invalid input",
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
    let thinkingRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    const titleResponse = "Launch Checklist";
    const thinkingResponse =
      "Reviewing the launch request and recent context.\nIdentifying the checklist's major sections.\nChecking where owners and timing matter.\nPreparing a clear order for the response.";
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
            thinkingRequestBody = payload;
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
          message.eventType === "output.thinking" &&
          message.runId === run.runId &&
          message.content === null &&
          message.thinking === thinkingResponse
        );
      });
    });
    await waitForThreadTitle(actor, run.threadId, titleResponse);
    const marker = assistantMessages(page.events).find((message) => {
      return (
        message.eventType === "output.thinking" &&
        message.runId === run.runId &&
        message.thinking === thinkingResponse
      );
    });
    expect(marker).toMatchObject({
      eventType: "output.thinking",
      content: null,
      runId: run.runId,
      runEventId: "thinking:initial",
      thinking: thinkingResponse,
    });
    expect(thinkingAuthorization).toBe("Bearer thinking-key");
    expect(thinkingRequestBody).toMatchObject({
      model: "google/gemini-3.1-flash-lite-preview",
      max_tokens: 160,
      reasoning: { effort: "none" },
    });
    expect(thinkingPromptPayload).toContain("one paragraph at a time");
    expect(thinkingPromptPayload).toContain(
      "about 20 Chinese characters or 7 English words",
    );
    expect(thinkingPromptPayload).toContain("around four short paragraphs");
    expect(thinkingPromptPayload).toContain("Do not answer the user");
    expect(thinkingPromptPayload).toContain("Do not reveal hidden reasoning");
    expect(thinkingPromptPayload).toContain(
      "Match the current user's language",
    );
    expect(thinkingPromptPayload).toContain("Draft a launch checklist");
    await flushWaitUntilForTest();
    expect(firstAssistantEventsForRun(run.runId)).toStrictEqual([]);

    await cancelChatRun(actor, run.runId);
  });

  it("discards token-limited progress copy instead of persisting a truncated marker", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");

    let thinkingRequests = 0;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (systemContent.includes("Write user-visible progress copy")) {
            thinkingRequests += 1;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "length",
                  native_finish_reason: "MAX_TOKENS",
                  message: {
                    content: "Incomplete progress copy that must not persist",
                  },
                },
              ],
            });
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Token Limit Title" },
              },
            ],
          });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Draft a concise migration update",
    });
    await flushWaitUntilForTest();

    const page = await chat.listThreadEvents(actor, run.threadId);
    expect(thinkingRequests).toBe(1);
    expect(
      assistantMessages(page.events).some((message) => {
        return (
          message.runId === run.runId &&
          message.runEventId === "thinking:initial"
        );
      }),
    ).toBeFalsy();

    await cancelChatRun(actor, run.runId);
  });
});

describe("CHAT-02: prior rounds and thread titles", () => {
  it("leaves prior completed rounds to the session, generates the thread title, and accepts immutable follow-up revokes", async () => {
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
        return recommendedFollowupEvents(items, first.runId).some((message) => {
          return resolveChatEventRecommendedFollowups(message).length > 0;
        });
      },
    );
    const recommender = recommendedFollowupEvents(
      afterFirst.events,
      first.runId,
    ).find((message) => {
      return resolveChatEventRecommendedFollowups(message).length > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups message");
    }
    expect(recommender.eventType).toBe("output.followups");
    const futureFollowups = resolveChatEventRecommendedFollowups(recommender);
    expect(futureFollowups.length).toBeGreaterThan(0);
    const futureFollowupContent = recommender.content;
    expect(futureFollowupContent).not.toBeNull();

    const futureEvents = await chat.listThreadEvents(actor, first.threadId);
    expect(futureEvents.events).toContainEqual(
      expect.objectContaining({
        id: recommender.id,
        eventType: "output.followups",
        content: futureFollowupContent,
      }),
    );
    expect(
      futureEvents.events.find((event) => {
        return event.id === recommender.id;
      }),
    ).not.toHaveProperty("recommendedFollowups");

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
    // The reused CLI session already holds the completed round, so the prompt
    // only points at the thread instead of replaying it.
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("Assistant: Assistant migration answer");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    expect(appended).not.toContain(futureFollowupContent);
    for (const followup of futureFollowups) {
      expect(appended).not.toContain(followup.prompt);
    }

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

    const recommendedFollowupQueueEventId = randomUUID();
    const normalFollowup = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "use the recommended follow-up",
        revokesEventId: recommender.id,
        clientEventId: recommendedFollowupQueueEventId,
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
            message.revokesEventId === recommendedFollowupQueueEventId &&
            message.runId === normalFollowupRunId
          );
        });
      },
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        id: recommendedFollowupQueueEventId,
        eventType: "input.prompt",
        revokesEventId: recommender.id,
      }),
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        revokesEventId: recommendedFollowupQueueEventId,
        runId: normalFollowupRunId,
      }),
    );
    await cancelChatRun(actor, normalFollowupRunId);
  }, 90_000);

  it("steers an active-run recommended follow-up", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "followup-steer-key");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          return HttpResponse.json({
            choices: [
              {
                message: {
                  content: systemContent.includes("concise follow-up prompts")
                    ? JSON.stringify([
                        {
                          prompt: "Use the recommended follow-up",
                          kind: "talk",
                        },
                      ])
                    : "Follow-up steer",
                },
              },
            ],
          });
        },
      ),
    );

    const completed = await sendChatRun(actor, {
      agentId,
      prompt: "prepare a recommended follow-up",
    });
    const completedClaim = await claimChatRun(runnerGroup, completed.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "A completed answer with follow-ups"),
    ]);
    await completeChatRunOk(completed.runId, completedClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    const completedEvents = await waitForThreadMessages(
      actor,
      completed.threadId,
      (events) => {
        return recommendedFollowupEvents(events, completed.runId).some(
          (event) => {
            return resolveChatEventRecommendedFollowups(event).length > 0;
          },
        );
      },
    );
    const recommender = recommendedFollowupEvents(
      completedEvents.events,
      completed.runId,
    ).find((event) => {
      return resolveChatEventRecommendedFollowups(event).length > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups event");
    }

    const active = await sendChatRun(actor, {
      agentId,
      threadId: completed.threadId,
      prompt: "keep working while the follow-up is steered",
    });
    const activeClaim = await claimChatRun(runnerGroup, active.runId);
    const eventId = randomUUID();
    const followup = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: completed.threadId,
        prompt: "steer the recommended follow-up",
        revokesEventId: recommender.id,
        clientEventId: eventId,
      },
      [201],
    );
    if (followup.status !== 201) {
      throw new Error("Expected the recommended follow-up to succeed");
    }
    expect(followup.body.runId).toBeNull();
    await expect(
      api.listRunnerActiveInputs(activeClaim.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual([eventId]);
    await expect(
      api.claimRunnerActiveInputs(
        activeClaim.claim.sandboxToken,
        active.runId,
        [eventId],
      ),
    ).resolves.toBe("steer the recommended follow-up");

    const afterFollowup = await waitForThreadMessages(
      actor,
      completed.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return (
            event.revokesEventId === eventId && event.runId === active.runId
          );
        });
      },
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        id: eventId,
        eventType: "input.prompt",
        revokesEventId: recommender.id,
      }),
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        revokesEventId: eventId,
        runId: active.runId,
      }),
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);
});

describe("CHAT-02: generation templates and attachments", () => {
  it("keeps Morning Brief metadata out of the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const prompt = "Generate my Morning Brief for 2026-08-05.";
    const baseline = await sendChatRun(actor, {
      agentId,
      prompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: prompt }],
      },
    });
    const withMorningBriefPart = await sendChatRun(actor, {
      agentId,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: prompt },
          { type: "morning_brief", briefDate: "2026-08-05" },
        ],
      },
    });

    const baselineRun = await api.readRun(actor, baseline.runId);
    const morningBriefRun = await api.readRun(
      actor,
      withMorningBriefPart.runId,
    );
    expect(morningBriefRun.prompt).toBe(baselineRun.prompt);
    expect(morningBriefRun.prompt).toBe(prompt);

    await cancelChatRun(actor, baseline.runId);
    await cancelChatRun(actor, withMorningBriefPart.runId);
  }, 90_000);

  it("uses the userMessage document for the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

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
    const userMessage: UserMessageInputDocument = {
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
          eventId: "assistant-event-first-quote",
          range: { start: 0, end: 11 },
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
        {
          type: "source",
          kind: "slack",
          href: "https://vm0.slack.com/archives/C123/p456",
        },
      ],
    };
    chat.mockCompletedUploadObject(actor, fileId, "brief.pdf", 42);

    const sent = await sendChatRun(actor, {
      agentId,
      prompt,
      userMessage,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `[Template #1: ${style.title} (illustration)]`,
        `[Web file] brief.pdf (application/pdf)\n   [ID] ${fileId}`,
        prompt,
      ].join("\n\n"),
    );
    expect(run.appendSystemPrompt).toContain("# Inline Templates");
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
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });

    const previousAppPage = await accept(
      chatThreadEventsClient().list({
        headers: sessionHeaders(actor),
        extraHeaders: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: "0.734.0",
        },
        params: { threadId: sent.threadId },
        query: { limit: 50 },
      }),
      [200],
    );
    const previousAppMessage = previousAppPage.body.events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === sent.runId;
    });
    if (previousAppMessage?.eventType !== "input.prompt") {
      throw new Error("Expected the previous App input event projection");
    }
    const previousAppFeedback = previousAppMessage.userMessage.parts.find(
      (part) => {
        return part.type === "feedback" && part.quote === "First quote";
      },
    );
    expect(
      previousAppFeedbackPartSchema.parse(previousAppFeedback),
    ).toStrictEqual({
      type: "feedback",
      quote: "First quote",
      note: [{ type: "text", text: "Clarify this point" }],
      source: {
        type: "mail",
        id: mailDraftId,
        status: "draft",
      },
    });

    const taggedAppPage = await accept(
      chatThreadEventsClient().list({
        headers: sessionHeaders(actor),
        extraHeaders: {
          [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
          [CLIENT_VERSION_HEADER]: clientVersionWithTag(
            "0.734.0",
            CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
          ),
        },
        params: { threadId: sent.threadId },
        query: { limit: 50 },
      }),
      [200],
    );
    const taggedAppMessage = taggedAppPage.body.events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === sent.runId;
    });
    if (taggedAppMessage?.eventType !== "input.prompt") {
      throw new Error("Expected the tagged App input event");
    }
    expect(
      taggedAppMessage.userMessage.parts.find((part) => {
        return part.type === "feedback" && part.quote === "First quote";
      }),
    ).toMatchObject({
      eventId: "assistant-event-first-quote",
      range: { start: 0, end: 11 },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("projects multiple inline templates into one ordered prompt and one shared context", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    const workflow = WORKFLOW_TEMPLATE_ITEMS[0];
    if (!style || !workflow) {
      throw new Error("Expected registered inline templates");
    }
    const illustrationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const workflowTemplate: GenerationTemplateRequest = {
      type: "workflow",
      selection: { workflowTemplateId: workflow.id },
    };
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Use " },
        {
          type: "template",
          titleSnapshot: style.title,
          template: illustrationTemplate,
        },
        { type: "text", text: " for the dog, then " },
        {
          type: "template",
          titleSnapshot: workflow.title,
          template: workflowTemplate,
        },
        { type: "text", text: " for the follow-up" },
        {
          type: "feedback",
          quote: "Earlier answer",
          note: [
            { type: "text", text: "Restyle with " },
            {
              type: "template",
              titleSnapshot: style.title,
              template: illustrationTemplate,
            },
          ],
        },
      ],
    };

    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "legacy fallback",
      userMessage,
    });
    const run = await api.readRun(actor, sent.runId);
    const firstMarker = `[Template #1: ${style.title} (illustration)]`;
    const secondMarker = `[Template #2: ${workflow.title} (workflow)]`;
    const feedbackMarker = `[Template #3: ${style.title} (illustration)]`;
    expect(run.prompt).toContain(
      `Use ${firstMarker} for the dog, then ${secondMarker} for the follow-up`,
    );
    expect(run.prompt).toContain(`Restyle with ${feedbackMarker}`);
    expect(run.prompt.indexOf(firstMarker)).toBeLessThan(
      run.prompt.indexOf(secondMarker),
    );

    const systemPrompt = run.appendSystemPrompt ?? "";
    expect(systemPrompt.match(/^# Inline Templates$/gm)).toHaveLength(1);
    expect(systemPrompt).not.toContain("# Artifact Template Context");
    expect(systemPrompt).not.toContain("# Workflow Template Context");
    expect(systemPrompt).toContain("## Template #1 (illustration)");
    expect(systemPrompt).toContain("## Template #2 (workflow)");
    expect(systemPrompt).toContain("## Template #3 (illustration)");
    expect(systemPrompt).toContain(style.illustrationStyleId);
    expect(systemPrompt).toContain(workflow.id);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("preserves the attachment userMessage order in the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const fileId = randomUUID();
    chat.mockCompletedUploadObject(actor, fileId, "api-input.txt", 12);
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "plain API attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "api-input.txt",
            contentType: "text/plain",
          },
          { type: "text", text: "plain API attachment" },
        ],
      },
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `[Web file] api-input.txt (text/plain)\n   [ID] ${fileId}`,
        "plain API attachment",
      ].join("\n\n"),
    );
    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    expect(
      userMessages(messages.events).find((message) => {
        return message.runId === sent.runId;
      }),
    ).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "api-input.txt",
            contentType: "text/plain",
          },
          { type: "text", text: "plain API attachment" },
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });
    expect(
      chatEventDisplayText(
        userMessages(messages.events).find((message) => {
          return message.runId === sent.runId;
        })!,
      ),
    ).toBe("plain API attachment");
    await cancelChatRun(actor, sent.runId);
  }, 60_000);

  it("uses only the canonical template part", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "draw a dog",
      template: generationTemplate,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      "draw a dog\n\n[Template #1: Illustration template (illustration)]",
    );
    const systemPrompt = run.appendSystemPrompt ?? "";
    expect(systemPrompt).toContain("# Inline Templates");
    expect(systemPrompt).toContain(style.illustrationStyleId);
    const messages = await chat.listThreadEvents(actor, sent.threadId);
    const message = userMessages(messages.events).find((event) => {
      return event.eventType === "input.prompt" && event.runId === sent.runId;
    });
    expect(message).toMatchObject({
      userMessage: {
        version: 1,
        parts: expect.arrayContaining([
          {
            type: "template",
            titleSnapshot: "Illustration template",
            template: generationTemplate,
          },
        ]),
      },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

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
      template: {
        type: "presentation",
        selection: {
          colorSystemId: template.colorSystemId,
          templateId: template.templateId,
        },
      },
    });
    const presentationRun = await api.readRun(actor, presentation.runId);
    expect(presentationRun.prompt).toBe(
      "make a launch deck\n\n[Template #1: Presentation template (presentation)]",
    );
    const presentationPrompt = presentationRun.appendSystemPrompt ?? "";
    expect(presentationPrompt).toContain("# Inline Templates");
    expect(presentationPrompt).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(presentationPrompt).not.toContain("Selected design system");
    expect(presentationPrompt).toContain(
      `okou resource pull ${template.templateId}-runbook --dir ./generated/resources`,
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
      "okou generate presentation --design-system",
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
      template: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const videoRun = await api.readRun(actor, video.runId);
    const videoPrompt = videoRun.appendSystemPrompt ?? "";
    expect(videoPrompt).toContain("# Inline Templates");
    expect(videoPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(videoPrompt).toContain(
      `okou generate video --provider built-in --template ${videoTemplate.id}`,
    );
    expect(videoPrompt).not.toContain("Parameters the user set explicitly");
    await cancelChatRun(actor, video.runId);

    const videoWithOptions = await sendChatRun(actor, {
      agentId,
      prompt: "make a vertical product video",
      template: {
        type: "video",
        selection: {
          stylePresetId: videoTemplate.id,
          videoOptions: {
            model: "fal-ai/veo3.1/fast",
            aspectRatio: "9:16",
            // Veo accepts only 4s, 6s, or 8s, so this one is dropped instead
            // of being pinned into a request the service would reject.
            duration: "5s",
            resolution: "1080p",
          },
        },
      },
    });
    const videoWithOptionsRun = await api.readRun(
      actor,
      videoWithOptions.runId,
    );
    const videoWithOptionsPrompt = videoWithOptionsRun.appendSystemPrompt ?? "";
    expect(videoWithOptionsPrompt).toContain(
      "Parameters the user set explicitly",
    );
    expect(videoWithOptionsPrompt).toContain("- Model: veo3.1-fast");
    expect(videoWithOptionsPrompt).toContain("- Aspect ratio: 9:16");
    expect(videoWithOptionsPrompt).toContain("- Resolution: 1080p");
    expect(videoWithOptionsPrompt).not.toContain("Duration:");
    expect(videoWithOptionsPrompt).toContain(
      "`--model veo3.1-fast --aspect-ratio 9:16 --resolution 1080p` verbatim",
    );
    await cancelChatRun(actor, videoWithOptions.runId);

    const avatarId = 81;
    const avatarVoiceId = "en-US-ChristopherNeural";
    const avatar = await sendChatRun(actor, {
      agentId,
      prompt: "make a presenter video",
      template: {
        type: "video",
        selection: {
          stylePresetId: avatarTemplateStylePresetId(avatarId),
          titleSnapshot: "Do not inject this avatar name",
          previewUrl: "https://example.com/untrusted-avatar.jpg",
          voiceId: avatarVoiceId,
          aspectRatio: "landscape",
        },
      },
    });
    const avatarRun = await api.readRun(actor, avatar.runId);
    const avatarPrompt = avatarRun.appendSystemPrompt ?? "";
    expect(avatarPrompt).toContain("# Inline Templates");
    expect(avatarPrompt).toContain(`Public JoggAI avatar ID: ${avatarId}`);
    expect(avatarPrompt).toContain(`Public JoggAI voice ID: ${avatarVoiceId}`);
    expect(avatarPrompt).toContain("Aspect ratio: landscape");
    expect(avatarPrompt).not.toContain("--list-voices");
    expect(avatarPrompt).toContain(
      `okou generate avatar-video --provider built-in --avatar-id ${avatarId} --voice-id ${avatarVoiceId} --aspect-ratio landscape`,
    );
    expect(avatarPrompt).not.toContain("Do not inject this avatar name");
    expect(avatarPrompt).not.toContain("untrusted-avatar.jpg");
    await cancelChatRun(actor, avatar.runId);

    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0];
    if (!websiteTemplate) {
      throw new Error("Expected a registered website template");
    }
    const website = await sendChatRun(actor, {
      agentId,
      prompt: "make a campaign landing page",
      template: {
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      },
    });
    const websiteRun = await api.readRun(actor, website.runId);
    const websitePrompt = websiteRun.appendSystemPrompt ?? "";
    expect(websitePrompt).toContain("# Inline Templates");
    expect(websitePrompt).toContain(
      `Template: ${websiteTemplate.title} (${websiteTemplate.id})`,
    );
    expect(websitePrompt).toContain(
      "okou resource pull template:black-slabs --dir ./generated/resources",
    );
    expect(websitePrompt).toContain(
      `./generated/resources/${websiteTemplate.sourcePath}/render.mjs`,
    );
    expect(websitePrompt).toContain(
      "use `seedream4` by default unless the user specifies another image model",
    );
    expect(websitePrompt).toContain("okou host <output-dir> --site <slug>");
    await cancelChatRun(actor, website.runId);
  }, 90_000);

  it("uses R2 for archive-backed styles", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.illustrationStyleId === "image-style:ink-storefront";
    });
    if (!style) {
      throw new Error("Expected the ink-storefront illustration style");
    }

    const defaultR2Run = await sendChatRun(actor, {
      agentId,
      prompt: "draw a flower shop from the default R2 source",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const defaultR2Prompt =
      (await api.readRun(actor, defaultR2Run.runId)).appendSystemPrompt ?? "";
    expect(defaultR2Prompt).toContain(
      "Style source: private R2 registry resource image-style:ink-storefront",
    );
    expect(defaultR2Prompt).toContain("--compile --style-source r2");
    await cancelChatRun(actor, defaultR2Run.runId);
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
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const firstPrompt = (await api.readRun(actor, first.runId))
      .appendSystemPrompt;
    expect(firstPrompt).toContain("# Inline Templates");
    expect(firstPrompt).toContain(
      `okou generate image --provider built-in --style ${style.illustrationStyleId} --prompt "<user request>" --compile`,
    );
    expect(firstPrompt).toContain("Follow the returned packet completely");
    expect(firstPrompt).toContain(
      "If the R2 source is unavailable, stop without generating; do not fall back to GitHub.",
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
    expect(secondPrompt).not.toContain("# Inline Templates");
    expect(secondPrompt).toContain("# This Chat Thread");
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
      template: {
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
      `okou generate video --provider built-in --template ${videoTemplate.id}`,
    );
    expect(thirdPrompt).toContain("# Incomplete Rounds Context");
    expect(thirdPrompt).not.toContain("# Web Chat Run Context");
    // The illustration style is gone entirely for this turn: it's not attached
    // to this message, and prior/incomplete context no longer repeats template
    // selections.
    expect(thirdPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, third.runId);

    // A brand-new thread starts clean: neither template carries over.
    const fresh = await sendChatRun(actor, { agentId, prompt: "draw a cat" });
    const freshPrompt = (await api.readRun(actor, fresh.runId))
      .appendSystemPrompt;
    expect(freshPrompt).not.toContain("# Inline Templates");
    expect(freshPrompt).not.toContain(
      "okou generate image --provider built-in --style",
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
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const illustrationPrompt = (await api.readRun(actor, illustration.runId))
      .appendSystemPrompt;
    expect(illustrationPrompt).toContain("# Inline Templates");
    expect(illustrationPrompt).toContain(style.illustrationStyleId);
    await cancelChatRun(actor, illustration.runId);

    const workflow = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "create the workflow version",
      template: {
        type: "workflow",
        selection: { workflowTemplateId: workflowTemplate.id },
      },
    });
    const workflowPrompt = (await api.readRun(actor, workflow.runId))
      .appendSystemPrompt;
    expect(workflowPrompt).toContain("# Inline Templates");
    expect(workflowPrompt).toContain(
      `Auto-inbox label (${workflowTemplate.id})`,
    );
    expect(workflowPrompt).toContain("Use the workflow-setup skill");
    expect(workflowPrompt).toContain(
      "Save the reusable workflow draft as soon as the template behavior is clear.",
    );
    expect(workflowPrompt).not.toContain("Before creating anything");
    expect(workflowPrompt).toContain("Gmail label-applied automation");
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
    expect(followUpPrompt).not.toContain("# Inline Templates");
    expect(followUpPrompt).not.toContain(workflowTemplate.id);
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
      readonly template: GenerationTemplateRequest;
      readonly message: string;
    }[] = [
      {
        template: {
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
        template: {
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
        template: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        template: {
          type: "video",
          selection: { stylePresetId: "video-style:missing" },
        },
        message: "Unknown video template",
      },
      {
        template: {
          type: "workflow",
          selection: { workflowTemplateId: "workflow-template:missing" },
        },
        message: "Unknown workflow template",
      },
      {
        template: {
          type: "website",
          selection: { websiteTemplateId: "website-template:missing" },
        },
        message: "Unknown website template",
      },
    ];
    for (const arm of arms) {
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "make something from a bad template",
          userMessage: userMessageWithTemplate(
            "make something from a bad template",
            arm.template,
          ),
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
    chat.mockCompletedUploadObject(actor, fileId, filename, 42);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read this file",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "image/png",
          },
          { type: "text", text: "read this file" },
        ],
      },
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filename} (image/png)`);
    expect(created.prompt).toContain(`[ID] ${fileId}`);
    expect(created.appendSystemPrompt).toContain("okou web download-file -h");
    expect(created.appendSystemPrompt).toContain("okou web upload-file -h");

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            message.userMessage?.parts.some((part) => {
              return part.type === "file";
            }) === true
          );
        });
      },
    );
    const attachedMessage = userMessages(messages.events).find((message) => {
      return message.eventType === "input.prompt";
    });
    const attached = attachedMessage?.userMessage?.parts.find((part) => {
      return part.type === "file";
    });
    expect(attached).toMatchObject({
      type: "file",
      fileId,
      filenameSnapshot: filename,
      contentType: "image/png",
    });
    await cancelChatRun(actor, run.runId);
  }, 60_000);
});

describe("CHAT-02: queued attachments on auto-send", () => {
  it("preserves structured part order when a queued message is promoted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

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
    const userMessage: UserMessageInputDocument = {
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
    chat.mockCompletedUploadObject(actor, fileId, "ordered.txt", 12);
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: queuedPrompt,
        userMessage,
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the structured queued message to auto-send");
    }
    expect(promoted.userMessage).toStrictEqual({
      version: 1,
      parts: [
        ...userMessage.parts,
        {
          type: "model",
          selectedModel: "claude-sonnet-5",
        },
      ],
    });

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
    const secondFileId = randomUUID();
    const queuedId = randomUUID();
    chat.mockCompletedUploadObjects(actor, [
      { id: fileId, filename: "notes.txt", size: 12 },
      { id: secondFileId, filename: "details.json", size: 24 },
    ]);
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued with attachment",
        clientEventId: queuedId,
        realAgentInPreview: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "notes.txt",
              contentType: "text/plain",
            },
            {
              type: "file",
              fileId: secondFileId,
              filenameSnapshot: "details.json",
              contentType: "application/json",
            },
            { type: "text", text: "queued with attachment" },
          ],
        },
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    // Completing the anchor run promotes the queued message into a fresh
    // run whose prompt carries the resolved attachment references.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to auto-send into a run");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe("queued with attachment");
    expect(promoted.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([
        {
          type: "file",
          fileId,
          filenameSnapshot: "notes.txt",
          contentType: "text/plain",
        },
        {
          type: "file",
          fileId: secondFileId,
          filenameSnapshot: "details.json",
          contentType: "application/json",
        },
      ]),
    );
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original).toMatchObject({
      id: queuedId,
      content: null,
    });
    expect(chatEventDisplayText(original)).toBe("queued with attachment");
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queued with attachment");
    expect(followUp.prompt).toContain("[Web file] notes.txt (text/plain)");
    expect(followUp.prompt).toContain(`[ID] ${fileId}`);
    expect(followUp.prompt).toContain(
      "[Web file] details.json (application/json)",
    );
    expect(followUp.prompt).toContain(`[ID] ${secondFileId}`);
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02: run-scoped Zero-token chat launches", () => {
  it("keeps immediate and queued runs agent-scoped without retired provenance", async () => {
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const caller = await sendChatRun(actor, {
      agentId,
      prompt: "launch chat work from this run",
    });
    const zeroToken = api.zeroTokenForRunWithCapabilities(actor, caller.runId, [
      "chat-thread:read",
      "chat-thread:write",
      "chat-event:read",
      "chat-event:write",
    ]);

    const createdThread = await accept(
      chatThreadsClient().create({
        headers: { authorization: `Bearer ${zeroToken}` },
        body: { agentId, title: "Run-scoped handoff" },
      }),
      [201],
    );
    const immediate = await requestSendEventWithBearer(
      zeroToken,
      {
        agentId,
        threadId: createdThread.body.id,
        prompt: "immediate run-scoped handoff",
      },
      [201],
    );
    if (immediate.status !== 201) {
      throw new Error("Expected the run-scoped handoff request to succeed");
    }
    if (!immediate.body.runId) {
      throw new Error("Expected the run-scoped handoff to launch immediately");
    }

    await expect(
      api.readRun(actor, immediate.body.runId),
    ).resolves.toMatchObject({
      runId: immediate.body.runId,
      prompt: "immediate run-scoped handoff",
    });
    await expect(
      readRunAutonomyBudgetFixture(context, caller.runId),
    ).resolves.toBe(10);
    await expect(
      readRunAutonomyBudgetFixture(context, immediate.body.runId),
    ).resolves.toBe(9);
    // Neither callback internals nor retired provenance are public API fields.
    // The test-only state route is the only boundary that can prove their
    // absence without importing database schemas or production services.
    const immediateState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: immediate.body.runId,
      },
      context.signal,
    );
    expect(immediateState.zero_run).toMatchObject({
      triggerSource: "agent",
    });
    expect(
      immediateState.callbacks.map((callback) => {
        return callback.internalKind;
      }),
    ).toStrictEqual(["chat"]);

    const queuedEventId = randomUUID();
    const queued = await requestSendEventWithBearer(
      zeroToken,
      {
        agentId,
        clientEventId: queuedEventId,
        threadId: createdThread.body.id,
        prompt: "queued run-scoped handoff",
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued run-scoped request to succeed");
    }
    expect(queued.body.runId).toBeNull();

    await cancelChatRun(actor, immediate.body.runId);
    const promotedMessages = await waitForThreadMessages(
      actor,
      createdThread.body.id,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(promotedMessages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedEventId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the queued run-scoped handoff to promote");
    }

    await expect(api.readRun(actor, promoted.runId)).resolves.toMatchObject({
      runId: promoted.runId,
      prompt: "queued run-scoped handoff",
    });
    await expect(
      readRunAutonomyBudgetFixture(context, promoted.runId),
    ).resolves.toBe(9);
    const promotedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: promoted.runId,
      },
      context.signal,
    );
    expect(promotedState.zero_run).toMatchObject({
      triggerSource: "agent",
    });
    expect(
      promotedState.callbacks.map((callback) => {
        return callback.internalKind;
      }),
    ).toStrictEqual(["chat"]);

    await cancelChatRun(actor, promoted.runId);
    await cancelChatRun(actor, caller.runId);
  }, 90_000);
});

describe("CHAT-02/FILE-03: computer-use host grants", () => {
  it("grants computer-use capability only for a selected host", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { hostId, hostToken } = await cu.startComputerUseHost(actor);

    // The thread's sticky host is not exposed by any read route, so the
    // grant is observed through the run token issued to each claim: a
    // granted token can create write commands on the host, while an
    // ungranted token cannot. Chat messaging remains available independently.
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
    const nestedEventId = randomUUID();
    const nestedSend = await requestSendEventWithBearer(
      plainToken,
      {
        agentId,
        clientEventId: nestedEventId,
        threadId: plain.threadId,
        prompt: "run tokens can send chat messages",
      },
      [201],
    );
    expect(nestedSend.status).toBe(201);
    expect(nestedSend.body).toMatchObject({ runId: null });
    const recalled = await accept(
      chatEventsClient().send({
        headers: { authorization: `Bearer ${plainToken}` },
        body: {
          agentId,
          threadId: plain.threadId,
          revokesEventId: nestedEventId,
          clientEventId: randomUUID(),
        },
      }),
      [201],
    );
    expect(recalled.body.runId).toBeNull();
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
    await cancelChatRun(actor, granted.runId, grantedClaim.sandboxHeaders);

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
    await cancelChatRun(actor, sticky.runId, stickyClaim.sandboxHeaders);

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
    await cancelChatRun(actor, cleared.runId, clearedClaim.sandboxHeaders);

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

    const unknownHost = await chat.requestSendEvent(
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
    const stoppedPinned = await chat.requestSendEvent(
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
    const revokedHost = await chat.requestSendEvent(
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
    const installedPinned = await chat.requestSendEvent(
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
    const stoppedInstalledHost = await chat.requestSendEvent(
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
    const survivorThread = await chat.requestSendEvent(
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
    const offlineHostSend = await chat.requestSendEvent(
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
    const staleStickySend = await chat.requestSendEvent(
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
    const referencedThreadId = randomUUID();
    const userMessage: UserMessageDocument = {
      version: 1,
      parts: [
        { type: "text", text: "queue-first " },
        {
          type: "chat_thread",
          threadId: referencedThreadId,
          titleSnapshot: "direct dispatch",
        },
        { type: "model", selectedModel: "gpt-5.6-sol" },
      ],
    };
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "queue-first direct dispatch",
        userMessage,
        clientEventId: messageId,
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
            message.revokesEventId === messageId && message.runId === runId
          );
        });
      },
    );
    const rows = userMessages(messages.events);
    expect(rows).toHaveLength(2);
    const claimed = rows.find((message) => {
      return message.revokesEventId === messageId;
    });
    expect(claimed).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts.filter((part) => {
            return part.type !== "model";
          }),
          {
            type: "model",
            selectedModel: "claude-sonnet-5",
          },
        ],
      },
      runId,
      revokesEventId: messageId,
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
      content: null,
      userMessage,
    });
    expect(queued.runId).toBeUndefined();

    const replay = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "queue-first direct dispatch",
        clientEventId: messageId,
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
    expect(claimedRun.claim.prompt).toBe(
      `queue-first [direct dispatch](/chats/${referencedThreadId})`,
    );
    await expect
      .poll(() => {
        const actionTypes = apiDispatchActionTypes(
          apiDispatchTimingEventsForRun(runId),
        );
        return [
          "api_dispatch_claim_queue_first_message",
          ...API_DISPATCH_QUEUE_FIRST_CLAIM_PHASE_ACTION_TYPES,
        ].every((actionType) => {
          return actionTypes.has(actionType);
        });
      })
      .toBe(true);
    const claimTimingEvents = apiDispatchTimingEventsForRun(runId);
    expectApiDispatchSpanKind(
      claimTimingEvents,
      API_DISPATCH_QUEUE_FIRST_CLAIM_PHASE_ACTION_TYPES,
      "nested",
    );
    for (const actionType of API_DISPATCH_QUEUE_FIRST_CLAIM_PHASE_ACTION_TYPES) {
      expect(claimTimingEvents).toContainEqual(
        expect.objectContaining({
          op_type: actionType,
          queue_first_association_kind: "user_message",
        }),
      );
    }

    await cancelChatRun(actor, runId);
  }, 90_000);

  it("persists agent-run provenance for messages sent across chat threads", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const firstTargetThread = await chat.createThread(actor, { agentId });
    const secondTargetThread = await chat.createThread(actor, { agentId });

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate work to other chat threads",
    });
    const { claim: sourceClaim, sandboxHeaders: sourceSandboxHeaders } =
      await claimChatRun(runnerGroup, source.runId);
    const sourceToken = zeroTokenFromClaim(sourceClaim);

    const firstEventId = randomUUID();
    const firstSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: firstEventId,
        threadId: firstTargetThread.id,
        prompt: "first delegated prompt",
      },
      [201],
    );
    if (firstSend.status !== 201) {
      throw new Error("Expected the first delegated prompt to be accepted");
    }
    if (!firstSend.body.runId) {
      throw new Error("Expected the first delegated prompt to launch a run");
    }
    const firstTargetRunId = firstSend.body.runId;
    await expect(
      readRunAutonomyBudgetFixture(context, source.runId),
    ).resolves.toBe(10);
    await expect(
      readRunAutonomyBudgetFixture(context, firstTargetRunId),
    ).resolves.toBe(9);
    const firstTargetRun = await api.readRun(actor, firstTargetRunId);
    const firstTargetSystemPrompt = firstTargetRun.appendSystemPrompt ?? "";
    expect(firstTargetSystemPrompt).toContain("# This Run's Trigger");
    expect(firstTargetSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(firstTargetSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    expect(firstTargetSystemPrompt).toContain(`SOURCE_AGENT_ID: ${agentId}`);
    expect(firstTargetSystemPrompt).toContain(
      "SOURCE_THREAD_TITLE: New thread",
    );
    expect(firstTargetSystemPrompt).toContain(
      `okou chat messages --thread-id ${source.threadId}`,
    );
    expect(firstTargetSystemPrompt).toContain(
      `okou logs ${source.runId} --all`,
    );
    const sourceRun = await api.readRun(actor, source.runId);
    expect(sourceRun.appendSystemPrompt ?? "").not.toContain(
      "# This Run's Trigger",
    );
    const firstMessages = await waitForThreadMessages(
      actor,
      firstTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === firstEventId;
        });
      },
    );
    const firstInput = userMessages(firstMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === firstEventId;
      },
    );
    expect(firstInput).toMatchObject({
      eventType: "input.prompt",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "first delegated prompt" },
          {
            type: "source",
            kind: "agent",
            runId: source.runId,
            threadId: source.threadId,
            agentId,
            titleSnapshot: "New thread",
            href: `/chats/${source.threadId}#run-${source.runId}`,
          },
        ],
      },
    });
    expect(firstInput?.runId).toBeUndefined();
    await chat.renameThread(actor, source.threadId, "Delegation source");
    const secondEventId = randomUUID();
    const secondSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: secondEventId,
        threadId: secondTargetThread.id,
        prompt: "second delegated prompt",
      },
      [201],
    );
    if (secondSend.status !== 201) {
      throw new Error("Expected the second delegated prompt to be accepted");
    }
    if (!secondSend.body.runId) {
      throw new Error("Expected the second delegated prompt to queue a run");
    }
    const secondTargetRunId = secondSend.body.runId;
    expect(secondSend.body.status).toBe("queued");
    await expect(
      readRunAutonomyBudgetFixture(context, secondTargetRunId),
    ).resolves.toBe(9);
    const secondMessages = await waitForThreadMessages(
      actor,
      secondTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === secondEventId;
        });
      },
    );
    const secondInput = userMessages(secondMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === secondEventId;
      },
    );
    expect(secondInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "Delegation source",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });

    await chat.renameThread(actor, source.threadId, "now");
    const nowTargetThread = await chat.createThread(actor, { agentId });
    const nowEventId = randomUUID();
    const nowSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: nowEventId,
        threadId: nowTargetThread.id,
        prompt: "delegated prompt from a placeholder thread title",
      },
      [201],
    );
    if (nowSend.status !== 201) {
      throw new Error("Expected the placeholder-title prompt to be accepted");
    }
    if (!nowSend.body.runId) {
      throw new Error("Expected the placeholder-title prompt to queue a run");
    }
    const nowTargetRunId = nowSend.body.runId;
    const nowMessages = await waitForThreadMessages(
      actor,
      nowTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === nowEventId;
        });
      },
    );
    const nowInput = userMessages(nowMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === nowEventId;
      },
    );
    expect(nowInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "New thread",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });
    const forgedTargetThread = await chat.createThread(actor, { agentId });
    const forgedEventId = randomUUID();
    const forged = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: forgedEventId,
        threadId: forgedTargetThread.id,
        prompt: "forged provenance",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "forged provenance" },
            {
              type: "source",
              kind: "agent",
              runId: randomUUID(),
              threadId: randomUUID(),
              agentId: randomUUID(),
              titleSnapshot: "Forged source",
              href: `/chats/${randomUUID()}#run-${randomUUID()}`,
            },
          ],
        },
      },
      [400],
    );
    expect(forged).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Agent source annotations are server-managed",
        },
      },
    });
    const messagesAfterForgedSend = await chat.listThreadEvents(
      actor,
      forgedTargetThread.id,
    );
    expect(messagesAfterForgedSend.events).not.toContainEqual(
      expect.objectContaining({ id: forgedEventId }),
    );

    await cancelChatRun(actor, nowTargetRunId);
    await cancelChatRun(actor, secondTargetRunId);
    await cancelChatRun(actor, firstTargetRunId);
    await cancelChatRun(actor, source.runId, sourceSandboxHeaders);
  }, 90_000);

  it("keeps Web context and tools for agent prompts sent into existing threads", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate into existing chat threads",
    });
    const { claim: sourceClaim, sandboxHeaders: sourceSandboxHeaders } =
      await claimChatRun(runnerGroup, source.runId);
    const sourceToken = zeroTokenFromClaim(sourceClaim);

    const rotatedAnchorPrompt = "prior Web round before an agent rotation";
    const rotatedAnchor = await sendChatRun(actor, {
      agentId,
      prompt: rotatedAnchorPrompt,
      model: "claude-sonnet-5",
    });
    const rotatedAnchorClaim = await claimChatRun(
      runnerGroup,
      rotatedAnchor.runId,
    );
    const originalBinding = await readThreadSessionBinding(
      context,
      rotatedAnchor.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the Web anchor to bind a session");
    }

    const { providerId: codexProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "agent-web-semantics-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);
    await chat.updateThreadModelSelection(
      actor,
      rotatedAnchor.threadId,
      "gpt-5.6-terra",
    );

    const rotatedEventId = randomUUID();
    const rotatedQueued = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: rotatedEventId,
        threadId: rotatedAnchor.threadId,
        prompt: "agent prompt after the Web session rotates",
      },
      [201],
    );
    if (rotatedQueued.status !== 201) {
      throw new Error("Expected the rotated agent prompt to queue");
    }
    expect(rotatedQueued.body.runId).toBeNull();

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(
      rotatedAnchor.runId,
      rotatedAnchorClaim.sandboxHeaders,
    );
    const rotatedMessages = await waitForThreadMessages(
      actor,
      rotatedAnchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === rotatedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const rotatedRunId = userMessages(rotatedMessages.events).find(
      (message) => {
        return message.revokesEventId === rotatedEventId;
      },
    )?.runId;
    if (!rotatedRunId) {
      throw new Error("Expected the rotated agent prompt to be promoted");
    }
    const rotatedRun = await api.readRun(actor, rotatedRunId);
    const rotatedSystemPrompt = rotatedRun.appendSystemPrompt ?? "";
    const rotatedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: rotatedRunId,
      },
      context.signal,
    );
    expect(rotatedState.zero_run).toMatchObject({ triggerSource: "agent" });
    expect(rotatedSystemPrompt).toContain("# Web Chat Run Context");
    expect(rotatedSystemPrompt).toContain("# This Run's Trigger");
    expect(rotatedSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(rotatedSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    expect(rotatedSystemPrompt).toContain(rotatedAnchorPrompt);
    expect(rotatedSystemPrompt).not.toContain("# Incomplete Rounds Context");
    expect(rotatedSystemPrompt).toContain("Web chat files: use");
    expect(rotatedSystemPrompt).toContain(
      "Cross-integration messages from web chat",
    );
    expect(rotatedSystemPrompt).toContain(
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    );
    const rotatedBinding = await readThreadSessionBinding(
      context,
      rotatedAnchor.threadId,
    );
    expect(rotatedBinding.agent_session_id).not.toBe(
      originalBinding.agent_session_id,
    );
    const rotatedClaim = await claimChatRun(runnerGroup, rotatedRunId);
    expect(rotatedClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, rotatedRunId, rotatedClaim.sandboxHeaders);

    const incompletePrompt = "failed Web round before an agent retry";
    const incomplete = await sendChatRun(actor, {
      agentId,
      prompt: incompletePrompt,
    });
    const incompleteClaim = await claimChatRun(runnerGroup, incomplete.runId);
    const incompleteEventId = randomUUID();
    const incompleteQueued = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: incompleteEventId,
        threadId: incomplete.threadId,
        prompt: "agent prompt after an incomplete Web round",
      },
      [201],
    );
    if (incompleteQueued.status !== 201) {
      throw new Error("Expected the incomplete agent prompt to queue");
    }
    expect(incompleteQueued.body.runId).toBeNull();

    await failChatRun(
      incomplete.runId,
      incompleteClaim.sandboxHeaders,
      "expected incomplete Web round",
    );
    const incompleteMessages = await waitForThreadMessages(
      actor,
      incomplete.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === incompleteEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const incompleteRunId = userMessages(incompleteMessages.events).find(
      (message) => {
        return message.revokesEventId === incompleteEventId;
      },
    )?.runId;
    if (!incompleteRunId) {
      throw new Error("Expected the incomplete agent prompt to be promoted");
    }
    const incompleteRun = await api.readRun(actor, incompleteRunId);
    const incompleteSystemPrompt = incompleteRun.appendSystemPrompt ?? "";
    const incompleteState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: incompleteRunId,
      },
      context.signal,
    );
    expect(incompleteState.zero_run).toMatchObject({ triggerSource: "agent" });
    expect(incompleteSystemPrompt).toContain("# Incomplete Rounds Context");
    expect(incompleteSystemPrompt).toContain(incompletePrompt);
    expect(incompleteSystemPrompt).not.toContain("# Web Chat Run Context");
    expect(incompleteSystemPrompt).toContain("Web chat files: use");
    const promotedIncompleteClaim = await claimChatRun(
      runnerGroup,
      incompleteRunId,
    );
    await cancelChatRun(
      actor,
      incompleteRunId,
      promotedIncompleteClaim.sandboxHeaders,
    );
    await cancelChatRun(actor, source.runId, sourceSandboxHeaders);
  }, 90_000);

  it("blocks cross-thread delegation from a zero-budget run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const target = await chat.createThread(actor, { agentId });
    const blockedTarget = await chat.createThread(actor, { agentId });
    const root = await sendChatRun(actor, {
      agentId,
      prompt: "start bounded delegation",
    });
    const rootClaim = await claimChatRun(runnerGroup, root.runId);
    await setRunAutonomyBudgetFixture(context, root.runId, 1);

    const delegated = await requestSendEventWithBearer(
      zeroTokenFromClaim(rootClaim.claim),
      {
        agentId,
        clientEventId: randomUUID(),
        threadId: target.id,
        prompt: "last allowed delegation",
      },
      [201],
    );
    if (delegated.status !== 201 || delegated.body.runId === null) {
      throw new Error("Expected the last allowed delegation to create a run");
    }
    await expect(
      readRunAutonomyBudgetFixture(context, delegated.body.runId),
    ).resolves.toBe(0);

    await completeChatRunOk(root.runId, rootClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const delegatedClaim = await claimChatRun(
      runnerGroup,
      delegated.body.runId,
    );

    const blockedEventId = randomUUID();
    const blocked = await requestSendEventWithBearer(
      zeroTokenFromClaim(delegatedClaim.claim),
      {
        agentId,
        clientEventId: blockedEventId,
        threadId: blockedTarget.id,
        prompt: "delegation beyond the limit",
      },
      [409],
    );
    expect(blocked).toMatchObject({
      status: 409,
      body: {
        error: { code: "AUTONOMY_BUDGET_EXHAUSTED" },
      },
    });
    const targetMessages = await chat.listThreadEvents(actor, blockedTarget.id);
    expect(targetMessages.events).not.toContainEqual(
      expect.objectContaining({ id: blockedEventId }),
    );

    await completeChatRunOk(
      delegated.body.runId,
      delegatedClaim.sandboxHeaders,
    );
    await flushWaitUntilForTest();
  }, 90_000);

  it("derives real-agent preview mode when queued messages are claimed", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const actorWithOrg = { ...actor, orgId: actor.orgId };
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "preview override queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const previewMessageId = randomUUID();
    const previewFileId = randomUUID();
    chat.mockCompletedUploadObject(
      actor,
      previewFileId,
      "preview-notes.txt",
      18,
    );
    const previewQueued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued real-agent preview run",
        clientEventId: previewMessageId,
        realAgentInPreview: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: previewFileId,
              filenameSnapshot: "preview-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "queued real-agent preview run" },
          ],
        },
      },
      [201],
    );
    expect(previewQueued.body).toMatchObject({ runId: null });
    const replayedPreviewMessageId = randomUUID();
    await replayPendingChatInputQueueEventFixture({
      eventId: previewMessageId,
      replacementId: replayedPreviewMessageId,
    });
    const mockMessageId = randomUUID();
    const mockQueued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued preview mock run",
        clientEventId: mockMessageId,
        realAgentInPreview: true,
      },
      [201],
    );
    expect(mockQueued.body).toMatchObject({ runId: null });
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: true,
    });

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
            message.revokesEventId === replayedPreviewMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const previewRunId = userMessages(previewMessages.events).find(
      (message) => {
        return message.revokesEventId === replayedPreviewMessageId;
      },
    )?.runId;
    if (!previewRunId) {
      throw new Error("Expected the preview override message to auto-send");
    }

    const previewClaim = await claimChatRun(runnerGroup, previewRunId);
    expect(previewClaim.claim.prompt).toContain(
      "queued real-agent preview run",
    );
    expect(previewClaim.claim.prompt).toContain(`[ID] ${previewFileId}`);
    expect(previewClaim.claim.realAgentInPreview).toBeTruthy();
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });
    await cancelChatRun(actor, previewRunId, previewClaim.sandboxHeaders);

    const mockMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === mockMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const mockRunId = userMessages(mockMessages.events).find((message) => {
      return message.revokesEventId === mockMessageId;
    })?.runId;
    if (!mockRunId) {
      throw new Error("Expected the default preview message to auto-send");
    }

    const mockClaim = await claimChatRun(runnerGroup, mockRunId);
    expect(mockClaim.claim.prompt).toBe("queued preview mock run");
    expect(mockClaim.claim.realAgentInPreview).toBeUndefined();
    await cancelChatRun(actor, mockRunId);
  }, 90_000);

  it("projects inline templates into queued web launch material", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "inline-template queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const queuedMessageId = randomUUID();
    const queuedUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Restyle with " },
        {
          type: "template",
          titleSnapshot: style.title,
          template: {
            type: "illustration",
            selection: { illustrationStyleId: style.illustrationStyleId },
          },
        },
        { type: "text", text: " at claim" },
      ],
    };
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued inline template projection",
        userMessage: queuedUserMessage,
        clientEventId: queuedMessageId,
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
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const queuedRunId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    })?.runId;
    if (!queuedRunId) {
      throw new Error("Expected the queued template message to auto-send");
    }

    const run = await api.readRun(actor, queuedRunId);
    const inlineMarker = `[Template #1: ${style.title} (illustration)]`;
    expect(run.prompt).toBe(`Restyle with ${inlineMarker} at claim`);
    const webPrompt = [
      "# Current Integration\nYou are currently running inside: Web",
      "You are communicating with the user through the web chat UI.",
    ].join("\n\n");
    expect(run.appendSystemPrompt).toContain(webPrompt);
    expect(run.appendSystemPrompt).toContain("# This Chat Thread");
    expect(run.appendSystemPrompt).toContain(
      `- CHAT_THREAD_ID: ${anchor.threadId}`,
    );
    expect(run.appendSystemPrompt).toContain("# Inline Templates");
    expect(run.appendSystemPrompt).toContain(style.illustrationStyleId);

    await expect
      .poll(() => {
        const actionTypes = apiDispatchActionTypes(
          apiDispatchTimingEventsForRun(queuedRunId),
        );
        return [
          "api_dispatch_pre_create_zero_chat_callback_auto_send_build_input",
          "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_model_pin",
          "api_dispatch_pre_create_zero_chat_callback_auto_send_load_session_state",
        ].every((actionType) => {
          return actionTypes.has(actionType);
        });
      })
      .toBe(true);
    const timingEvents = apiDispatchTimingEventsForRun(queuedRunId);
    expectApiDispatchSpanKind(
      timingEvents,
      ["api_dispatch_pre_create_zero_chat_callback_auto_send_build_input"],
      "top_level",
    );
    expectApiDispatchSpanKind(
      timingEvents,
      [
        "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_model_pin",
        "api_dispatch_pre_create_zero_chat_callback_auto_send_load_session_state",
      ],
      "nested",
    );

    const queuedClaim = await claimChatRun(runnerGroup, queuedRunId);
    expect(queuedClaim.claim.prompt).toBe(run.prompt);
    expect(queuedClaim.claim.appendSystemPrompt).toBe(run.appendSystemPrompt);
    await cancelChatRun(actor, queuedRunId, queuedClaim.sandboxHeaders);
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
    const first = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: firstPrompt,
        clientEventId: firstId,
      },
      [201],
    );
    expect(first.body).toMatchObject({ runId: null });

    const secondId = randomUUID();
    const secondPrompt = "second queued transcript message";
    const second = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: secondPrompt,
        clientEventId: secondId,
      },
      [201],
    );
    expect(second.body).toMatchObject({ runId: null });

    await cancelChatRun(actor, anchor.runId);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === firstId && message.runId !== undefined
          );
        });
      },
    );
    const users = userMessages(messages.events);
    const firstOriginal = users.find((message) => {
      return message.id === firstId;
    });
    const firstClaimed = users.find((message) => {
      return message.revokesEventId === firstId;
    });
    if (!firstOriginal || !firstClaimed?.runId) {
      throw new Error("Expected the first queued message to be claimed");
    }
    expect(Date.parse(firstClaimed.createdAt)).toBeGreaterThan(
      Date.parse(firstOriginal.createdAt),
    );

    const replacedIds = new Set(
      users.flatMap((message) => {
        return message.revokesEventId ? [message.revokesEventId] : [];
      }),
    );
    const visibleQueuedPrompts = users
      .filter((message) => {
        return (
          !replacedIds.has(message.id) &&
          (chatEventDisplayText(message) === firstPrompt ||
            chatEventDisplayText(message) === secondPrompt)
        );
      })
      .map((message) => {
        return chatEventDisplayText(message);
      });
    expect(visibleQueuedPrompts).toStrictEqual([secondPrompt, firstPrompt]);

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: secondId,
        clientEventId: randomUUID(),
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
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt,
        clientEventId: randomUUID(),
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
      clientEventId: queuedMessageId,
    };
    const queued = await chat.requestSendEvent(actor, queuedBody, [201]);
    expect(queued.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    expect(failedThreadListPublish).toBeTruthy();

    const retried = await chat.requestSendEvent(actor, queuedBody, [201]);
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
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
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

    await webhooks.requestAgentEvents(
      {
        runId: anchor.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "terminal callback race complete" },
              ],
            },
          },
        ],
      },
      anchorClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    // Completion starts both the thread-message drain and the org run-queue
    // drain concurrently. Wait until either has reached admission, then let
    // the inline send persist its queue-first row and join the same boundary.
    await expect.poll(admissionLock.waiterCount).toBeGreaterThanOrEqual(1);

    const prompt = "terminal drain and inline send share one claim";
    const messageId = randomUUID();
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientEventId: messageId,
      },
      [201],
    );
    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(actor, anchor.threadId);
        return messages.events.some((message) => {
          return message.id === messageId;
        });
      })
      .toBe(true);
    // One terminal drain is already pinned above. The persisted inline send
    // adds the second contender; sibling completion work may be serialized
    // before this boundary and is not required for the single-claim race.
    await expect
      .poll(admissionLock.waiterCount, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    admissionLock.release();

    const sent = await send;
    await admissionLock.done;
    await flushWaitUntilForTest();
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected one race winner to own the queued message");
    }

    const messages = await chat.listThreadEvents(actor, anchor.threadId);
    const claimed = userMessages(messages.events).filter((message) => {
      return (
        message.revokesEventId === messageId && message.runId !== undefined
      );
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.runId).toBe(sent.body.runId);
    const queued = userMessages(messages.events).find((message) => {
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
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "recall races the appended claim",
        clientEventId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Pin both completion-triggered drains at run admission, then make the
    // claim and recall queue behind the exact message row in a test-owned
    // order.
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    const eventQueueLock = await holdChatEventQueueItemFixture({
      threadId: anchor.threadId,
      eventId: messageId,
      signal: context.signal,
    });

    onTestFinished(async () => {
      admissionLock.release();
      eventQueueLock.release();
      await Promise.all([admissionLock.done, eventQueueLock.done]);
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "recall claim race complete"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await expect.poll(admissionLock.waiterCount).toBe(2);
    admissionLock.release();
    await admissionLock.done;
    await expect.poll(eventQueueLock.directBlockedWaiterCount).toBe(1);

    const recall = Promise.allSettled([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          revokesEventId: messageId,
          clientEventId: randomUUID(),
        },
        [400],
      ),
    ]);
    await expect.poll(eventQueueLock.blockedWaiterCount).toBe(2);
    eventQueueLock.release();

    const [recallResult] = await recall;
    if (recallResult.status === "rejected") {
      throw recallResult.reason;
    }
    const recalled = recallResult.value;
    expectApiError(recalled.body);
    expect(recalled.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );
    await eventQueueLock.done;
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queue drain to append a claimed message");
    }
    const original = userMessages(messages.events).find((message) => {
      return message.id === messageId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(claimed.content).toBeNull();
    expect(chatEventDisplayText(claimed)).toBe(
      "recall races the appended claim",
    );

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
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientEventId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    const eventQueueLock = await holdChatEventQueueItemFixture({
      threadId: anchor.threadId,
      eventId: messageId,
      signal: context.signal,
    });

    // Stage the completion-triggered drains at org admission before recall
    // reaches the queue row. The direct waiter proves recall is first; the
    // transitive count after admission opens proves the drain is queued behind
    // it.
    onTestFinished(async () => {
      admissionLock.release();
      eventQueueLock.release();
      await Promise.all([admissionLock.done, eventQueueLock.done]);
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "recall-first queue race complete"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await expect.poll(admissionLock.waiterCount).toBe(2);

    const recall = Promise.allSettled([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          revokesEventId: messageId,
          clientEventId: randomUUID(),
        },
        [201],
      ),
    ]);
    await expect.poll(eventQueueLock.directBlockedWaiterCount).toBe(1);

    admissionLock.release();
    await admissionLock.done;
    await expect
      .poll(eventQueueLock.blockedWaiterCount)
      .toBeGreaterThanOrEqual(2);
    eventQueueLock.release();

    const [recallResult] = await recall;
    if (recallResult.status === "rejected") {
      throw recallResult.reason;
    }
    const recalled = recallResult.value;
    expect(recalled.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    await eventQueueLock.done;
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

    const messages = await chat.listThreadEvents(actor, anchor.threadId);
    expect(userMessages(messages.events)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
      }),
    );
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === messageId && message.runId;
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

    const recalledEvent = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId && !message.runId;
    });
    if (recalledEvent === undefined) {
      throw new Error("Expected the winning recall event");
    }
    const probeEventId = randomUUID();
    const probe = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "append after the lost queue claim",
        clientEventId: probeEventId,
      },
      [201],
    );
    if (probe.status !== 201) {
      throw new Error("Expected the post-race probe event to be accepted");
    }
    const afterProbe = await chat.listThreadEvents(actor, anchor.threadId);
    const probeEvent = userMessages(afterProbe.events).find((message) => {
      return message.id === probeEventId;
    });
    if (probeEvent === undefined) {
      throw new Error("Expected the post-race probe event");
    }
    expect(probeEvent.seqId).toBe(recalledEvent.seqId + 1);
    if (probe.body.runId !== null) {
      await cancelChatRun(actor, probe.body.runId);
    }
  }, 90_000);

  it("appends replacements on auto-send and keeps queued recalls idempotent", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor run",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first waits for the anchor",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // A second queued message can be recalled before dispatch.
    const recalledId = randomUUID();
    const toRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first message to recall",
        clientEventId: recalledId,
      },
      [201],
    );
    expect(toRecall.body).toMatchObject({ runId: null });
    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({ runId: null });

    // A repeated recall stays idempotent.
    const repeatedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
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
            message.revokesEventId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to append a replacement");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe(
      "queue-first waits for the anchor",
    );
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(Date.parse(promoted.createdAt)).toBeGreaterThan(
      Date.parse(original.createdAt),
    );
    const appended = await chat.listThreadEvents(actor, anchor.threadId, {
      sinceSeqId: original.seqId,
    });
    expect(appended.events).toContainEqual(
      expect.objectContaining({
        id: promoted.id,
        revokesEventId: queuedId,
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

  it("auto-fires queued messages after cancellation recovery completes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor to cancel",
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first fires after cancel",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Cancellation is public immediately, but a claimed run keeps the thread
    // barrier until the runner reports cancellation recovery.
    await api.requestCancelRun(actor, anchor.runId, [200]);
    await waitForRunStatus(actor, anchor.runId, "cancelled");
    const beforeRecovery = await chat.listThreadEvents(actor, anchor.threadId);
    expect(
      userMessages(beforeRecovery.events).filter((message) => {
        return (
          message.revokesEventId === queuedId && message.runId !== undefined
        );
      }),
    ).toHaveLength(0);

    await failChatRun(anchor.runId, sandboxHeaders, "Run cancelled");
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string" &&
            message.runId !== anchor.runId
          );
        });
      },
    );
    const fired = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!fired?.runId) {
      throw new Error("Expected the queued message to fire after cancel");
    }
    expect(fired.content).toBeNull();
    expect(chatEventDisplayText(fired)).toBe("queue-first fires after cancel");
    const original = userMessages(messages.events).find((message) => {
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
