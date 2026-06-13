import { createHash, randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import { asc, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { describe, expect, it, onTestFinished } from "vitest";

import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { writeDb$ } from "../../external/db";
import { maybeEmitRunUsageMessage$ } from "../../services/zero-chat-usage-message.service";
import { MODEL_FIRST_SELECTION_PROVIDER_ID } from "../../services/zero-model-selection.service";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createChatFilesBddApi,
  hostedTextFile,
} from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockGoogleDriveConnectorOAuth,
  mockGoogleDriveFilesList,
} from "./helpers/api-bdd-connectors";
import {
  createRunsAutomationsApi,
  uniqueAutomationName,
} from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

/**
 * CHAT-01 / CHAT-03: chat thread lifecycle beyond the mutation chain that
 * lives in chat-files.bdd.test.ts — list pagination and read state, thread
 * detail model pins, create/delete cascades, search, GitHub PR tracking,
 * thread artifacts with Google Drive sync status, and the `/api/v1`
 * personal-access-token surface.
 *
 * Most Given state is constructed through public APIs (Stripe-webhook
 * entitlement, org model provider routes, runner heartbeat/claim, sandbox
 * report webhooks, connector OAuth flows, feature-switch and skills routes).
 * Targeted database checks are kept for migration and side-effect coverage
 * where the persisted row shape is the contract under test.
 */

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsAutomationsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectorsApi = createConnectorBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const routeMocks = createZeroRouteMocks(context);

type AssistantMessage = Extract<PagedChatMessage, { role: "assistant" }>;
type UserMessage = Extract<PagedChatMessage, { role: "user" }>;
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

const seedUsagePricing$ = command(
  async (
    { set },
    args: {
      readonly provider: string;
      readonly category: string;
      readonly unitPrice: number;
      readonly unitSize: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.insert(usagePricing).values({
      kind: "connector",
      provider: args.provider,
      category: args.category,
      unitPrice: args.unitPrice,
      unitSize: args.unitSize,
    });
    signal.throwIfAborted();
  },
);

const insertRunUsageEvent$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly provider: string;
      readonly status: "pending" | "processed";
      readonly creditsCharged: number | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.insert(usageEvent).values({
      runId: args.runId,
      orgId: args.orgId,
      userId: args.userId,
      kind: "connector",
      provider: args.provider,
      category: "api_request",
      quantity: 1,
      status: args.status,
      creditsCharged: args.creditsCharged,
      processedAt: args.status === "processed" ? nowDate() : null,
      idempotencyKey: randomUUID(),
    });
    signal.throwIfAborted();
  },
);

const usageEventsForRun$ = command(
  async ({ set }, runId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        provider: usageEvent.provider,
        category: usageEvent.category,
        creditsCharged: usageEvent.creditsCharged,
        status: usageEvent.status,
        billingError: usageEvent.billingError,
      })
      .from(usageEvent)
      .where(eq(usageEvent.runId, runId))
      .orderBy(asc(usageEvent.provider), asc(usageEvent.category));
    signal.throwIfAborted();
    return rows;
  },
);

const usageMessagesForRun$ = command(
  async ({ set }, runId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        id: chatMessages.id,
        usagePayload: chatMessages.usagePayload,
      })
      .from(chatMessages)
      .where(eq(chatMessages.runId, runId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    signal.throwIfAborted();
    return rows.filter((row) => {
      return row.usagePayload !== null;
    });
  },
);

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
    readonly modelSelection?: {
      readonly modelProviderId: string;
      readonly selectedModel: string;
    };
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

