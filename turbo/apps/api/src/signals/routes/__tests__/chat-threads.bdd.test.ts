import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { cronCompactChatThreadSnapshotsContract } from "@vm0/api-contracts/contracts/cron";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import {
  createConnectorBddApi,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
  mockGoogleDriveSlidesUpload,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

/**
 * CHAT-01 / CHAT-03: chat thread lifecycle beyond the mutation chain that
 * lives in chat-files.bdd.test.ts — event snapshots and read state, thread
 * detail model pins, create/delete cascades, search, thread artifacts with
 * Google Drive sync status, and the `/api/v1` personal-access-token surface.
 *
 * Most Given state is constructed through public APIs (Stripe-webhook
 * entitlement, org model provider routes, runner heartbeat/claim, sandbox
 * report webhooks, connector OAuth flows, feature-switch and skills routes).
 * Targeted database checks are kept for migration and side-effect coverage
 * where the persisted row shape is the contract under test.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const cu = createComputerUseBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const routeMocks = createZeroRouteMocks(context);
const CHAT_THREAD_SNAPSHOT_CRON_SECRET = "chat-thread-snapshot-cron-secret";

type AssistantMessage = Extract<PagedChatMessage, { role: "assistant" }>;
type UserMessage = Extract<PagedChatMessage, { role: "user" }>;
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

async function compactChatThreadSnapshots() {
  const client = setupApp({ context })(cronCompactChatThreadSnapshotsContract);
  const response = await accept(
    client.compact({
      headers: {
        authorization: `Bearer ${CHAT_THREAD_SNAPSHOT_CRON_SECRET}`,
      },
    }),
    [200],
  );
  return response.body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationEventsForRun(
  runId: string,
): readonly Record<string, unknown>[] {
  return context.mocks.axiom.sdkIngest.mock.calls.flatMap((call) => {
    const dataset = call[0];
    const events = call[1];
    if (dataset !== "vm0-sandbox-op-log-dev" || !Array.isArray(events)) {
      return [];
    }
    return events.filter((event): event is Record<string, unknown> => {
      return isRecord(event) && event.run_id === runId;
    });
  });
}

async function expectZeroPreCreateSource(
  runId: string,
  source: string,
): Promise<void> {
  await expect
    .poll(() => {
      return sandboxOperationEventsForRun(runId);
    })
    .toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op_type: "api_dispatch_pre_create_agent_run",
          zero_pre_create_source: source,
        }),
      ]),
    );
}

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

async function entitledChatActor(
  displayName: string,
): Promise<EntitledChatActor> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
    readonly chatThreadSortEventId?: string;
    readonly model?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendMessage(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
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

/** Sandbox-scoped zero token issued to the run, exposed via the claim env. */
function zeroTokenFromClaim(claim: RunnerClaim): string {
  const token = claim.environment?.ZERO_TOKEN;
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

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
): Promise<void> {
  const historyHash = createHash("sha256")
    .update(`bdd chat thread history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode: 0 },
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

async function usageMessagesForRun(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
): Promise<PagedChatMessage[]> {
  const page = await chat.listThreadMessages(actor, threadId);
  return page.messages.filter((message) => {
    return message.runId === runId && message.usage !== undefined;
  });
}

function sessionHeaders(actor: ApiTestUser): {
  readonly authorization: string;
} {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

async function allThreadEvents(actor: ApiTestUser) {
  const response = await chat.requestThreadEvents(actor, {}, [200]);
  expect(response.status).toBe(200);
  if (response.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  return response.body.events;
}

/** Cheapest visible message writer: the no-credit send persists a user and an
 * assistant row without creating a run. */
async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
  },
): Promise<string> {
  const sent = await chat.requestSendMessage(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected a no-credit send without a run");
  }
  return sent.body.threadId;
}

/**
 * Runs a full chat run (send, runner claim, checkpoint + complete) so the
 * thread gains its run-finished marker through the production callback path.
 */
async function completeChatRunInThread(
  actor: ApiTestUser,
  runnerGroup: string,
  args: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const run = await sendChatRun(actor, {
    agentId: args.agentId,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
    prompt: args.prompt,
  });
  const { sandboxHeaders } = await claimChatRun(runnerGroup, run.runId);
  chatCallbacks.mockChatOutputEvents([]);
  await completeChatRunOk(run.runId, sandboxHeaders);
  await waitForThreadMessages(actor, run.threadId, (messages) => {
    return assistantMessages(messages).some((message) => {
      return (
        message.runId === run.runId && message.runLifecycleEvent === "completed"
      );
    });
  });
  return run;
}

const GOAL_CAPABILITIES = [
  "goal:read",
  "goal:agent-result:write",
  "goal:user-control:write",
] as const satisfies readonly ZeroCapability[];

function goalsClient() {
  return setupApp({ context })(zeroGoalsContract);
}

/** Run-scoped zero bearer with goal capabilities, as issued to sandboxes. */
function zeroGoalHeaders(
  actor: ApiTestUser,
  runId: string,
): { readonly authorization: string } {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor for goal auth");
  }
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId,
      capabilities: [...GOAL_CAPABILITIES],
      iat: seconds,
      exp: seconds + 600,
    })}`,
  };
}

async function createThreadGoal(
  actor: ApiTestUser,
  runId: string,
  objective: string,
): Promise<void> {
  await accept(
    goalsClient().create({
      headers: zeroGoalHeaders(actor, runId),
      body: { objective },
    }),
    [201],
  );
}

async function completeThreadGoal(
  actor: ApiTestUser,
  runId: string,
): Promise<void> {
  await accept(
    goalsClient().complete({
      headers: zeroGoalHeaders(actor, runId),
    }),
    [200],
  );
}

const malformedChatThreadIdRequests = [
  { method: "GET", path: "/api/zero/chat-threads/:id", paramName: "id" },
  { method: "PATCH", path: "/api/zero/chat-threads/:id", paramName: "id" },
  { method: "DELETE", path: "/api/zero/chat-threads/:id", paramName: "id" },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/mark-read",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/model-selection",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/computer-use-host",
    paramName: "id",
  },
  { method: "POST", path: "/api/zero/chat-threads/:id/pin", paramName: "id" },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/unpin",
    paramName: "id",
  },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/rename",
    paramName: "id",
  },
  {
    method: "GET",
    path: "/api/zero/chat-threads/:id/messages",
    paramName: "threadId",
  },
  {
    method: "GET",
    path: "/api/zero/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
  {
    method: "POST",
    path: "/api/zero/chat-threads/:id/artifacts",
    paramName: "threadId",
  },
] as const;

