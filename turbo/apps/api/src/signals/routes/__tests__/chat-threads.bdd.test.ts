import { createHash, randomUUID } from "node:crypto";

import { cronCompactChatThreadSnapshotsContract } from "@vm0/api-contracts/contracts/cron";
import {
  chatThreadsContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@vm0/api-contracts/contracts/model-providers";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import {
  holdChatMessageInsertTransactionFixture,
  insertChatMessageTransactionFixture,
} from "../../../test-fixtures/chat-messages";
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
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  deleteVm0ManagedDefaultModelKey,
  seedVm0ManagedDefaultModelKey,
} from "./helpers/runtime-state";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";

/**
 * CHAT-01 / CHAT-03: chat thread lifecycle beyond the mutation chain that
 * lives in chat-files.bdd.test.ts — event snapshots and read state, thread
 * detail model pins, create/delete cascades, search, thread artifacts with
 * Google Drive sync status.
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

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

type EntitledChatActorWithoutRunner = Omit<EntitledChatActor, "runnerGroup">;

async function entitledChatActorWithoutRunner(
  displayName: string,
): Promise<EntitledChatActorWithoutRunner> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, providerId };
}

async function entitledChatActor(
  displayName: string,
): Promise<EntitledChatActor> {
  const runnerGroup = api.configureRunnerGroup();
  return {
    ...(await entitledChatActorWithoutRunner(displayName)),
    runnerGroup,
  };
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
  await api.ensureOrgModelProvider(actor);
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
const CHAT_THREAD_READ_CAPABILITIES = [
  "chat-thread:read",
] as const satisfies readonly ZeroCapability[];

function goalsClient() {
  return setupApp({ context })(zeroGoalsContract);
}

function zeroCapabilityHeaders(
  actor: ApiTestUser,
  runId: string,
  capabilities: readonly ZeroCapability[],
): { readonly authorization: string } {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor for zero auth");
  }
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "zero",
      userId: actor.userId,
      orgId: actor.orgId,
      runId,
      capabilities: [...capabilities],
      iat: seconds,
      exp: seconds + 600,
    })}`,
  };
}

/** Run-scoped zero bearer with goal capabilities, as issued to sandboxes. */
function zeroGoalHeaders(
  actor: ApiTestUser,
  runId: string,
): { readonly authorization: string } {
  return zeroCapabilityHeaders(actor, runId, GOAL_CAPABILITIES);
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

  it("allows chat-thread read zero tokens to sync snapshots and events", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await api.ensureOrgModelProvider(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    });
    const zeroClient = setupApp({ context })(chatThreadsContract);
    const zeroHeaders = zeroCapabilityHeaders(
      actor,
      randomUUID(),
      CHAT_THREAD_READ_CAPABILITIES,
    );

    const snapshot = await accept(
      zeroClient.snapshot({ headers: zeroHeaders }),
      [200],
    );
    expect(snapshot.body).toStrictEqual({
      chatThreads: [],
      latestEventId: null,
    });
    const events = await accept(
      zeroClient.events({ headers: zeroHeaders, query: {} }),
      [200],
    );
    expect(events.body).toStrictEqual({
      events: [],
      hasMore: false,
    });

    const missingCapability = await accept(
      zeroClient.snapshot({
        headers: zeroGoalHeaders(actor, randomUUID()),
      }),
      [403],
    );
    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: chat-thread:read",
        code: "FORBIDDEN",
      },
    });
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
    await api.ensureOrgModelProvider(actor);
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
    expect(allEvents.body.events).toHaveLength(4);
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
        expect.objectContaining({
          kind: "service_tier_updated",
          chatThreadId: thread.id,
          agentId: agent.agentId,
          serviceTier: null,
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
    expect(afterCreate.body.events).toHaveLength(3);
    expect(afterCreate.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: renameEventId }),
        expect.objectContaining({ id: modelSelectionEventId }),
        expect.objectContaining({ kind: "service_tier_updated" }),
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
    await api.ensureOrgModelProvider(actor);
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

  it("rejects explicit thread models outside current workspace policy", async () => {
    const { actor, agentId, providerId } = await entitledChatActor(
      "Unavailable explicit thread model agent",
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-6",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const rejectedThreadId = randomUUID();
    const rejectedCreate = await chat.requestCreateThread(
      actor,
      {
        agentId,
        clientThreadId: rejectedThreadId,
        model: "claude-sonnet-4-6",
      },
      [400],
    );
    expectApiError(rejectedCreate.body);
    expect(rejectedCreate.body.error.message).toBe(
      "The selected model is not available in this workspace",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-opus-4-6",
    });
    const rejectedUpdate = await chat.requestUpdateThreadModelSelection(
      actor,
      thread.id,
      "claude-sonnet-4-6",
      [400],
    );
    expectApiError(rejectedUpdate.body);
    expect(rejectedUpdate.body.error.message).toBe(
      "The selected model is not available in this workspace",
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
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "MiniMax-M3",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
      title: "limited free model pin",
    });
    for (const selectedModel of ["gpt-5.6-sol", "gpt-5.5"] as const) {
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
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use thread agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Computer Use",
    });

    const host = await cu.startComputerUseHost(actor);
    await chat.updateThreadComputerUseHost(actor, thread.id, host.hostId);

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

    const hostEvents = (await allThreadEvents(actor)).filter((event) => {
      return (
        event.chatThreadId === thread.id &&
        event.kind === "computer_use_host_updated"
      );
    });
    expect(hostEvents).toHaveLength(2);
    expect(
      hostEvents.map((event) => {
        return event.computerUseHostId;
      }),
    ).toStrictEqual([host.hostId, null]);

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
    context.mocks.ably.publish.mockClear();
    const firstRead = await chat.markThreadRead(owner, activeRun.threadId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      {
        threadId: activeRun.threadId,
        agentId: agentA,
        lastReadAt: firstRead.lastReadAt,
      },
    );
    context.mocks.ably.publish.mockClear();
    const repeatedRead = await chat.markThreadRead(owner, activeRun.threadId);
    expect(repeatedRead.lastReadAt).toBe(firstRead.lastReadAt);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
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
    context.mocks.ably.publish.mockClear();
    await chat.markAgentThreadsRead(owner, agentA);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

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
      ["user", "cursor round one"],
      ["assistant", expect.stringContaining("Insufficient credits")],
      ["user", "cursor round two"],
      ["user", "cursor round two"],
      ["assistant", expect.stringContaining("Insufficient credits")],
    ]);
    const seqIds = full.messages.map((message) => {
      return message.seqId;
    });
    expect(seqIds).toStrictEqual(
      [...seqIds].sort((left, right) => {
        return left - right;
      }),
    );
    expect(new Set(seqIds).size).toBe(seqIds.length);
    const [
      firstQueuedUserMessage,
      firstReplacementMessage,
      firstAssistantMessage,
      secondQueuedUserMessage,
      secondReplacementMessage,
      secondAssistantMessage,
    ] = full.messages;
    if (
      !firstQueuedUserMessage ||
      !firstReplacementMessage ||
      !firstAssistantMessage ||
      !secondQueuedUserMessage ||
      !secondReplacementMessage ||
      !secondAssistantMessage
    ) {
      throw new Error("Expected six messages across the two sends");
    }
    const firstQueuedUser = firstQueuedUserMessage.id;
    const firstReplacement = firstReplacementMessage.id;
    const firstAssistant = firstAssistantMessage.id;
    const secondQueuedUser = secondQueuedUserMessage.id;
    const secondReplacement = secondReplacementMessage.id;
    const secondAssistant = secondAssistantMessage.id;
    const firstAssistantSeqId = firstAssistantMessage.seqId;
    const secondQueuedUserSeqId = secondQueuedUserMessage.seqId;
    const secondAssistantSeqId = secondAssistantMessage.seqId;
    expect(full.messages[0]?.error).toBeUndefined();
    expect(full.messages[1]).toMatchObject({
      error: "insufficient_credits",
      revokesMessageId: firstQueuedUser,
    });
    expect(full.messages[3]?.error).toBeUndefined();
    expect(full.messages[4]).toMatchObject({
      error: "insufficient_credits",
      revokesMessageId: secondQueuedUser,
    });

    // Latest page overflow: only the newest rows, with history behind them.
    const latest = await chat.listThreadMessages(owner, threadId, {
      limit: 2,
    });
    expect(
      latest.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondReplacement, secondAssistant]);
    expect(latest.hasHistoryBefore).toBeTruthy();

    // Forward pagination strictly after the cursor.
    const since = await chat.listThreadMessages(owner, threadId, {
      sinceSeqId: firstAssistantSeqId,
    });
    expect(
      since.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondQueuedUser, secondReplacement, secondAssistant]);
    const legacySince = await chat.listThreadMessages(owner, threadId, {
      sinceId: firstAssistant,
    });
    expect(
      legacySince.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondQueuedUser, secondReplacement, secondAssistant]);

    // Backward pagination strictly before the cursor.
    const before = await chat.listThreadMessages(owner, threadId, {
      beforeSeqId: secondQueuedUserSeqId,
      limit: 3,
    });
    expect(
      before.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([firstQueuedUser, firstReplacement, firstAssistant]);
    expect(before.hasHistoryBefore).toBeFalsy();
    const legacyBefore = await chat.listThreadMessages(owner, threadId, {
      beforeId: secondQueuedUser,
      limit: 3,
    });
    expect(
      legacyBefore.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([firstQueuedUser, firstReplacement, firstAssistant]);
    expect(legacyBefore.hasHistoryBefore).toBeFalsy();

    const beforeOverflow = await chat.listThreadMessages(owner, threadId, {
      beforeSeqId: secondAssistantSeqId,
      limit: 2,
    });
    expect(
      beforeOverflow.messages.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([secondQueuedUser, secondReplacement]);
    expect(beforeOverflow.hasHistoryBefore).toBeTruthy();
  }, 30_000);

  it("serializes concurrent message sequence writes through commit", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "Concurrent message sequence agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "sequence serialization anchor",
    });

    const firstContent = `held sequence message ${randomUUID()}`;
    const secondContent = `blocked sequence message ${randomUUID()}`;
    const held = await holdChatMessageInsertTransactionFixture({
      threadId,
      content: firstContent,
      signal: context.signal,
    });
    const secondInsert = insertChatMessageTransactionFixture({
      threadId,
      content: secondContent,
    });
    onTestFinished(async () => {
      held.release();
      await Promise.allSettled([held.done, secondInsert]);
    });

    await expect.poll(held.blockedWaiterCount).toBe(1);
    const beforeCommit = await chat.listThreadMessages(owner, threadId);
    expect(
      beforeCommit.messages.some((message) => {
        return (
          message.content === firstContent || message.content === secondContent
        );
      }),
    ).toBeFalsy();

    held.release();
    await held.done;
    const second = await secondInsert;
    const committed = await chat.listThreadMessages(owner, threadId);
    const concurrentRows = committed.messages.filter((message) => {
      return message.id === held.message.id || message.id === second.id;
    });
    expect(
      concurrentRows.map((message) => {
        return message.id;
      }),
    ).toStrictEqual([held.message.id, second.id]);
    expect(held.message.seqId).toBeLessThan(second.seqId);
  }, 30_000);
});