function listedThreadIds(page: {
  readonly pinned: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}): readonly string[] {
  return [...page.pinned, ...page.threads].map((thread) => {
    return thread.id;
  });
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
    const unauthenticated = await app.request("/api/zero/chat-threads", {
      headers: { authorization: "Bearer clerk-session" },
    });
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

    // Loose-auth path: an authenticated session without an organization gets
    // 404 (not 401) because no compose can belong to the empty org.
    const orgless = bdd.user({ orgId: null });
    const noOrg = await chat.requestCreateThread(
      orgless,
      { agentId: foreignAgent.agentId, title: "no org" },
      [404],
    );
    expectApiError(noOrg.body);
    expect(noOrg.body.error.message).toBe("Agent not found");

    // The foreign agent's thread list is unaffected by the rejected creates.
    const outsiderList = await chat.listThreads(outsider, {
      agentId: foreignAgent.agentId,
    });
    expect(listedThreadIds(outsiderList)).toStrictEqual([]);
  });

  it("falls back to the first run model on detail after the explicit pin is cleared", async () => {
    const { actor, agentId } = await entitledChatActor(
      "Thread detail model pin agent",
    );
    chatCallbacks.proxyChatCallbackToApp();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "pin the first run model",
      modelSelection: {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: "claude-sonnet-4-6",
      },
    });

    let detail = await chat.readThread(actor, run.threadId);
    expect(detail.selectedModel).toBe("claude-sonnet-4-6");
    expect(detail.activeRunIds).toContain(run.runId);

    // Clearing the explicit pin keeps the detail's model: the first run that
    // carried a selected model backfills it, with no provider route.
    await chat.updateThreadModelSelection(actor, run.threadId, null);
    detail = await chat.readThread(actor, run.threadId);
    expect(detail.selectedModel).toBe("claude-sonnet-4-6");
    expect(detail.modelProviderId).toBeNull();
    expect(detail.modelProviderType).toBeNull();
    expect(detail.modelProviderCredentialScope).toBeNull();

    const invalidSelection = await chat.requestUpdateThreadModelSelection(
      actor,
      run.threadId,
      {
        modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
        selectedModel: "not-a-supported-model",
      },
      [400],
    );
    expectApiError(invalidSelection.body);
    expect(invalidSelection.body.error.code).toBe("BAD_REQUEST");

    await cancelChatRun(actor, run.runId);
    detail = await chat.readThread(actor, run.threadId);
    expect(detail.activeRunIds).toStrictEqual([]);
  }, 90_000);

  it("cancels in-flight runs and cascades schedules when a thread is deleted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Thread delete cascade agent",
    );
    chatCallbacks.proxyChatCallbackToApp();
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

    // Main thread: claimed (running) run plus a linked schedule.
    const main = await sendChatRun(actor, {
      agentId,
      prompt: "delete cascade anchor",
    });
    await claimChatRun(runnerGroup, main.runId);
    const scheduleName = uniqueAutomationName("bdd-thread-linked");
    await api.deployAutomation(actor, {
      name: scheduleName,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "linked schedule prompt",
      agentId,
      chatThreadId: main.threadId,
    });

    let list = await chat.listThreads(actor, { agentId });
    const mainListed = list.threads.find((thread) => {
      return thread.id === main.threadId;
    });
    expect(mainListed).toMatchObject({ running: true });

    // A sibling thread whose run completes: terminal transition bumps the
    // thread's recency, and the running flag drops.
    const sibling = await sendChatRun(actor, {
      agentId,
      prompt: "sibling thread completes",
    });
    const siblingClaim = await claimChatRun(runnerGroup, sibling.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(sibling.runId, siblingClaim.sandboxHeaders);

    list = await chat.listThreads(actor, { agentId });
    expect(
      list.threads.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([sibling.threadId, main.threadId]);
    expect(list.threads[0]).toMatchObject({ running: false });

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
    await expect(chat.readThread(actor, main.threadId)).resolves.toMatchObject({
      id: main.threadId,
    });

    const schedulesBefore = await api.listAutomations(actor);
    expect(
      schedulesBefore.automations.some((schedule) => {
        return schedule.name === scheduleName;
      }),
    ).toBeTruthy();

    const deleted = await chat.requestDeleteThread(actor, main.threadId, [204]);
    expect(deleted.body).toBeUndefined();

    expect((await api.readRun(actor, main.runId)).status).toBe("cancelled");
    expect((await api.readRun(actor, sibling.runId)).status).toBe("completed");
    expect((await api.readRun(actor, other.runId)).status).toBe("pending");

    const goneRead = await chat.requestReadThread(actor, main.threadId, [404]);
    expectApiError(goneRead.body);
    list = await chat.listThreads(actor, { agentId });
    expect(listedThreadIds(list)).not.toContain(main.threadId);

    const schedulesAfter = await api.listAutomations(actor);
    expect(
      schedulesAfter.automations.some((schedule) => {
        return schedule.name === scheduleName;
      }),
    ).toBeFalsy();

    await cancelChatRun(actor, other.runId);
  }, 120_000);
});