describe("CHAT-01 thread detail, create, and delete cascades", () => {
  it("rejects malformed thread ids before auth and unauthenticated clerk bearers", async () => {
    const app = createApp({ signal: context.signal });

    for (const request of malformedChatThreadIdRequests) {
      const response = await app.request(request.path, {
        method: request.method,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        readonly error: { readonly code: string; readonly message: string };
      };
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain(request.paramName);
    }

    // A bearer that Clerk reports as unauthenticated is a plain 401, not a
    // crash on the session fall-through branch.
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const unauthenticated = await app.request(
      "/api/zero/chat-threads/snapshot",
      {
        headers: { authorization: "Bearer clerk-session" },
      },
    );
    expect(unauthenticated.status).toBe(401);
    const unauthenticatedBody = (await unauthenticated.json()) as {
      readonly error: { readonly code: string };
    };
    expect(unauthenticatedBody.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects thread creation for unknown, cross-org, and org-less callers", async () => {
    const unauthenticated = await chat.requestCreateThread(
      null,
      { agentId: randomUUID(), title: "no session" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const outsider = bdd.user();
    bdd.acceptAgentStorageWrites();
    const foreignAgent = await bdd.createAgent(outsider, {
      displayName: "Foreign-org compose agent",
    });

    const actor = bdd.user();
    const missing = await chat.requestCreateThread(
      actor,
      { agentId: randomUUID(), title: "missing compose" },
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error).toStrictEqual({
      message: "Agent not found",
      code: "NOT_FOUND",
    });

    const crossOrg = await chat.requestCreateThread(
      actor,
      { agentId: foreignAgent.agentId, title: "hijacked" },
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.message).toBe("Agent not found");

    // Thread creation now resolves the model route up front, so callers must
    // have an active organization before body-level compose lookup runs.
    const orgless = bdd.user({ orgId: null });
    const noOrg = await chat.requestCreateThread(
      orgless,
      { agentId: foreignAgent.agentId, title: "no org" },
      [401],
    );
    expectApiError(noOrg.body);
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // The foreign agent's event stream is unaffected by the rejected creates.
    expect(
      (await allThreadEvents(outsider)).some((event) => {
        return event.agentId === foreignAgent.agentId;
      }),
    ).toBeFalsy();
  });

  it("returns chat thread snapshot and lifecycle events with cursor expiry", async () => {
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "Thread event sourcing agent",
    });
    const createEventId = randomUUID();
    const renameEventId = randomUUID();
    const modelSelectionEventId = randomUUID();

    const emptySnapshot = await chat.getThreadSnapshot(actor);
    expect(emptySnapshot).toStrictEqual({
      chatThreads: [],
      latestEventId: null,
    });

    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Initial event title",
      eventId: createEventId,
    });
    await chat.renameThread(
      actor,
      thread.id,
      "Renamed event title",
      renameEventId,
    );
    await chat.updateThreadModelSelection(
      actor,
      thread.id,
      "claude-sonnet-4-6",
      { eventId: modelSelectionEventId },
    );

    const allEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(allEvents.status).toBe(200);
    if (allEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(allEvents.body.hasMore).toBeFalsy();
    expect(allEvents.body.events).toHaveLength(3);
    expect(allEvents.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createEventId,
          kind: "created",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          title: "Initial event title",
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          id: renameEventId,
          kind: "renamed",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          title: "Renamed event title",
          createdAt: expect.any(String),
        }),
        expect.objectContaining({
          id: modelSelectionEventId,
          kind: "model_selection_updated",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          title: null,
          selectedModel: "claude-sonnet-4-6",
          createdAt: expect.any(String),
        }),
      ]),
    );

    const afterCreate = await chat.requestThreadEvents(
      actor,
      { sinceEventId: createEventId },
      [200],
    );
    expect(afterCreate.status).toBe(200);
    if (afterCreate.status !== 200) {
      throw new Error("Expected chat thread events after cursor to load");
    }
    expect(afterCreate.body.events).toHaveLength(2);
    expect(afterCreate.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: renameEventId }),
        expect.objectContaining({ id: modelSelectionEventId }),
      ]),
    );

    const expired = await chat.requestThreadEvents(
      actor,
      { sinceEventId: randomUUID() },
      [410],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "Chat thread events cursor has expired",
        code: "CHAT_THREAD_EVENTS_EXPIRED",
      },
    });
  });

  it("touches thread sort from existing direct user sends and run-finished markers", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Thread sort touch agent",
    );
    const directSendSortEventId = randomUUID();
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Existing sort touch thread",
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "move this thread when I send it",
      chatThreadSortEventId: directSendSortEventId,
    });
    await waitForThreadMessages(actor, run.threadId, (messages) => {
      return userMessages(messages).some((message) => {
        return message.content === "move this thread when I send it";
      });
    });
    await flushWaitUntilForTest();

    let sortTouches = (await allThreadEvents(actor)).filter((event) => {
      return (
        event.chatThreadId === run.threadId && event.kind === "sort_touched"
      );
    });
    expect(sortTouches).toHaveLength(1);
    expect(sortTouches[0]?.id).toBe(directSendSortEventId);

    const claim = await claimChatRun(runnerGroup, run.runId);
    await completeChatRunOk(run.runId, claim.sandboxHeaders);
    await waitForThreadMessages(actor, run.threadId, (messages) => {
      return assistantMessages(messages).some((message) => {
        return (
          message.runId === run.runId &&
          message.runLifecycleEvent === "completed"
        );
      });
    });
    await flushWaitUntilForTest();

    sortTouches = (await allThreadEvents(actor)).filter((event) => {
      return (
        event.chatThreadId === run.threadId && event.kind === "sort_touched"
      );
    });
    expect(sortTouches).toHaveLength(2);
  }, 90_000);

  it("compacts chat thread snapshots from event markers and prunes deleted agent threads", async () => {
    mockEnv("CRON_SECRET", CHAT_THREAD_SNAPSHOT_CRON_SECRET);
    const actor = bdd.user();
    const liveAgent = await bdd.createAgent(actor, {
      displayName: "Snapshot compaction live agent",
    });
    const deletedAgent = await bdd.createAgent(actor, {
      displayName: "Snapshot compaction deleted agent",
    });
    const liveCreateEventId = randomUUID();
    const deletedCreateEventId = randomUUID();

    const liveThread = await chat.createThread(actor, {
      agentId: liveAgent.agentId,
      title: "Initial compact title",
      eventId: liveCreateEventId,
    });
    const deletedAgentThread = await chat.createThread(actor, {
      agentId: deletedAgent.agentId,
      title: "Deleted agent compact title",
      eventId: deletedCreateEventId,
    });

    const initialCompact = await compactChatThreadSnapshots();
    expect(initialCompact.eventsApplied).toBeGreaterThanOrEqual(2);

    const baselineSnapshot = await chat.getThreadSnapshot(actor);
    expect(baselineSnapshot.latestEventId).not.toBeNull();
    expect(
      baselineSnapshot.chatThreads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual(
      expect.arrayContaining([liveThread.id, deletedAgentThread.id]),
    );

    const renameEventId = randomUUID();
    const modelSelectionEventId = randomUUID();
    await chat.renameThread(
      actor,
      liveThread.id,
      "Renamed compact title",
      renameEventId,
    );
    await chat.updateThreadModelSelection(
      actor,
      liveThread.id,
      "claude-sonnet-4-6",
      { eventId: modelSelectionEventId },
    );
    chat.mockObjectStorageObjectsExist();
    await authOrg.deleteAgent(actor, deletedAgent.agentId);

    onTestFinished(() => {
      clearMockNow();
    });
    mockNow(now() + 8 * 24 * 60 * 60 * 1000);
    const incrementalCompact = await compactChatThreadSnapshots();
    expect(incrementalCompact.eventsApplied).toBeGreaterThanOrEqual(1);
    expect(
      incrementalCompact.removedDeletedAgentThreads,
    ).toBeGreaterThanOrEqual(1);
    expect(incrementalCompact.eventsPruned).toBeGreaterThanOrEqual(1);

    const compactedSnapshot = await chat.getThreadSnapshot(actor);
    expect(compactedSnapshot.latestEventId).not.toBeNull();
    expect(compactedSnapshot.chatThreads).toStrictEqual([
      expect.objectContaining({
        id: liveThread.id,
        agentId: liveAgent.agentId,
        title: "Renamed compact title",
        renamedAt: expect.any(String),
        selectedModel: "claude-sonnet-4-6",
      }),
    ]);

    const prunedCursor = await chat.requestThreadEvents(
      actor,
      { sinceEventId: liveCreateEventId },
      [410],
    );
    expect(prunedCursor.body).toStrictEqual({
      error: {
        message: "Chat thread events cursor has expired",
        code: "CHAT_THREAD_EVENTS_EXPIRED",
      },
    });

    const retainedAnchorCursor = await chat.requestThreadEvents(
      actor,
      { sinceEventId: compactedSnapshot.latestEventId ?? undefined },
      [200],
    );
    expect(retainedAnchorCursor.status).toBe(200);
    if (retainedAnchorCursor.status !== 200) {
      throw new Error(
        "Expected retained snapshot anchor event to be queryable",
      );
    }
    expect(retainedAnchorCursor.body.events).toStrictEqual([]);
  });
  it("keeps thread detail independent from thread model projection state", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Thread detail model pin agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "pin the first run model",
      model: "claude-sonnet-4-6",
    });

    let detail = await chat.readThread(actor, run.threadId);
    expect(detail).not.toHaveProperty("selectedModel");
    await expect(chat.listActiveChatThreadIds(actor)).resolves.toContain(
      run.threadId,
    );

    await chat.updateThreadModelSelection(actor, run.threadId, null);
    detail = await chat.readThread(actor, run.threadId);
    expect(detail).not.toHaveProperty("selectedModel");
    expect(detail).not.toHaveProperty("modelProviderId");
    expect(detail).not.toHaveProperty("modelProviderType");
    expect(detail).not.toHaveProperty("modelProviderCredentialScope");

    const invalidSelection = await chat.requestUpdateThreadModelSelection(
      actor,
      run.threadId,
      "not-a-supported-model",
      [400],
    );
    expectApiError(invalidSelection.body);
    expect(invalidSelection.body.error.code).toBe("BAD_REQUEST");

    await cancelChatRun(actor, run.runId);
    await expect(chat.listActiveChatThreadIds(actor)).resolves.not.toContain(
      run.threadId,
    );
  }, 90_000);

  it("rejects restricted model pins for limited-free-1 workspaces", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Limited free model pin agent",
    );
    if (!actor.orgId) {
      throw new Error("Expected actor org");
    }
    // "limited-free-1" is only assigned by the Clerk org-creation bootstrap;
    // no product API can move an entitled org onto it, so downgrade the tier
    // through the shared system-config seed while keeping the pro balance.
    const billingStatus = await api.readBillingStatus(actor);
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "limited-free-1",
      credits: billingStatus.credits,
    });

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
      title: "limited free model pin",
    });
    for (const selectedModel of [
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ] as const) {
      const restrictedSelection = await chat.requestUpdateThreadModelSelection(
        actor,
        thread.id,
        selectedModel,
        [402],
      );
      expectApiError(restrictedSelection.body);
      expect(restrictedSelection.body.error).toStrictEqual({
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      });

      await expect(
        chat.readThread(actor, thread.id),
      ).resolves.not.toHaveProperty("selectedModel");
    }

    await chat.updateThreadModelSelection(actor, thread.id, "MiniMax-M3");
    const detail = await chat.readThread(actor, thread.id);
    expect(detail).not.toHaveProperty("selectedModel");
  }, 90_000);

  it("updates the Computer Use host binding on a chat thread", async () => {
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use thread agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Computer Use",
    });

    const host = await cu.startComputerUseHost(actor);
    await chat.updateThreadComputerUseHost(actor, thread.id, host.hostId);
    await expect(chat.readThread(actor, thread.id)).resolves.toMatchObject({
      computerUseHostId: host.hostId,
    });

    const missingHost = await chat.requestUpdateThreadComputerUseHost(
      actor,
      thread.id,
      randomUUID(),
      [404],
    );
    expectApiError(missingHost.body);
    expect(missingHost.body.error.message).toBe("Computer-use host not found");

    const peer = bdd.user({ orgId: actor.orgId });
    const peerUpdate = await chat.requestUpdateThreadComputerUseHost(
      peer,
      thread.id,
      host.hostId,
      [404],
    );
    expectApiError(peerUpdate.body);
    expect(peerUpdate.body.error.message).toBe("Chat thread not found");

    await chat.updateThreadComputerUseHost(actor, thread.id, null);
    await expect(chat.readThread(actor, thread.id)).resolves.toMatchObject({
      computerUseHostId: null,
    });

    const missingThread = await chat.requestUpdateThreadComputerUseHost(
      actor,
      randomUUID(),
      null,
      [404],
    );
    expectApiError(missingThread.body);
    expect(missingThread.body.error.message).toBe("Chat thread not found");
  });

  it("cancels in-flight runs and cascades schedules when a thread is deleted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Thread delete cascade agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const peer = bdd.user({ orgId: actor.orgId });

    const unauthenticated = await chat.requestDeleteThread(
      null,
      randomUUID(),
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const unknown = await chat.requestDeleteThread(actor, randomUUID(), [404]);
    expectApiError(unknown.body);
    expect(unknown.body.error).toStrictEqual({
      message: "Chat thread not found",
      code: "NOT_FOUND",
    });

    const malformed = await chat.requestDeleteThread(
      actor,
      "not-a-uuid",
      [400],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.message).toContain("id");

    // Main thread with a claimed (running) run.
    const main = await sendChatRun(actor, {
      agentId,
      prompt: "delete cascade anchor",
    });
    await claimChatRun(runnerGroup, main.runId);

    await expect(chat.listActiveChatThreadIds(actor)).resolves.toContain(
      main.threadId,
    );

    // A sibling thread whose run completes: terminal transition drops the
    // active-thread flag.
    const sibling = await sendChatRun(actor, {
      agentId,
      prompt: "sibling thread completes",
    });
    const siblingClaim = await claimChatRun(runnerGroup, sibling.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(sibling.runId, siblingClaim.sandboxHeaders);

    await expect(chat.listActiveChatThreadIds(actor)).resolves.not.toContain(
      sibling.threadId,
    );

    // A third thread with its own pending run must survive the delete.
    const other = await sendChatRun(actor, {
      agentId,
      prompt: "other thread stays active",
    });

    const peerDelete = await chat.requestDeleteThread(
      peer,
      main.threadId,
      [404],
    );
    expectApiError(peerDelete.body);
    expect(peerDelete.body.error.code).toBe("NOT_FOUND");
    await expect(chat.readThread(actor, main.threadId)).resolves.toStrictEqual({
      lastReadAt: null,
      computerUseHostId: null,
      codexServiceTier: null,
    });

    const deleted = await chat.requestDeleteThread(actor, main.threadId, [204]);
    expect(deleted.body).toBeUndefined();

    expect((await api.readRun(actor, main.runId)).status).toBe("cancelled");
    expect((await api.readRun(actor, sibling.runId)).status).toBe("completed");
    expect((await api.readRun(actor, other.runId)).status).toBe("pending");

    const goneRead = await chat.requestReadThread(actor, main.threadId, [404]);
    expectApiError(goneRead.body);
    await expect(allThreadEvents(actor)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "deleted",
          chatThreadId: main.threadId,
        }),
      ]),
    );

    await cancelChatRun(actor, other.runId);
  }, 120_000);
});