describe("CHAT-03 run usage messages", () => {
  it("emits one immutable usage message per run", async () => {
    const { actor, agentId } = await entitledChatActorWithoutRunner(
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
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}`,
    };
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
    const billing = createBillingMediaApi(context);
    await billing.processUsageEvents();

    let usageMessages = await usageMessagesForRun(actor, threadId, runId);
    expect(usageMessages).toHaveLength(1);
    const usageMessage = usageMessages[0];
    if (!usageMessage) {
      throw new Error("Expected one usage message");
    }
    expect(usageMessage).toMatchObject({
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

    onTestFinished(() => {
      clearMockNow();
    });
    // Sandbox tokens are validated against the mockable clock, so record late
    // usage before advancing time for settlement.
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
    expect(usageMessages).toStrictEqual([usageMessage]);

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
    expect(usageMessages).toStrictEqual([usageMessage]);
  }, 60_000);

  it("emits complete allowance-covered usage in one message", async () => {
    const seededModel = await seedVm0ManagedDefaultModelKey(context);
    const selectedModel = DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
    expect(seededModel).toBe(selectedModel);
    onTestFinished(async () => {
      await deleteVm0ManagedDefaultModelKey(context);
    });

    const { actor, agentId } = await entitledChatActorWithoutRunner(
      "Allowance usage message agent",
    );
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected allowance chat actor to have an org");
    }
    await seedOrgMetadata({ orgId, tier: "pro", credits: 10 });
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId,
      userId: actor.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      effectiveAt: new Date(now()),
      expiresAt: new Date(now() + 365 * 24 * 60 * 60 * 1000),
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 24 * 60 * 60,
      weeklyWindowUnits: 100,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: selectedModel,
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const provider = `allowance-chat-${randomUUID().slice(0, 8)}`;
    const category = "api_request";
    await seedUsagePricingRows([
      { kind: "connector", provider, category, unitPrice: 1, unitSize: 1 },
    ]);
    const { runId, threadId } = await sendChatRun(actor, {
      agentId,
      prompt: "record allowance-covered usage",
      model: selectedModel,
    });
    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}`,
    };
    await webhooks.requestAgentUsageEvent(
      {
        runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider,
            category,
            quantity: 70,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await createBillingMediaApi(context).processUsageEvents();

    const usageMessages = await usageMessagesForRun(actor, threadId, runId);
    expect(usageMessages).toHaveLength(1);
    expect(usageMessages[0]).toMatchObject({
      role: "assistant",
      content: null,
      usage: {
        version: 1,
        breakdown: [
          {
            kind: "connector",
            credits: 70,
            providers: [{ provider, credits: 70 }],
          },
        ],
        totalCredits: 70,
        settledAt: expect.any(String),
      },
    });
    const billingStatus = await api.readBillingStatus(actor);
    if (!billingStatus.usageAllowance) {
      throw new Error("Expected allowance windows for chat usage");
    }
    expect(
      Object.fromEntries(
        billingStatus.usageAllowance.windows.map((window) => {
          return [window.kind, window.consumedUnits];
        }),
      ),
    ).toStrictEqual({ short: 70, weekly: 70 });
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

  it("associates batched context windows across matches and threads", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agentA = await bdd.createAgent(owner, {
      displayName: "Batched search agent A",
    });
    const agentB = await bdd.createAgent(owner, {
      displayName: "Batched search agent B",
    });
    const marker = `batched-${randomUUID()}`;
    const alphaPrompt = `${marker} needle alpha`;
    const betaPrompt = `${marker} needle beta`;
    const gammaPrompt = `${marker} needle gamma`;
    const sharedPrompt = `${marker} shared bridge`;

    const threadA = await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      prompt: `${marker} first anchor`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      threadId: threadA,
      prompt: alphaPrompt,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      threadId: threadA,
      prompt: sharedPrompt,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      threadId: threadA,
      prompt: betaPrompt,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentA.agentId,
      threadId: threadA,
      prompt: `${marker} final anchor`,
    });

    const threadB = await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      prompt: `${marker} second anchor`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      threadId: threadB,
      prompt: gammaPrompt,
    });
    await sendNoCreditMessage(owner, {
      agentId: agentB.agentId,
      threadId: threadB,
      prompt: `${marker} second tail`,
    });

    const contextual = await chat.searchChat(owner, `${marker} needle`, {
      limit: 3,
      before: 2,
      after: 2,
    });
    expect(contextual.hasMore).toBeFalsy();
    expect(
      contextual.results
        .map((result) => {
          return result.matchedMessage.content;
        })
        .sort(),
    ).toStrictEqual([alphaPrompt, betaPrompt, gammaPrompt].sort());

    const matchesByContent = new Map(
      contextual.results.map((result) => {
        return [result.matchedMessage.content, result] as const;
      }),
    );
    const alpha = matchesByContent.get(alphaPrompt);
    const beta = matchesByContent.get(betaPrompt);
    const gamma = matchesByContent.get(gammaPrompt);
    if (!alpha || !beta || !gamma) {
      throw new Error("Expected all batched chat-search matches");
    }
    expect(alpha.chatThreadId).toBe(threadA);
    expect(beta.chatThreadId).toBe(threadA);
    expect(gamma.chatThreadId).toBe(threadB);

    for (const match of contextual.results) {
      expect(match.contextBefore).toHaveLength(2);
      expect(match.contextAfter).toHaveLength(2);
      expect(
        [...match.contextBefore, ...match.contextAfter].every((message) => {
          return message.chatThreadId === match.chatThreadId;
        }),
      ).toBeTruthy();
      expect(
        [...match.contextBefore, ...match.contextAfter].some((message) => {
          return message.messageId === match.matchedMessage.messageId;
        }),
      ).toBeFalsy();

      const matchedAt = Date.parse(match.matchedMessage.createdAt);
      const beforeTimes = match.contextBefore.map((message) => {
        return Date.parse(message.createdAt);
      });
      const afterTimes = match.contextAfter.map((message) => {
        return Date.parse(message.createdAt);
      });
      expect(
        beforeTimes.every((createdAt) => {
          return createdAt < matchedAt;
        }),
      ).toBeTruthy();
      expect(
        afterTimes.every((createdAt) => {
          return createdAt > matchedAt;
        }),
      ).toBeTruthy();
      expect(
        [...beforeTimes].sort((left, right) => {
          return left - right;
        }),
      ).toStrictEqual(beforeTimes);
      expect(
        [...afterTimes].sort((left, right) => {
          return left - right;
        }),
      ).toStrictEqual(afterTimes);
    }

    const sharedAfterAlpha = alpha.contextAfter.filter((message) => {
      return message.content === sharedPrompt;
    });
    const sharedBeforeBeta = beta.contextBefore.filter((message) => {
      return message.content === sharedPrompt;
    });
    // The revoked queue-first duplicate stays hidden, while the visible row
    // remains associated with both overlapping windows.
    expect(sharedAfterAlpha).toHaveLength(1);
    expect(sharedBeforeBeta).toHaveLength(1);
    expect(sharedAfterAlpha[0]?.messageId).toBe(sharedBeforeBeta[0]?.messageId);

    const beforeOnly = await chat.searchChat(owner, `${marker} needle`, {
      limit: 3,
      before: 1,
      after: 0,
    });
    expect(beforeOnly.results).toHaveLength(3);
    for (const match of beforeOnly.results) {
      expect(match.contextBefore).toHaveLength(1);
      expect(match.contextAfter).toStrictEqual([]);
    }

    const afterOnly = await chat.searchChat(owner, `${marker} needle`, {
      limit: 3,
      before: 0,
      after: 1,
    });
    expect(afterOnly.results).toHaveLength(3);
    for (const match of afterOnly.results) {
      expect(match.contextBefore).toStrictEqual([]);
      expect(match.contextAfter).toHaveLength(1);
    }
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
    // Run 1's completion drains the thread queue via waitUntil side effects;
    // flush them so the drain cannot claim run 2's queued message first.
    await flushWaitUntilForTest();

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