describe("CHAT-01 chat thread list pagination and read state", () => {
  it("rejects unauthenticated list requests and yields empty lists for unknown agent scopes", async () => {
    const unauthenticated = await chat.requestListThreads(null, {}, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const orgless = await chat.requestListThreads(
      bdd.user({ orgId: null }),
      {},
      [401],
    );
    expectApiError(orgless.body);
    expect(orgless.body.error.code).toBe("UNAUTHORIZED");

    // An unknown agent scope is not an error: the list query scopes by
    // org + agent compose id, so it simply yields an empty list.
    const unknownAgent = await chat.listThreads(bdd.user(), {
      agentId: randomUUID(),
    });
    expect(unknownAgent).toStrictEqual({
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("pages, orders, and flags threads through the chat thread list", async () => {
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(owner, {
      displayName: "List flags agent",
    });
    const otherAgent = await bdd.createAgent(owner, {
      displayName: "List scope agent",
    });

    const empty = await chat.listThreads(owner, { agentId: agent.agentId });
    expect(empty).toStrictEqual({
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
    });

    // Read state lives in the unreads endpoint: a no-credit message makes
    // the thread unread, mark-read stores the latest visible message id and
    // returns the agent's fresh (now empty) unread snapshot.
    const readStateThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: "unread until marked",
    });
    const list = await chat.listThreads(owner, { agentId: agent.agentId });
    expect(list.threads[0]).toMatchObject({
      id: readStateThreadId,
      running: false,
      pinnedAt: null,
      renamedAt: null,
    });
    expect(list.threads[0]?.agent).toStrictEqual({
      id: agent.agentId,
      avatarUrl: null,
    });
    expect(list.threads[0]?.createdAt).toStrictEqual(expect.any(String));
    expect(list.threads[0]?.updatedAt).toStrictEqual(expect.any(String));
    await expect(
      chat.listThreadUnreads(owner, agent.agentId),
    ).resolves.toStrictEqual([
      { threadId: readStateThreadId, unreadAt: expect.any(String) },
    ]);

    const page = await chat.listThreadMessages(owner, readStateThreadId);
    const latestAssistant = assistantMessages(page.messages).at(-1);
    if (!latestAssistant) {
      throw new Error("Expected the no-credit send to write an assistant row");
    }
    const marked = await chat.markThreadRead(owner, readStateThreadId);
    expect(marked).toStrictEqual({
      lastReadMessageId: latestAssistant.id,
      unreads: [],
    });
    const markedAgain = await chat.markThreadRead(owner, readStateThreadId);
    expect(markedAgain).toStrictEqual({
      lastReadMessageId: latestAssistant.id,
      unreads: [],
    });
    await expect(
      chat.listThreadUnreads(owner, agent.agentId),
    ).resolves.toStrictEqual([]);

    // Draft flags through PATCH surface via the drafts endpoint: text,
    // attachments-only, empty, cleared. Unknown ids are silently absent.
    await chat.patchThread(owner, readStateThreadId, {
      draftContent: "unsent text",
    });
    await expect(
      chat.listThreadDrafts(owner, [readStateThreadId, randomUUID()]),
    ).resolves.toStrictEqual([readStateThreadId]);

    await chat.patchThread(owner, readStateThreadId, {
      draftContent: null,
      draftAttachments: [
        {
          id: randomUUID(),
          url: "https://cdn.vm7.io/artifacts/test/draft/file.png",
          filename: "file.png",
          contentType: "image/png",
          size: 100,
        },
      ],
    });
    await expect(
      chat.listThreadDrafts(owner, [readStateThreadId]),
    ).resolves.toStrictEqual([readStateThreadId]);

    await chat.patchThread(owner, readStateThreadId, {
      draftContent: "",
      draftAttachments: null,
    });
    await expect(
      chat.listThreadDrafts(owner, [readStateThreadId]),
    ).resolves.toStrictEqual([]);

    // Patch guards: unknown thread 404 (visible state untouched), peer 404.
    const patchUnknown = await chat.requestPatchThread(
      owner,
      randomUUID(),
      { draftContent: "hello" },
      [404],
    );
    expectApiError(patchUnknown.body);
    expect(patchUnknown.body.error).toStrictEqual({
      message: "Chat thread not found",
      code: "NOT_FOUND",
    });
    const peer = bdd.user({ orgId: owner.orgId });
    const peerPatch = await chat.requestPatchThread(
      peer,
      readStateThreadId,
      { draftContent: "peer overwrite" },
      [404],
    );
    expectApiError(peerPatch.body);
    expect((await chat.readThread(owner, readStateThreadId)).draftContent).toBe(
      "",
    );
    const patchMalformed = await chat.requestPatchThread(
      owner,
      "not-a-uuid",
      { draftContent: "x" },
      [400],
    );
    expectApiError(patchMalformed.body);

    // Pinned threads form their own segment, scoped by agentId.
    const pinnedThread = await chat.createThread(owner, {
      agentId: otherAgent.agentId,
      title: "Pinned in another agent",
    });
    await chat.pinThread(owner, pinnedThread.id);
    const scoped = await chat.listThreads(owner, { agentId: agent.agentId });
    expect(scoped.pinned).toStrictEqual([]);
    expect(listedThreadIds(scoped)).not.toContain(pinnedThread.id);

    const unified = await chat.listThreads(owner);
    expect(
      unified.pinned.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual([pinnedThread.id]);
    expect(unified.pinned[0]?.pinnedAt).toStrictEqual(expect.any(String));
    expect(listedThreadIds(unified)).toContain(readStateThreadId);

    // Cursor walk over three empty threads scoped to the second agent.
    const cursorThreadIds = [pinnedThread.id];
    for (let index = 0; index < 2; index += 1) {
      const created = await chat.createThread(owner, {
        agentId: otherAgent.agentId,
        title: `Cursor thread ${index}`,
      });
      cursorThreadIds.push(created.id);
    }
    await chat.unpinThread(owner, pinnedThread.id);

    const firstPage = await chat.listThreads(owner, {
      agentId: otherAgent.agentId,
      limit: 2,
    });
    expect(firstPage.threads).toHaveLength(2);
    expect(firstPage.hasMore).toBeTruthy();
    expect(firstPage.nextCursor).not.toBeNull();
    if (!firstPage.nextCursor) {
      throw new Error("Expected a next cursor on the first page");
    }

    const secondPage = await chat.listThreads(owner, {
      agentId: otherAgent.agentId,
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.threads).toHaveLength(1);
    expect(secondPage.hasMore).toBeFalsy();
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.pinned).toStrictEqual([]);
    const walked = [
      ...firstPage.threads.map((thread) => {
        return thread.id;
      }),
      ...secondPage.threads.map((thread) => {
        return thread.id;
      }),
    ];
    expect(new Set(walked)).toStrictEqual(new Set(cursorThreadIds));

    // Invalid cursors fall back to the first page instead of erroring.
    const invalidCursors = [
      "not-base64-json",
      Buffer.from(JSON.stringify({ ts: "x" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ id: "y" }), "utf8").toString("base64url"),
    ];
    for (const cursor of invalidCursors) {
      const fallback = await chat.requestListThreads(
        owner,
        { agentId: otherAgent.agentId, limit: 2, cursor },
        [200],
      );
      if (fallback.status !== 200) {
        throw new Error("Expected the invalid cursor to fall back to page 1");
      }
      expect(
        fallback.body.threads.map((thread) => {
          return thread.id;
        }),
      ).toStrictEqual(
        firstPage.threads.map((thread) => {
          return thread.id;
        }),
      );
      expect(fallback.body.hasMore).toBeTruthy();
    }

    // Peer users and other orgs never see the owner's threads.
    const peerList = await chat.listThreads(peer);
    expect(listedThreadIds(peerList)).toStrictEqual([]);
    const sameUserOtherOrg = bdd.user({ userId: owner.userId });
    const otherOrgList = await chat.listThreads(sameUserOtherOrg);
    expect(listedThreadIds(otherOrgList)).toStrictEqual([]);
  }, 60_000);

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
  it("emits one persisted usage message after completion side effects process run usage", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Usage message agent",
    );
    const provider = `bdd-usage-${randomUUID().slice(0, 8)}`;
    const missingProvider = `${provider}-free`;
    const category = "api_request";
    await store.set(
      seedUsagePricing$,
      { provider, category, unitPrice: 7, unitSize: 2 },
      context.signal,
    );

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

    const usageRows = await store.set(
      usageEventsForRun$,
      runId,
      context.signal,
    );
    expect(usageRows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider,
          category,
          creditsCharged: 18,
          status: "processed",
          billingError: null,
        }),
        expect.objectContaining({
          provider: missingProvider,
          category,
          creditsCharged: 0,
          status: "processed",
          billingError: "missing_pricing",
        }),
      ]),
    );

    const page = await chat.listThreadMessages(actor, threadId);
    const usageMessages = page.messages.filter((message) => {
      return message.runId === runId && message.usage !== undefined;
    });
    expect(usageMessages).toHaveLength(1);
    expect(usageMessages[0]).toMatchObject({
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

    let usageMessageRows = await store.set(
      usageMessagesForRun$,
      runId,
      context.signal,
    );
    expect(usageMessageRows).toHaveLength(1);
    await expect(
      store.set(maybeEmitRunUsageMessage$, runId, context.signal),
    ).resolves.toBeFalsy();
    usageMessageRows = await store.set(
      usageMessagesForRun$,
      runId,
      context.signal,
    );
    expect(usageMessageRows).toHaveLength(1);
  }, 60_000);

  it("emits zero-credit usage messages and suppresses emission while usage is pending", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Zero usage message agent",
    );
    if (!actor.orgId) {
      throw new Error("Expected the chat actor to belong to an organization");
    }

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

    const pendingRun = await sendChatRun(actor, {
      agentId,
      prompt: "hold usage message while pending",
    });
    const { sandboxHeaders: pendingSandboxHeaders } = await claimChatRun(
      runnerGroup,
      pendingRun.runId,
    );
    await completeChatRunOk(pendingRun.runId, pendingSandboxHeaders);
    await flushWaitUntilForTest();
    await store.set(
      insertRunUsageEvent$,
      {
        runId: pendingRun.runId,
        orgId: actor.orgId,
        userId: actor.userId,
        provider: `processed-${randomUUID().slice(0, 8)}`,
        status: "processed",
        creditsCharged: 12,
      },
      context.signal,
    );
    await store.set(
      insertRunUsageEvent$,
      {
        runId: pendingRun.runId,
        orgId: actor.orgId,
        userId: actor.userId,
        provider: `pending-${randomUUID().slice(0, 8)}`,
        status: "pending",
        creditsCharged: null,
      },
      context.signal,
    );

    await expect(
      store.set(maybeEmitRunUsageMessage$, pendingRun.runId, context.signal),
    ).resolves.toBeFalsy();
    await expect(
      store.set(usageMessagesForRun$, pendingRun.runId, context.signal),
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

describe("CHAT-01 github pr tracking", () => {
  it("tracks github pull requests mentioned in a thread", async () => {
    mockGitHubConnectorOAuth();
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "PR tracking agent",
    });
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatGithubPrTracking]: true,
    });

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    await connectorsApi.completeOauthCallback("github", {
      code: "chat-prs",
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    await api.enableAgentConnectors(actor, agent.agentId, ["github"]);

    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "PR tracking thread",
    });
    const noRefs = await chat.requestThreadGithubPrs(actor, thread.id, [200]);
    if (noRefs.status !== 200) {
      throw new Error("Expected an empty PR list for a thread without URLs");
    }
    expect(noRefs.body.prs).toStrictEqual([]);

    await sendNoCreditMessage(actor, {
      agentId: agent.agentId,
      threadId: thread.id,
      prompt:
        "Opened https://github.com/vm0-ai/vm0/pull/15070 and https://github.com/vm0-ai/vm0/pull/15071 for review.",
    });
    await sendNoCreditMessage(actor, {
      agentId: agent.agentId,
      threadId: thread.id,
      prompt:
        "Also https://github.com/vm0-ai/vm0/pull/15072 plus a repeat of https://github.com/vm0-ai/vm0/pull/15070.",
    });

    const shaByNumber: Record<string, string> = {
      "15070": "sha-ready",
      "15071": "sha-conflict",
      "15072": "sha-pending",
    };
    const observedAuthorizations: (string | null)[] = [];
    server.use(
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/pulls/:number",
        ({ params, request }) => {
          observedAuthorizations.push(request.headers.get("authorization"));
          const number = String(params.number);
          const sha = shaByNumber[number];
          if (!sha) {
            return HttpResponse.json({ message: "Not Found" }, { status: 404 });
          }
          return HttpResponse.json({
            title: `BDD PR ${number}`,
            html_url: `https://github.com/vm0-ai/vm0/pull/${number}`,
            state: "open",
            merged_at: null,
            draft: false,
            mergeable: number !== "15071",
            mergeable_state: number === "15071" ? "dirty" : "clean",
            head: { sha },
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/:sha/check-runs",
        ({ params }) => {
          if (params.sha !== "sha-ready") {
            return HttpResponse.json({ check_runs: [] });
          }
          return HttpResponse.json({
            check_runs: [
              {
                name: "CI",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/vm0-ai/vm0/actions/runs/1",
                started_at: "2026-06-02T00:00:00Z",
                completed_at: "2026-06-02T00:01:00Z",
              },
            ],
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/:sha/status",
        ({ params }) => {
          return HttpResponse.json({
            state: params.sha === "sha-pending" ? "pending" : "success",
            statuses: [],
          });
        },
      ),
    );

    const tracked = await chat.requestThreadGithubPrs(actor, thread.id, [200]);
    if (tracked.status !== 200) {
      throw new Error("Expected tracked PR statuses");
    }
    expect(tracked.body.prs).toHaveLength(3);
    expect(observedAuthorizations).toContain("Bearer github-access-chat-prs");

    const byNumber = new Map(
      tracked.body.prs.map((pr) => {
        return [pr.number, pr] as const;
      }),
    );
    expect(byNumber.get(15_070)).toMatchObject({
      repo: "vm0-ai/vm0",
      title: "BDD PR 15070",
      state: "open",
      headSha: "sha-ready",
      mergeStatus: "ready",
      rollup: "success",
      checks: [
        {
          name: "CI",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/vm0-ai/vm0/actions/runs/1",
          startedAt: "2026-06-02T00:00:00Z",
          completedAt: "2026-06-02T00:01:00Z",
        },
      ],
    });
    expect(byNumber.get(15_071)).toMatchObject({
      mergeStatus: "conflicts",
      rollup: "none",
      checks: [],
    });
    expect(byNumber.get(15_072)).toMatchObject({
      mergeStatus: null,
      rollup: "pending",
      checks: [
        {
          name: "GitHub status",
          status: "in_progress",
          conclusion: null,
          url: "https://github.com/vm0-ai/vm0/pull/15072",
          startedAt: null,
          completedAt: null,
        },
      ],
    });
  }, 60_000);

  it("gates pr tracking behind feature, authorization, connection, and ownership", async () => {
    const actor = bdd.user();
    const peer = bdd.user({ orgId: actor.orgId });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "PR gating agent",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "PR gating thread",
    });

    const unauthenticated = await chat.requestThreadGithubPrs(
      null,
      randomUUID(),
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const featureOff = await chat.requestThreadGithubPrs(
      actor,
      thread.id,
      [403],
    );
    expectApiError(featureOff.body);
    expect(featureOff.body.error.message).toBe(
      "GitHub PR tracking is not enabled",
    );

    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatGithubPrTracking]: true,
    });
    const unauthorizedAgent = await chat.requestThreadGithubPrs(
      actor,
      thread.id,
      [403],
    );
    expectApiError(unauthorizedAgent.body);
    expect(unauthorizedAgent.body.error.message).toBe(
      "GitHub connector is not authorized for this agent",
    );

    // Authorized for the agent but never connected.
    mockGitHubConnectorOAuth();
    await api.enableAgentConnectors(actor, agent.agentId, ["github"]);
    const notConnected = await chat.requestThreadGithubPrs(
      actor,
      thread.id,
      [403],
    );
    expectApiError(notConnected.body);
    expect(notConnected.body.error.message).toBe(
      "GitHub connector is not connected",
    );

    const malformed = await chat.requestThreadGithubPrs(
      actor,
      "not-a-uuid",
      [404],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.message).toBe("Chat thread not found");

    const unknown = await chat.requestThreadGithubPrs(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(unknown.body);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    await connectorsApi.updateFeatureSwitches(peer, {
      [FeatureSwitchKey.ChatGithubPrTracking]: true,
    });
    const crossUser = await chat.requestThreadGithubPrs(peer, thread.id, [404]);
    expectApiError(crossUser.body);
    expect(crossUser.body.error.message).toBe("Chat thread not found");
  }, 30_000);
});