describe("CHAT-01 chat thread read state", () => {
  it("lists unread agent ids behind the agent unread feature switch", async () => {
    const {
      actor: owner,
      agentId: agentA,
      runnerGroup,
    } = await entitledChatActor("Unread agent A");
    const agentB = (
      await bdd.createAgent(owner, {
        displayName: "Unread agent B",
        visibility: "private",
      })
    ).agentId;

    await connectorsApi.updateFeatureSwitches(owner, {
      [FeatureSwitchKey.AgentUnreadIndicators]: false,
    });
    const disabled = await chat.requestListUnreadAgents(owner, [403]);
    expectApiError(disabled.body);
    expect(disabled.body.error.code).toBe("FORBIDDEN");

    await connectorsApi.updateFeatureSwitches(owner, {
      [FeatureSwitchKey.AgentUnreadIndicators]: true,
    });
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);

    // An active (claimed) run keeps its thread out of the unread aggregate
    // until it completes and leaves a run-finished marker.
    const activeRun = await sendChatRun(owner, {
      agentId: agentA,
      prompt: "unread aggregate with active run",
    });
    const activeClaim = await claimChatRun(runnerGroup, activeRun.runId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(activeRun.runId, activeClaim.sandboxHeaders);
    await waitForThreadMessages(owner, activeRun.threadId, (messages) => {
      return assistantMessages(messages).some((message) => {
        return (
          message.runId === activeRun.runId &&
          message.runLifecycleEvent === "completed"
        );
      });
    });
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentA]);
    await chat.markThreadRead(owner, activeRun.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);

    // An active goal suppresses the unread flag; a complete goal does not.
    const activeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "unread aggregate with active goal",
    });
    const completeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentB,
      prompt: "unread aggregate with complete goal",
    });
    await createThreadGoal(owner, activeGoalRun.runId, "bdd unread goal");
    await createThreadGoal(owner, completeGoalRun.runId, "bdd unread goal");
    await completeThreadGoal(owner, completeGoalRun.runId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentB]);
    await chat.markThreadRead(owner, completeGoalRun.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);

    const runA = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "unread aggregate A",
    });
    const runB = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentB,
      prompt: "unread aggregate B",
    });

    const unreadAgents = await chat.listUnreadAgents(owner);
    expect(new Set(unreadAgents)).toStrictEqual(new Set([agentA, agentB]));

    await chat.markThreadRead(owner, runA.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentB]);

    await chat.markThreadRead(owner, runB.threadId);
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([]);
  }, 120_000);

  it("lists active chat thread ids for the current user and org", async () => {
    const {
      actor: owner,
      agentId: ownerAgent,
      runnerGroup,
    } = await entitledChatActor("Active ids owner agent");
    const peer = bdd.user({ orgId: owner.orgId });
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });

    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Active ids peer agent",
      visibility: "private",
    });
    const otherOrgAgent = await bdd.createAgent(sameUserOtherOrg, {
      displayName: "Active ids other org agent",
      visibility: "private",
    });
    await api.grantProEntitlement(sameUserOtherOrg);
    await api.ensureOrgModelProvider(sameUserOtherOrg);

    // A completed run's thread must not appear in the active list. Run it
    // first so the pro-tier concurrency slots stay free for the runs below.
    await completeChatRunInThread(owner, runnerGroup, {
      agentId: ownerAgent,
      prompt: "terminal completed thread",
    });

    // Peer-user and cross-org active runs must not leak into the owner list.
    await sendChatRun(peer, {
      agentId: peerAgent.agentId,
      prompt: "peer active thread",
    });
    await sendChatRun(sameUserOtherOrg, {
      agentId: otherOrgAgent.agentId,
      prompt: "other org active thread",
    });

    // Owner: one claimed (running) run and one send over the org concurrency
    // cap, which admits as a queued run.
    const runningRun = await sendChatRun(owner, {
      agentId: ownerAgent,
      prompt: "active running thread",
    });
    const runningClaim = await claimChatRun(runnerGroup, runningRun.runId);
    const queuedRun = await sendChatRun(owner, {
      agentId: ownerAgent,
      prompt: "active queued thread",
    });

    expect(new Set(await chat.listActiveChatThreadIds(owner))).toStrictEqual(
      new Set([runningRun.threadId, queuedRun.threadId]),
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(runningRun.runId, runningClaim.sandboxHeaders);
    await waitForRunStatus(owner, runningRun.runId, "completed");

    expect(new Set(await chat.listActiveChatThreadIds(owner))).toStrictEqual(
      new Set([queuedRun.threadId]),
    );
  }, 120_000);

  it("excludes unread chat threads that have active runs or goals", async () => {
    const {
      actor: owner,
      agentId,
      runnerGroup,
    } = await entitledChatActor("Unread active state agent");

    // A claimed (running) run keeps its thread out of the unread list.
    const runningRun = await sendChatRun(owner, {
      agentId,
      prompt: "unread thread with active run",
    });
    const runningClaim = await claimChatRun(runnerGroup, runningRun.runId);

    const completedRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId,
      prompt: "unread thread with completed run",
    });
    const activeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId,
      prompt: "unread thread with active goal",
    });
    const completeGoalRun = await completeChatRunInThread(owner, runnerGroup, {
      agentId,
      prompt: "unread thread with complete goal",
    });
    await createThreadGoal(owner, activeGoalRun.runId, "bdd unread goal");
    await createThreadGoal(owner, completeGoalRun.runId, "bdd unread goal");
    await completeThreadGoal(owner, completeGoalRun.runId);

    expect(
      new Set(
        (await chat.listThreadUnreads(owner, agentId)).map((unread) => {
          return unread.threadId;
        }),
      ),
    ).toStrictEqual(new Set([completedRun.threadId, completeGoalRun.threadId]));

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(runningRun.runId, runningClaim.sandboxHeaders);
    await waitForThreadMessages(owner, runningRun.threadId, (messages) => {
      return assistantMessages(messages).some((message) => {
        return (
          message.runId === runningRun.runId &&
          message.runLifecycleEvent === "completed"
        );
      });
    });
    expect(
      new Set(
        (await chat.listThreadUnreads(owner, agentId)).map((unread) => {
          return unread.threadId;
        }),
      ),
    ).toStrictEqual(
      new Set([
        runningRun.threadId,
        completedRun.threadId,
        completeGoalRun.threadId,
      ]),
    );
  }, 120_000);

  it("marks all unread chat threads for one agent behind the agent unread feature switch", async () => {
    const {
      actor: owner,
      agentId: agentA,
      runnerGroup,
    } = await entitledChatActor("Mark-read agent A");
    const agentB = (
      await bdd.createAgent(owner, {
        displayName: "Mark-read agent B",
        visibility: "private",
      })
    ).agentId;

    await connectorsApi.updateFeatureSwitches(owner, {
      [FeatureSwitchKey.AgentUnreadIndicators]: false,
    });
    const disabled = await chat.requestMarkAgentThreadsRead(
      owner,
      agentA,
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.code).toBe("FORBIDDEN");

    await connectorsApi.updateFeatureSwitches(owner, {
      [FeatureSwitchKey.AgentUnreadIndicators]: true,
    });

    const firstRunA = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "mark all read A one",
    });
    const secondRunA = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentA,
      prompt: "mark all read A two",
    });
    const runB = await completeChatRunInThread(owner, runnerGroup, {
      agentId: agentB,
      prompt: "mark all read B",
    });

    expect(
      new Set(
        (await chat.listThreadUnreads(owner, agentA)).map((unread) => {
          return unread.threadId;
        }),
      ),
    ).toStrictEqual(new Set([firstRunA.threadId, secondRunA.threadId]));
    expect(new Set(await chat.listUnreadAgents(owner))).toStrictEqual(
      new Set([agentA, agentB]),
    );

    context.mocks.ably.publish.mockClear();
    await chat.markAgentThreadsRead(owner, agentA);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        agentId: agentA,
        threadIds: expect.arrayContaining([
          firstRunA.threadId,
          secondRunA.threadId,
        ]),
      },
    );

    await expect(chat.listThreadUnreads(owner, agentA)).resolves.toStrictEqual(
      [],
    );
    await expect(chat.listThreadUnreads(owner, agentB)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: runB.threadId }),
      ]),
    );
    await expect(chat.listUnreadAgents(owner)).resolves.toStrictEqual([agentB]);
  }, 120_000);

  it("pages thread messages with since and before cursors", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Message cursor agent",
    });

    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "cursor round one",
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: "cursor round two",
    });

    const full = await chat.listThreadMessages(owner, threadId);
    expect(full.hasHistoryBefore).toBeFalsy();
    expect(
      full.messages.map((message) => {
        return [message.role, message.content] as const;
      }),
    ).toStrictEqual([
      ["user", "cursor round one"],
      ["assistant", expect.stringContaining("Insufficient credits")],
      ["user", "cursor round two"],
      ["assistant", expect.stringContaining("Insufficient credits")],
    ]);
    const ids = full.messages.map((message) => {
      return message.id;
    });
    const [firstUser, firstAssistant, secondUser, secondAssistant] = ids;
    if (!firstUser || !firstAssistant || !secondUser || !secondAssistant) {
      throw new Error("Expected four messages across the two sends");
    }

    // Latest page overflow: only the newest rows, with history behind them.
    const latest = await chat.listThreadMessages(owner, threadId, {
      limit: 2,
    });
    expect(
      latest.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondUser, secondAssistant]);
    expect(latest.hasHistoryBefore).toBeTruthy();

    // Forward pagination strictly after the cursor.
    const since = await chat.listThreadMessages(owner, threadId, {
      sinceId: firstAssistant,
    });
    expect(
      since.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondUser, secondAssistant]);

    // Backward pagination strictly before the cursor.
    const before = await chat.listThreadMessages(owner, threadId, {
      beforeId: secondUser,
      limit: 2,
    });
    expect(
      before.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([firstUser, firstAssistant]);
    expect(before.hasHistoryBefore).toBeFalsy();

    const beforeOverflow = await chat.listThreadMessages(owner, threadId, {
      beforeId: secondAssistant,
      limit: 2,
    });
    expect(
      beforeOverflow.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([firstAssistant, secondUser]);
    expect(beforeOverflow.hasHistoryBefore).toBeTruthy();
  }, 30_000);
});

describe("CHAT-03 run usage messages", () => {
  it("appends immutable usage messages as settled usage changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Usage message agent",
    );
    const provider = `bdd-usage-${randomUUID().slice(0, 8)}`;
    const missingProvider = `${provider}-free`;
    const category = "api_request";
    await seedUsagePricingRows([
      { kind: "connector", provider, category, unitPrice: 7, unitSize: 2 },
    ]);

    const { runId, threadId } = await sendChatRun(actor, {
      agentId,
      prompt: "record billable usage",
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, runId);
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 5,
          },
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: missingProvider,
            category,
            quantity: 1,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    await completeChatRunOk(runId, sandboxHeaders);
    await flushWaitUntilForTest();

    let usageMessages = await usageMessagesForRun(actor, threadId, runId);
    expect(usageMessages.length).toBeGreaterThanOrEqual(1);
    expect(usageMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: null,
      usage: {
        version: 1,
        totalCredits: 18,
        settledAt: expect.any(String),
        breakdown: [
          {
            kind: "connector",
            credits: 18,
            providers: expect.arrayContaining([
              { provider, credits: 18 },
              { provider: missingProvider, credits: 0 },
            ]),
          },
        ],
      },
    });

    const initialUsageMessageCount = usageMessages.length;
    const billing = createBillingMediaApi(context);

    onTestFinished(() => {
      clearMockNow();
    });
    // Sandbox tokens are validated against the mockable clock, so record the
    // late usage through the webhook first and only advance time for the
    // settlement cron that charges it and re-emits the usage message.
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: missingProvider,
            category,
            quantity: 1,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    await billing.processUsageEvents();
    usageMessages = await usageMessagesForRun(actor, threadId, runId);
    expect(usageMessages).toHaveLength(initialUsageMessageCount + 1);
    expect(usageMessages.at(-1)?.usage).toMatchObject({
      totalCredits: 18,
      settledAt: "2030-01-01T00:00:00.000Z",
    });

    clearMockNow();
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 3,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    mockNow(new Date("2030-01-01T00:00:01.000Z"));
    await billing.processUsageEvents();
    usageMessages = await usageMessagesForRun(actor, threadId, runId);
    expect(usageMessages).toHaveLength(initialUsageMessageCount + 2);
    expect(usageMessages.at(-1)?.usage).toMatchObject({
      totalCredits: 29,
      settledAt: "2030-01-01T00:00:01.000Z",
    });
    // With no pending usage left the settlement cron has nothing to charge,
    // so re-running it must not append another usage message.
    await billing.processUsageEvents();
    usageMessages = await usageMessagesForRun(actor, threadId, runId);
    expect(usageMessages).toHaveLength(initialUsageMessageCount + 2);
  }, 60_000);

  it("emits zero-credit usage messages and skips runs without usage", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Zero usage message agent",
    );

    const zeroRun = await sendChatRun(actor, {
      agentId,
      prompt: "record zero-credit usage",
    });
    const { sandboxHeaders: zeroSandboxHeaders } = await claimChatRun(
      runnerGroup,
      zeroRun.runId,
    );
    await webhooks.requestAgentUsageEvent(
      {
        runId: zeroRun.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: `missing-${randomUUID().slice(0, 8)}`,
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      zeroSandboxHeaders,
      [200],
    );
    await completeChatRunOk(zeroRun.runId, zeroSandboxHeaders);
    await flushWaitUntilForTest();

    const zeroPage = await chat.listThreadMessages(actor, zeroRun.threadId);
    const zeroUsageMessage = zeroPage.messages.find((message) => {
      return message.runId === zeroRun.runId && message.usage !== undefined;
    });
    expect(zeroUsageMessage?.usage).toMatchObject({
      version: 1,
      totalCredits: 0,
      breakdown: [
        {
          kind: "connector",
          credits: 0,
          providers: [expect.objectContaining({ credits: 0 })],
        },
      ],
    });

    // A run that never recorded usage settles nothing, so completion must not
    // append a usage message. (The former pending-suppression variant is not
    // product-reachable: both production emitters settle the org's pending
    // usage immediately before emitting.)
    const quietRun = await sendChatRun(actor, {
      agentId,
      prompt: "complete without recording usage",
    });
    const { sandboxHeaders: quietSandboxHeaders } = await claimChatRun(
      runnerGroup,
      quietRun.runId,
    );
    await completeChatRunOk(quietRun.runId, quietSandboxHeaders);
    await flushWaitUntilForTest();
    await expect(
      usageMessagesForRun(actor, quietRun.threadId, quietRun.runId),
    ).resolves.toHaveLength(0);
  }, 60_000);
});