describe("CHAT-03 thread artifacts and google drive status", () => {
  it("groups run uploads and reports google drive sync status", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor(
      "Artifacts drive status agent",
    );
    chatCallbacks.proxyChatCallbackToApp();
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
    chatCallbacks.proxyChatCallbackToApp();
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
    chatCallbacks.proxyChatCallbackToApp();
    authOrg.mockClerkOrg(actor);
    const key = await authOrg.createApiKey(actor, {
      name: "bdd-v1-send",
      expiresInDays: 30,
    });
    const bearer = `Bearer ${key.token}`;
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
    await cancelChatRun(actor, promoted.runId);

    // Custom skills registered through the skills API mount into the claim
    // as additional volumes. (The storage-missing fallback at dispatch is
    // not API-constructible: skill create uploads the volume server-side and
    // skill delete clears agent references in the same transaction.)
    const skillName = `bdd-skill-${randomUUID().slice(0, 12)}`;
    await accept(
      setupApp({ context })(zeroSkillsCollectionContract).create({
        headers: sessionHeaders(actor),
        body: {
          name: skillName,
          files: [{ path: "SKILL.md", content: "# bdd skill" }],
        },
      }),
      [201],
    );
    await bdd.updateAgent(actor, agentId, { customSkills: [skillName] });

    const skillSend = await chat.requestV1Send(
      bearer,
      { prompt: "use the bdd skill", threadId: thread.id },
      [201],
    );
    if (skillSend.status !== 201 || skillSend.body.runId === null) {
      throw new Error("Expected the skill-mounting v1 send to create a run");
    }
    const run4Id = skillSend.body.runId;
    const claim4 = await claimChatRun(runnerGroup, run4Id);
    expect(claim4.claim.storageManifest?.storages).toContainEqual(
      expect.objectContaining({
        name: `custom-skill@${skillName}`,
        mountPath: `/home/user/.claude/skills/${skillName}`,
      }),
    );
    await cancelChatRun(actor, run4Id);

    // Deleting the skill removes the mount from the next run's claim.
    await accept(
      setupApp({ context })(zeroSkillsDetailContract).delete({
        headers: sessionHeaders(actor),
        params: { name: skillName },
      }),
      [204],
    );
    const afterDelete = await chat.requestV1Send(
      bearer,
      { prompt: "after the skill is deleted", threadId: thread.id },
      [201],
    );
    if (afterDelete.status !== 201 || afterDelete.body.runId === null) {
      throw new Error("Expected the post-delete v1 send to create a run");
    }
    const claim5 = await claimChatRun(runnerGroup, afterDelete.body.runId);
    expect(JSON.stringify(claim5.claim)).not.toContain(
      `custom-skill@${skillName}`,
    );
    await cancelChatRun(actor, afterDelete.body.runId);
  }, 180_000);
});