describe("CHAT-01 chat search", () => {
  it("rejects search without an org session or the chat-message:read capability", async () => {
    const unauthenticated = await chat.requestSearchChat(
      null,
      "hello",
      {},
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const orgless = await chat.requestSearchChat(
      bdd.user({ orgId: null }),
      "hello",
      {},
      [401],
    );
    expectApiError(orgless.body);
    expect(orgless.body.error.code).toBe("UNAUTHORIZED");

    const sandboxBearer = api.sandboxTokenForRun(bdd.user(), randomUUID());
    const forbidden = await chat.searchChatWithBearer(
      `Bearer ${sandboxBearer}`,
      "hello",
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect(forbidden.body.error.message).toContain("chat-message:read");
  });

  it("searches own messages with filters, context, and like-escaping", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    bdd.acceptAgentStorageWrites();
    const agentA = await bdd.createAgent(owner, {
      displayName: "Search agent A",
    });
    const agentB = await bdd.createAgent(owner, {
      displayName: "Search agent B",
    });

    const emptyResults = await chat.searchChat(owner, "quokka");
    expect(emptyResults.results).toStrictEqual([]);
    expect(emptyResults.hasMore).toBeFalsy();

    const blankKeyword = await chat.requestSearchChat(owner, "   ", {}, [400]);
    expectApiError(blankKeyword.body);

    // Peer-user isolation inside one org.
    const peerAgent = await bdd.createAgent(peer, {
      displayName: "Peer search agent",
    });
    await sendNoCreditMessage(peer, {
      agentId: peerAgent.agentId,
      prompt: "peer says supercalifragilistic",
    });
    const ownerThreadA = await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "owner says supercalifragilistic",
    });
    const isolation = await chat.searchChat(owner, "supercalifragilistic");
    expect(isolation.results).toHaveLength(1);
    expect(isolation.results[0]?.chatThreadId).toBe(ownerThreadA);
    expect(isolation.results[0]?.matchedMessage.content).toBe(
      "owner says supercalifragilistic",
    );
    expect(isolation.results[0]?.agentName).toStrictEqual(expect.any(String));

    // Cross-org isolation for the same user.
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const otherOrgAgent = await bdd.createAgent(sameUserOtherOrg, {
      displayName: "Other org search agent",
    });
    await sendNoCreditMessage(sameUserOtherOrg, {
      agentId: otherOrgAgent.agentId,
      prompt: "other-org supercalifragilistic sighting",
    });
    const crossOrg = await chat.searchChat(owner, "supercalifragilistic");
    expect(crossOrg.results).toHaveLength(1);
    expect(crossOrg.results[0]?.chatThreadId).toBe(ownerThreadA);

    // The since filter keeps only messages at or after the boundary.
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "ancient quokka spotted",
    });
    const sinceBoundary = now();
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "recent quokka spotted",
    });
    const since = await chat.searchChat(owner, "quokka", {
      since: sinceBoundary,
    });
    expect(since.results).toHaveLength(1);
    expect(since.results[0]?.matchedMessage.content).toBe(
      "recent quokka spotted",
    );

    // The agentId filter scopes matches to one agent's threads.
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: "agent B mentions narwhal",
    });
    const narwhalThreadA = await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "agent A mentions narwhal",
    });
    const byAgent = await chat.searchChat(owner, "narwhal", {
      agentId: agentA.agentId,
    });
    expect(byAgent.results).toHaveLength(1);
    expect(byAgent.results[0]?.chatThreadId).toBe(narwhalThreadA);
    expect(byAgent.results[0]?.matchedMessage.content).toBe(
      "agent A mentions narwhal",
    );

    // Context windows around the match stay chronological.
    const contextThread = await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: "context round one",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      threadId: contextThread,
      prompt: "the okapi was here",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      threadId: contextThread,
      prompt: "context round three",
    });
    const contextual = await chat.searchChat(owner, "okapi", {
      before: 2,
      after: 2,
    });
    expect(contextual.results).toHaveLength(1);
    const match = contextual.results[0];
    if (!match) {
      throw new Error("Expected one okapi match");
    }
    expect(match.matchedMessage.content).toBe("the okapi was here");
    expect(match.contextBefore).toHaveLength(2);
    expect(match.contextAfter).toHaveLength(2);
    expect(
      match.contextBefore.map((message) => {
        return message.content;
      }),
    ).toContain("context round one");
    expect(
      match.contextAfter.map((message) => {
        return message.content;
      }),
    ).toContain("context round three");
    const matchedAt = Date.parse(match.matchedMessage.createdAt);
    for (const message of match.contextBefore) {
      expect(Date.parse(message.createdAt)).toBeLessThan(matchedAt);
    }
    for (const message of match.contextAfter) {
      expect(Date.parse(message.createdAt)).toBeGreaterThan(matchedAt);
    }
    const beforeTimes = match.contextBefore.map((message) => {
      return Date.parse(message.createdAt);
    });
    expect(
      [...beforeTimes].sort((a, b) => {
        return a - b;
      }),
    ).toStrictEqual(beforeTimes);
    const afterTimes = match.contextAfter.map((message) => {
      return Date.parse(message.createdAt);
    });
    expect(
      [...afterTimes].sort((a, b) => {
        return a - b;
      }),
    ).toStrictEqual(afterTimes);

    // hasMore flips when matches exceed the limit.
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "capybara sighting one",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "capybara sighting two",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "capybara sighting three",
    });
    const limited = await chat.searchChat(owner, "capybara", { limit: 2 });
    expect(limited.results).toHaveLength(2);
    expect(limited.hasMore).toBeTruthy();

    // LIKE wildcards in the keyword are escaped, not interpreted.
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "discount is 50% today",
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: "50 apples and bananas",
    });
    const escaped = await chat.searchChat(owner, "50%");
    expect(escaped.results).toHaveLength(1);
    expect(escaped.results[0]?.matchedMessage.content).toBe(
      "discount is 50% today",
    );
  }, 60_000);
});

describe("CHAT-03 thread artifacts and google drive status", () => {
  it("groups run uploads and reports google drive sync status", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Artifacts drive status agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const peer = bdd.user({ orgId: actor.orgId });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "produce thread artifacts",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const runBearer = `Bearer ${zeroTokenFromClaim(claim)}`;

    const unauthenticated = await chat.requestListThreadArtifacts(
      null,
      run.threadId,
      [401],
    );
    expectApiError(unauthenticated.body);
    const crossUser = await chat.requestListThreadArtifacts(
      peer,
      run.threadId,
      [404],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.code).toBe("NOT_FOUND");

    // Two uploads recorded under the run through its sandbox-scoped token.
    // The csv complete omits contentType so the route infers it from the key.
    const csvId = randomUUID();
    const pdfId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${csvId}/data.csv`,
      size: 2048,
    });
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${pdfId}/report.pdf`,
      size: 512,
    });
    await chat.completeUploadWithBearer(runBearer, { id: csvId }, [200]);
    await chat.completeUploadWithBearer(runBearer, { id: pdfId }, [200]);

    let artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(artifacts.runs).toHaveLength(1);
    expect(artifacts.runs[0]?.runId).toBe(run.runId);
    expect(artifacts.runs[0]?.files).toHaveLength(2);
    const csvFile = artifacts.runs[0]?.files.find((file) => {
      return file.id === csvId;
    });
    expect(csvFile).toMatchObject({
      filename: "data.csv",
      contentType: "text/csv",
      size: 2048,
      url: expect.stringContaining(`/${csvId}/data.csv`),
      googleDriveSync: { status: "disconnected" },
    });
    const pdfFile = artifacts.runs[0]?.files.find((file) => {
      return file.id === pdfId;
    });
    expect(pdfFile).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
      googleDriveSync: { status: "disconnected" },
    });

    // Sync requires a connected Drive.
    const noConnector = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId: csvId },
      [400],
    );
    expectApiError(noConnector.body);
    expect(noConnector.body.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );

    // Connect Google Drive through the public OAuth routes.
    mockGoogleDriveConnectorOAuth();
    const start = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-ok",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    const connected = await connectorsApi.readConnectorByType(
      actor,
      "google-drive",
    );
    expect(connected.connectionStatus).toBe("connected");

    // A connected Drive still needs to be enabled for the thread's agent.
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    for (const file of artifacts.runs[0]?.files ?? []) {
      expect(file.googleDriveSync).toStrictEqual({ status: "disconnected" });
    }
    const disabledForAgent = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: run.runId, fileId: csvId },
      [400],
    );
    expectApiError(disabledForAgent.body);
    expect(disabledForAgent.body.error.message).toBe(
      "Connect Google Drive before syncing artifacts",
    );

    const unknownArtifact = await chat.requestSyncThreadArtifact(
      actor,
      run.threadId,
      { runId: randomUUID(), fileId: randomUUID() },
      [404],
    );
    expectApiError(unknownArtifact.body);
    expect(unknownArtifact.body.error.message).toBe("Artifact file not found");

    const invalidBody = await chat.requestSyncThreadArtifactUnchecked(
      actor,
      run.threadId,
      { runId: 7 },
      [400],
    );
    expectApiError(invalidBody.body);
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    await api.enableAgentConnectors(actor, agentId, ["google-drive"]);

    // Drive lists one mirrored file: csv synced, pdf not synced.
    const listRecorder = mockGoogleDriveFilesList(() => {
      return {
        status: 200,
        files: [
          {
            id: "drive-file-1",
            name: "data.csv",
            webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
            appProperties: {
              vm0Artifact: "true",
              vm0ThreadId: run.threadId,
              vm0RunId: run.runId,
              vm0FileId: csvId,
            },
          },
        ],
      };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    expect(
      artifacts.runs[0]?.files.find((file) => {
        return file.id === csvId;
      })?.googleDriveSync,
    ).toStrictEqual({
      status: "synced",
      id: "drive-file-1",
      name: "data.csv",
      webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
    });
    expect(
      artifacts.runs[0]?.files.find((file) => {
        return file.id === pdfId;
      })?.googleDriveSync,
    ).toStrictEqual({ status: "not_synced" });
    expect(listRecorder.queries[0]).toContain("vm0Artifact");
    expect(listRecorder.queries[0]).toContain(run.threadId);

    // Drive 401 with no refresh credentials resolves to "unknown".
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", undefined);
    mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    artifacts = await chat.listThreadArtifacts(actor, run.threadId);
    for (const file of artifacts.runs[0]?.files ?? []) {
      expect(file.googleDriveSync).toStrictEqual({ status: "unknown" });
    }

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
  }, 120_000);

  it("uploads a presentation to Google Slides behind a feature flag", async () => {
    const { actor } = await entitledChatActor("Slides upload agent");
    const objectStore = chatCallbacks.acceptChatObjectStorage();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("entitled actor is missing an organization");
    }
    const threadId = randomUUID();
    const legacyPptx = {
      name: "deck.pptx",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04]),
    };

    // Gated off by default: the feature switch hides the endpoint.
    const gated = await chat.requestUploadThreadArtifactGoogleSlides(
      actor,
      threadId,
      legacyPptx,
      [403],
    );
    expectApiError(gated.body);
    expect(gated.body.error.code).toBe("FORBIDDEN");

    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId },
      { [FeatureSwitchKey.PresentationGoogleSlidesUpload]: true },
    );

    // Enabled, but Google Drive is not connected yet.
    const noDrive = await chat.requestUploadThreadArtifactGoogleSlides(
      actor,
      threadId,
      legacyPptx,
      [400],
    );
    expectApiError(noDrive.body);
    expect(noDrive.body.error.message).toBe(
      "Connect Google Drive before uploading to Google Slides",
    );

    // Connect Google Drive through the public OAuth routes.
    mockGoogleDriveConnectorOAuth();
    const start = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-ok",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });

    const missingUpload =
      await chat.requestUploadThreadArtifactGoogleSlidesFromUpload(
        actor,
        threadId,
        randomUUID(),
        [404],
      );
    expectApiError(missingUpload.body);
    expect(missingUpload.body.error.message).toBe(
      "Presentation upload not found",
    );

    const oversizedUploadId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${encodeURIComponent(actor.userId)}/${oversizedUploadId}/too-large.pptx`,
      size: 100 * 1024 * 1024 + 1,
    });
    const oversized =
      await chat.requestUploadThreadArtifactGoogleSlidesFromUpload(
        actor,
        threadId,
        oversizedUploadId,
        [400],
      );
    expectApiError(oversized.body);
    expect(oversized.body.error.message).toBe(
      "Presentation file is too large (max 100 MB)",
    );

    // A PPTX larger than Vercel's request-body limit is staged in R2, then
    // Drive converts it into a native Google Slides deck via resumable upload.
    const stagedPptx = new Uint8Array(5 * 1024 * 1024);
    stagedPptx.set([0x50, 0x4b, 0x03, 0x04]);
    const prepared = await chat.prepareUpload(actor, {
      filename: "large-deck.pptx",
      contentType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      size: stagedPptx.byteLength,
    });
    const stagedKey = `artifacts/${encodeURIComponent(actor.userId)}/${prepared.id}/large-deck.pptx`;
    objectStore.addObject({
      bucket: "test-user-artifacts",
      body: stagedPptx,
      key: stagedKey,
      size: stagedPptx.byteLength,
    });
    const uploadRecorder = mockGoogleDriveSlidesUpload();
    const uploaded =
      await chat.requestUploadThreadArtifactGoogleSlidesFromUpload(
        actor,
        threadId,
        prepared.id,
        [200],
      );
    expect(uploaded.body).toStrictEqual({
      id: "slides-file-1",
      name: "deck",
      webViewLink: "https://docs.google.com/presentation/d/slides-file-1/edit",
    });
    expect(uploadRecorder.metadataBodies[0]).toContain(
      "application/vnd.google-apps.presentation",
    );
    expect(uploadRecorder.uploadBodies[0]).toHaveLength(stagedPptx.byteLength);
    expect(uploadRecorder.uploadBodies[0]?.slice(0, 4)).toStrictEqual(
      stagedPptx.slice(0, 4),
    );
    expect(objectStore.deletedKeys).toContain(stagedKey);

    // Old browser bundles can still send the PPTX inline during deployment.
    const legacyUploaded = await chat.requestUploadThreadArtifactGoogleSlides(
      actor,
      threadId,
      legacyPptx,
      [200],
    );
    expect(legacyUploaded.body).toStrictEqual({
      id: "slides-file-1",
      name: "deck",
      webViewLink: "https://docs.google.com/presentation/d/slides-file-1/edit",
    });
    expect(uploadRecorder.uploadBodies[1]).toStrictEqual(legacyPptx.bytes);
  }, 120_000);

  it("dedupes artifact urls and filters hosted-site runs", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Artifacts dedupe agent",
    );
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const objectStore = chatCallbacks.acceptChatObjectStorage();

    // Run 1 uploads its own file plus the shared one.
    const run1 = await sendChatRun(actor, {
      agentId,
      prompt: "first artifact run",
    });
    const claim1 = await claimChatRun(runnerGroup, run1.runId);
    const bearer1 = `Bearer ${zeroTokenFromClaim(claim1.claim)}`;
    const ownId = randomUUID();
    const sharedId = randomUUID();
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${ownId}/page-a.html`,
      size: 128,
    });
    objectStore.addObject({
      bucket: "test-user-artifacts",
      key: `artifacts/${actor.userId}/${sharedId}/page.html`,
      size: 256,
    });
    await chat.completeUploadWithBearer(bearer1, { id: ownId }, [200]);
    await chat.completeUploadWithBearer(bearer1, { id: sharedId }, [200]);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run1.runId, claim1.sandboxHeaders);

    // Run 2 in the same thread re-completes the shared upload: the later
    // run owns the deduplicated URL.
    const run2 = await sendChatRun(actor, {
      agentId,
      threadId: run1.threadId,
      prompt: "second artifact run",
    });
    const claim2 = await claimChatRun(runnerGroup, run2.runId);
    const bearer2 = `Bearer ${zeroTokenFromClaim(claim2.claim)}`;
    await chat.completeUploadWithBearer(bearer2, { id: sharedId }, [200]);

    let artifacts = await chat.listThreadArtifacts(actor, run1.threadId);
    expect(artifacts.runs).toHaveLength(2);
    const run1Group = artifacts.runs.find((group) => {
      return group.runId === run1.runId;
    });
    const run2Group = artifacts.runs.find((group) => {
      return group.runId === run2.runId;
    });
    expect(
      run1Group?.files.map((file) => {
        return file.id;
      }),
    ).toStrictEqual([ownId]);
    expect(
      run2Group?.files.map((file) => {
        return file.id;
      }),
    ).toStrictEqual([sharedId]);

    // A hosted-site deployment on run 2 hides its plain uploads while the
    // plain run keeps its files. With run 2's plain copy of the shared URL
    // filtered out, the URL dedupe no longer applies and run 1 surfaces its
    // own copy again.
    const prepared = await chat.prepareHostedSiteWithBearer(bearer2, {
      site: `bdd-artifact-${randomUUID().slice(0, 8)}`,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>artifact run</main>")],
    });
    await chat.completeHostedSiteWithBearer(bearer2, prepared.deploymentId);

    artifacts = await chat.listThreadArtifacts(actor, run1.threadId);
    const hostedGroup = artifacts.runs.find((group) => {
      return group.runId === run2.runId;
    });
    expect(hostedGroup?.files).toHaveLength(1);
    expect(hostedGroup?.files[0]).toMatchObject({
      artifactKind: "hosted-site",
      url: prepared.url,
      contentType: "text/html",
    });
    const plainGroup = artifacts.runs.find((group) => {
      return group.runId === run1.runId;
    });
    expect(
      plainGroup?.files.map((file) => {
        return file.id;
      }),
    ).toStrictEqual([ownId, sharedId]);

    // A Drive connection without a refresh token resolves 401s to "unknown".
    mockGoogleDriveConnectorOAuth({ omitRefreshToken: true });
    const start = await connectorsApi.startOauth(
      actor,
      "google-drive",
      "oauth",
    );
    await connectorsApi.completeOauthCallback("google-drive", {
      code: "drive-no-refresh",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    await api.enableAgentConnectors(actor, agentId, ["google-drive"]);
    mockGoogleDriveFilesList(() => {
      return { status: 401 };
    });
    artifacts = await chat.listThreadArtifacts(actor, run1.threadId);
    for (const group of artifacts.runs) {
      for (const file of group.files) {
        expect(file.googleDriveSync).toStrictEqual({ status: "unknown" });
      }
    }

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run2.runId, claim2.sandboxHeaders);
  }, 120_000);
});

describe("CHAT-01 v1 chat threads for personal access tokens", () => {
  it("authenticates v1 thread reads with personal access tokens", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "V1 reads agent",
    });
    authOrg.mockClerkOrg(owner);
    const key = await authOrg.createApiKey(owner, {
      name: "bdd-v1-read",
      expiresInDays: 30,
    });
    const bearer = `Bearer ${key.token}`;

    const thread = await chat.createThread(owner, {
      agentId: agent.agentId,
      title: "v1 metadata",
    });
    const threadId = thread.id;
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: "v1 round one",
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: "v1 round two",
    });
    const page = await chat.listThreadMessages(owner, threadId);
    const ids = page.messages.map((message) => {
      return message.id;
    });
    const [m1, m2, m3, m4] = ids;
    if (!m1 || !m2 || !m3 || !m4) {
      throw new Error("Expected four seeded thread messages");
    }

    // Path validation runs before auth.
    const app = createApp({ signal: context.signal });
    const malformed = await app.request("/api/v1/chat-threads/not-a-uuid");
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(malformedBody.error.code).toBe("BAD_REQUEST");
    expect(malformedBody.error.message).toContain("threadId");

    // 401 matrix: missing header (web's phrasing), opaque bearer, revoked
    // and expired PATs.
    const missingHeader = await chat.requestV1Thread(
      undefined,
      randomUUID(),
      [401],
    );
    expectApiError(missingHeader.body);
    expect(missingHeader.body.error).toStrictEqual({
      message: "API key required",
      code: "UNAUTHORIZED",
    });

    const opaque = await chat.requestV1Thread(
      "Bearer ak_unknown_opaque_secret",
      randomUUID(),
      [401],
    );
    expectApiError(opaque.body);

    const revokedKey = await authOrg.createApiKey(owner, {
      name: "bdd-v1-revoked",
      expiresInDays: 30,
    });
    await authOrg.deleteApiKey(owner, revokedKey.id);
    const revoked = await chat.requestV1Thread(
      `Bearer ${revokedKey.token}`,
      threadId,
      [401],
    );
    expectApiError(revoked.body);

    const expiringKey = await authOrg.createApiKey(owner, {
      name: "bdd-v1-expiring",
      expiresInDays: 30,
    });
    onTestFinished(() => {
      clearMockNow();
    });
    mockNow(now() + 91 * 24 * 60 * 60 * 1000);
    const expired = await chat.requestV1Thread(
      `Bearer ${expiringKey.token}`,
      threadId,
      [401],
    );
    clearMockNow();
    expectApiError(expired.body);

    // Sandbox tokens are rejected by token type.
    const sandboxBearer = `Bearer ${api.sandboxTokenForRun(owner, randomUUID())}`;
    const sandboxThread = await chat.requestV1Thread(
      sandboxBearer,
      threadId,
      [403],
    );
    expectApiError(sandboxThread.body);
    expect(sandboxThread.body.error.code).toBe("FORBIDDEN");

    // The owning PAT reads narrow thread metadata.
    const detail = await chat.requestV1Thread(bearer, threadId, [200]);
    expect(detail.body).toStrictEqual({
      id: threadId,
      title: "v1 metadata",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const missingThread = await chat.requestV1Thread(
      bearer,
      randomUUID(),
      [404],
    );
    expectApiError(missingThread.body);

    const intruder = bdd.user();
    authOrg.mockClerkOrg(intruder);
    const intruderKey = await authOrg.createApiKey(intruder, {
      name: "bdd-v1-intruder",
      expiresInDays: 30,
    });
    const intruderRead = await chat.requestV1Thread(
      `Bearer ${intruderKey.token}`,
      threadId,
      [404],
    );
    expectApiError(intruderRead.body);

    // Messages: auth matrix plus chronological, forward, and backward pages.
    const messagesNoHeader = await chat.requestV1ThreadMessages(
      undefined,
      threadId,
      {},
      [401],
    );
    expectApiError(messagesNoHeader.body);
    const messagesSandbox = await chat.requestV1ThreadMessages(
      sandboxBearer,
      threadId,
      {},
      [403],
    );
    expectApiError(messagesSandbox.body);
    const messagesIntruder = await chat.requestV1ThreadMessages(
      `Bearer ${intruderKey.token}`,
      threadId,
      {},
      [404],
    );
    expectApiError(messagesIntruder.body);

    const chronological = await chat.requestV1ThreadMessages(
      bearer,
      threadId,
      {},
      [200],
    );
    if (chronological.status !== 200) {
      throw new Error("Expected the owning PAT to list v1 messages");
    }
    expect(
      chronological.body.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([m1, m2, m3, m4]);
    expect(chronological.body.messages[0]).toMatchObject({
      role: "user",
      content: "v1 round one",
    });

    const since = await chat.requestV1ThreadMessages(
      bearer,
      threadId,
      { sinceId: m2 },
      [200],
    );
    if (since.status !== 200) {
      throw new Error("Expected the forward page to resolve");
    }
    expect(
      since.body.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([m3, m4]);

    const before = await chat.requestV1ThreadMessages(
      bearer,
      threadId,
      { beforeId: m3, limit: 2 },
      [200],
    );
    if (before.status !== 200) {
      throw new Error("Expected the backward page to resolve");
    }
    expect(
      before.body.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([m1, m2]);
  }, 60_000);

  it("sends v1 chat messages with a personal access token", async () => {
    const { actor, agentId, runnerGroup } =
      await entitledChatActor("V1 send agent");
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    authOrg.mockClerkOrg(actor);
    const key = await authOrg.createApiKey(actor, {
      name: "bdd-v1-send",
      expiresInDays: 30,
    });
    const bearer = `Bearer ${key.token}`;
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-v1-key");
    let initialThinkingRequests = 0;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = (await request.json()) as {
            readonly messages?: readonly {
              readonly content?: unknown;
            }[];
          };
          const requestText = (payload.messages ?? [])
            .map((message) => {
              return typeof message.content === "string" ? message.content : "";
            })
            .join("\n\n");
          if (requestText.includes("Write user-visible progress copy")) {
            initialThinkingRequests += 1;
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "not expected for v1 send" },
              },
            ],
          });
        },
      ),
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "v1 send thread",
    });

    const missingHeader = await chat.requestV1Send(
      undefined,
      { prompt: "hello", threadId: thread.id },
      [401],
    );
    expectApiError(missingHeader.body);
    expect(missingHeader.body.error).toStrictEqual({
      message: "API key required",
      code: "UNAUTHORIZED",
    });

    const sandboxSend = await chat.requestV1Send(
      `Bearer ${api.sandboxTokenForRun(actor, randomUUID())}`,
      { prompt: "hello", threadId: thread.id },
      [403],
    );
    expectApiError(sandboxSend.body);

    const missingThreadId = await chat.requestV1SendUnchecked(
      bearer,
      { prompt: "hello" },
      [400],
    );
    expectApiError(missingThreadId.body);
    expect(missingThreadId.body.error.message).toContain("threadId");

    const unknownThread = await chat.requestV1Send(
      bearer,
      { prompt: "hello", threadId: randomUUID() },
      [404],
    );
    expectApiError(unknownThread.body);
    expect(unknownThread.body.error.message).toBe("Chat thread not found");

    const stranger = bdd.user();
    authOrg.mockClerkOrg(stranger);
    const strangerKey = await authOrg.createApiKey(stranger, {
      name: "bdd-v1-stranger",
      expiresInDays: 30,
    });
    const strangerSend = await chat.requestV1Send(
      `Bearer ${strangerKey.token}`,
      { prompt: "nope", threadId: thread.id },
      [404],
    );
    expectApiError(strangerSend.body);

    // A thread on a compose without a zero agent surfaces the inner send
    // result unchanged.
    const compose = await chat.createComposeForChatThread(actor);
    const composeThread = await chat.createThread(actor, {
      agentId: compose.composeId,
      title: "compose-only thread",
    });
    const composeSend = await chat.requestV1Send(
      bearer,
      {
        prompt: "no zero agent behind this thread",
        threadId: composeThread.id,
      },
      [404],
    );
    expectApiError(composeSend.body);
    expect(composeSend.body.error.message).toBe("Agent not found");

    // Happy path: the send appends to the thread and creates a run.
    const sent = await chat.requestV1Send(
      bearer,
      { prompt: "hello from v1", threadId: thread.id },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the v1 send to create a run");
    }
    expect(sent.body).toStrictEqual({
      threadId: thread.id,
      messageId: expect.any(String),
      runId: expect.any(String),
      createdAt: expect.any(String),
    });
    const run1Id = sent.body.runId;

    const run1 = await api.readRun(actor, run1Id);
    expect(run1.prompt).toBe("hello from v1");
    expect(run1.appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    await waitForThreadMessages(actor, thread.id, (messages) => {
      return userMessages(messages).some((message) => {
        return message.id === sent.body.messageId;
      });
    });

    const v1Page = await chat.requestV1ThreadMessages(
      bearer,
      thread.id,
      {},
      [200],
    );
    if (v1Page.status !== 200) {
      throw new Error("Expected the v1 messages page after the send");
    }
    expect(v1Page.body.messages).toContainEqual(
      expect.objectContaining({
        id: sent.body.messageId,
        role: "user",
        content: "hello from v1",
      }),
    );
    const zeroPage = await waitForThreadMessages(
      actor,
      thread.id,
      (messages) => {
        return userMessages(messages).some((message) => {
          return message.id === sent.body.messageId && message.runId === run1Id;
        });
      },
    );
    expect(
      userMessages(zeroPage.messages).find((message) => {
        return message.id === sent.body.messageId;
      }),
    ).toMatchObject({ content: "hello from v1", runId: run1Id });
    await flushWaitUntilForTest();
    const afterV1SideEffects = await chat.listThreadMessages(actor, thread.id);
    expect(initialThinkingRequests).toBe(0);
    expect(
      assistantMessages(afterV1SideEffects.messages).some((message) => {
        return (
          message.runId === run1Id && message.runEventId === "thinking:initial"
        );
      }),
    ).toBeFalsy();

    // The claim carries a run-scoped ZERO_TOKEN for the sandbox.
    const claim1 = await claimChatRun(runnerGroup, run1Id);
    expect(zeroTokenFromClaim(claim1.claim)).toMatch(/^vm0_sandbox_/);

    // Completing without any chat events renders the prior run with the
    // no-stored-assistant fallback in the next send's context.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run1Id, claim1.sandboxHeaders);
    await waitForThreadMessages(actor, thread.id, (messages) => {
      return assistantMessages(messages).some((message) => {
        return (
          message.runId === run1Id && message.runLifecycleEvent === "completed"
        );
      });
    });

    const second = await chat.requestV1Send(
      bearer,
      { prompt: "continue from v1", threadId: thread.id },
      [201],
    );
    if (second.status !== 201 || second.body.runId === null) {
      throw new Error("Expected the second v1 send to create a run");
    }
    const run2Id = second.body.runId;
    await expectZeroPreCreateSource(run2Id, "chat_thread_v1_send");
    const run2 = await api.readRun(actor, run2Id);
    const appended = run2.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${run1Id}`);
    expect(appended).toContain("Assistant: [no stored assistant message]");

    // The second run resumes the session checkpointed by the first.
    const claim2 = await claimChatRun(runnerGroup, run2Id);
    expect(claim2.claim.resumeSession?.sessionId).toBe(`bdd-cli-${run1Id}`);

    // A send into a thread with an active run queues the message.
    const queued = await chat.requestV1Send(
      bearer,
      { prompt: "queued from v1", threadId: thread.id },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued v1 send to be accepted");
    }
    expect(queued.body).toStrictEqual({
      threadId: thread.id,
      messageId: expect.any(String),
      runId: null,
      createdAt: expect.any(String),
    });

    // Completing the active run auto-sends the queued message into a new run.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run2Id, claim2.sandboxHeaders);
    const afterQueue = await waitForThreadMessages(
      actor,
      thread.id,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesMessageId === queued.body.messageId &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(afterQueue.messages).find((message) => {
      return message.revokesMessageId === queued.body.messageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued v1 message to auto-send into a run");
    }
    expect(promoted.content).toBe("queued from v1");
    const original = await chat.getThreadMessage(
      actor,
      thread.id,
      queued.body.messageId,
    );
    expect(original.runId).toBeUndefined();
    await expectZeroPreCreateSource(promoted.runId, "chat_callback_auto_send");
    await flushWaitUntilForTest();
    const afterAutoSendSideEffects = await chat.listThreadMessages(
      actor,
      thread.id,
    );
    expect(initialThinkingRequests).toBe(0);
    expect(
      assistantMessages(afterAutoSendSideEffects.messages).some((message) => {
        return (
          message.runId === promoted.runId &&
          message.runEventId === "thinking:initial"
        );
      }),
    ).toBeFalsy();
    await cancelChatRun(actor, promoted.runId);

    // Workflows still mount as SKILL.md-backed volumes in the runtime. Under
    // the agent-scoped 1:N model the workflow is created directly under the
    // agent and the volume is keyed by the workflow id (mounted at the slug).
    const workflowName = `bdd-workflow-${randomUUID().slice(0, 12)}`;
    const createdWorkflow = await accept(
      setupApp({ context })(zeroWorkflowsCollectionContract).create({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          name: workflowName,
          instruction: "# bdd workflow",
        },
      }),
      [201],
    );
    if (createdWorkflow.status !== 201) {
      throw new Error("Expected the bdd workflow to be created");
    }
    const workflowId = createdWorkflow.body.id;
    const workflowStorageName = `custom-skill@${workflowId}`;

    const workflowSend = await chat.requestV1Send(
      bearer,
      { prompt: "use the bdd workflow", threadId: thread.id },
      [201],
    );
    if (workflowSend.status !== 201 || workflowSend.body.runId === null) {
      throw new Error("Expected the workflow-mounting v1 send to create a run");
    }
    const run4Id = workflowSend.body.runId;
    const claim4 = await claimChatRun(runnerGroup, run4Id);
    expect(claim4.claim.storageManifest?.storages).toContainEqual(
      expect.objectContaining({
        name: workflowStorageName,
        mountPath: `/home/user/.claude/skills/${workflowName}`,
      }),
    );
    await cancelChatRun(actor, run4Id);

    // Deleting the workflow removes the mount from the next run's claim.
    await accept(
      setupApp({ context })(zeroWorkflowsDetailContract).delete({
        headers: sessionHeaders(actor),
        params: { workflowId },
      }),
      [204],
    );
    const afterDelete = await chat.requestV1Send(
      bearer,
      { prompt: "after the workflow is deleted", threadId: thread.id },
      [201],
    );
    if (afterDelete.status !== 201 || afterDelete.body.runId === null) {
      throw new Error("Expected the post-delete v1 send to create a run");
    }
    const claim5 = await claimChatRun(runnerGroup, afterDelete.body.runId);
    expect(JSON.stringify(claim5.claim)).not.toContain(workflowStorageName);
    await cancelChatRun(actor, afterDelete.body.runId);
  }, 180_000);
});
