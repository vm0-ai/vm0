import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { WebPushError } from "web-push";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  chatMessages,
  type ChatMessageGenerationTemplate,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { pushSubscriptions } from "@vm0/db/schema/push-subscription";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_ITEMS } from "@vm0/core";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

const PATH = "/api/internal/callbacks/chat";
const TEST_CALLBACK_SECRET = "test-callback-secret";
const ORG_SENTINEL_USER_ID = "__org__";

interface ChatCallbackFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly versionId: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly callbackId: string;
}

const track = createFixtureTracker<ChatCallbackFixture>(deleteFixture);

function vm0Template(expression: string): string {
  return `$${expression}`;
}

async function seedChatCallbackFixture(): Promise<ChatCallbackFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const name = `agent-${agentId.slice(0, 8)}`;
  const db = store.set(writeDb$);

  await db.insert(agentComposes).values({
    id: agentId,
    userId,
    orgId,
    name,
    headVersionId: versionId,
  });
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: agentId,
    createdBy: userId,
    content: {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: {
            ANTHROPIC_API_KEY: "test-key",
            ZERO_AGENT_ID: vm0Template("{{ vars.ZERO_AGENT_ID }}"),
            ZERO_TOKEN: vm0Template("{{ secrets.ZERO_TOKEN }}"),
          },
        },
      },
    },
  });
  await db.insert(zeroAgents).values({
    id: agentId,
    orgId,
    owner: userId,
    name,
    visibility: "public",
  });
  await db.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits: 10_000,
  });
  await db.insert(chatThreads).values({
    id: threadId,
    userId,
    agentComposeId: agentId,
    title: "Test thread",
  });
  await db.insert(agentSessions).values({
    id: sessionId,
    userId,
    orgId,
    agentComposeId: agentId,
  });
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      sessionId,
      status: "completed",
      prompt: "test prompt",
      completedAt: new Date("2026-01-01T00:00:10.000Z"),
      lastEventSequence: 1,
      vars: { ZERO_AGENT_ID: agentId },
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("run insert returned no row");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "web",
    chatThreadId: threadId,
  });
  await db.insert(chatMessages).values({
    chatThreadId: threadId,
    role: "user",
    content: "test prompt",
    runId: run.id,
  });

  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId: run.id,
      url: `http://localhost${PATH}`,
      payload: { threadId, agentId },
    },
    context.signal,
  );

  context.mocks.s3.send.mockResolvedValue({});
  mockEnv("VM0_API_URL", "http://localhost:3000");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockOptionalEnv("VAPID_PUBLIC_KEY", undefined);
  mockOptionalEnv("VAPID_PRIVATE_KEY", undefined);

  return {
    userId,
    orgId,
    agentId,
    versionId,
    sessionId,
    threadId,
    runId: run.id,
    callbackId,
  };
}

async function deleteFixture(fixture: ChatCallbackFixture): Promise<void> {
  const db = store.set(writeDb$);
  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    );
  const runIds = runRows.map((row) => {
    return row.id;
  });

  if (runIds.length > 0) {
    await db
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    await db
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
  }
  await db
    .delete(chatMessages)
    .where(eq(chatMessages.chatThreadId, fixture.threadId));
  if (runIds.length > 0) {
    await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  await db
    .delete(agentSessions)
    .where(eq(agentSessions.userId, fixture.userId));
  await db.delete(chatThreads).where(eq(chatThreads.id, fixture.threadId));
  await db
    .delete(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, fixture.orgId));
  await db
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  await db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, fixture.userId));
  await db
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await db.delete(zeroAgents).where(eq(zeroAgents.id, fixture.agentId));
  await db
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.agentId));
  await db.delete(agentComposes).where(eq(agentComposes.id, fixture.agentId));
}

function signedHeaders(rawBody: string, secret = TEST_CALLBACK_SECRET) {
  const timestamp = Math.floor(now() / 1000);
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, timestamp),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postSignedCallback(
  body: Record<string, unknown>,
  secret?: string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return await app.request(PATH, {
    method: "POST",
    headers: signedHeaders(rawBody, secret),
    body: rawBody,
  });
}

function completedAssistantOutput(text: string): void {
  context.mocks.axiom.query
    .mockResolvedValueOnce([{ sequenceNumber: 0 }, { sequenceNumber: 1 }])
    .mockResolvedValueOnce([
      {
        eventType: "assistant",
        sequenceNumber: 1,
        eventData: {
          message: { content: [{ type: "text", text }] },
        },
      },
    ]);
}

function completedOutputEvents(
  events: readonly Record<string, unknown>[],
): void {
  context.mocks.axiom.query
    .mockResolvedValueOnce([{ sequenceNumber: 0 }, { sequenceNumber: 1 }])
    .mockResolvedValueOnce(events);
}

function completedNoOutputEvents(): void {
  completedOutputEvents([]);
}

async function listMessages(threadId: string) {
  return await store
    .set(writeDb$)
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));
}

async function readThreadLastMessageAt(threadId: string): Promise<Date> {
  const [thread] = await store
    .set(writeDb$)
    .select({ lastMessageAt: chatThreads.lastMessageAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  if (!thread) {
    throw new Error("thread row missing");
  }
  return thread.lastMessageAt;
}

async function seedAdditionalRun(
  fixture: ChatCallbackFixture,
  args: {
    readonly prompt?: string;
    readonly status?: string;
    readonly createdAt?: Date;
    readonly completedAt?: Date | null;
    readonly error?: string | null;
    readonly result?: unknown;
    readonly lastEventSequence?: number | null;
  } = {},
): Promise<{ readonly runId: string; readonly callbackId: string }> {
  const db = store.set(writeDb$);
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeVersionId: fixture.versionId,
      sessionId: fixture.sessionId,
      status: args.status ?? "completed",
      prompt: args.prompt ?? "follow-up prompt",
      completedAt: args.completedAt ?? new Date("2026-01-01T00:01:10.000Z"),
      lastEventSequence: args.lastEventSequence ?? 1,
      result: args.result,
      error: args.error,
      vars: { ZERO_AGENT_ID: fixture.agentId },
      createdAt: args.createdAt,
    })
    .returning({ id: agentRuns.id });
  if (!run) {
    throw new Error("additional run insert returned no row");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "web",
    chatThreadId: fixture.threadId,
  });
  await db.insert(chatMessages).values({
    chatThreadId: fixture.threadId,
    role: "user",
    content: args.prompt ?? "follow-up prompt",
    runId: run.id,
  });
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId: run.id,
      url: `http://localhost${PATH}`,
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    },
    context.signal,
  );
  return { runId: run.id, callbackId };
}

async function setRunResult(runId: string, result: unknown): Promise<void> {
  await store
    .set(writeDb$)
    .update(agentRuns)
    .set({ result })
    .where(eq(agentRuns.id, runId));
}

async function setRunStatus(
  runId: string,
  status: string,
  error?: string,
): Promise<void> {
  await store
    .set(writeDb$)
    .update(agentRuns)
    .set({ status, error })
    .where(eq(agentRuns.id, runId));
}

async function insertAssistantEventMessages(
  fixture: ChatCallbackFixture,
  runId: string,
  items: readonly {
    readonly sequenceNumber: number;
    readonly content: string;
  }[],
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  await store
    .set(writeDb$)
    .insert(chatMessages)
    .values(
      items.map((item) => {
        return {
          chatThreadId: fixture.threadId,
          role: "assistant",
          content: item.content,
          runId,
          sequenceNumber: item.sequenceNumber,
        };
      }),
    );
}

async function insertQueuedMessage(
  fixture: ChatCallbackFixture,
  args: {
    readonly content: string | null;
    readonly attachFiles?: readonly string[];
    readonly interruptsRunId?: string;
    readonly generationTemplate?: ChatMessageGenerationTemplate;
  },
): Promise<string> {
  const [message] = await store
    .set(writeDb$)
    .insert(chatMessages)
    .values({
      chatThreadId: fixture.threadId,
      role: "user",
      content: args.content,
      runId: null,
      attachFiles: args.attachFiles ? [...args.attachFiles] : null,
      interruptsRunId: args.interruptsRunId,
      generationTemplate: args.generationTemplate,
    })
    .returning({ id: chatMessages.id });
  if (!message) {
    throw new Error("queued message insert returned no row");
  }
  return message.id;
}

async function seedOrgDefaultModelProvider(
  fixture: ChatCallbackFixture,
): Promise<{
  readonly providerId: string;
  readonly selectedModel: string;
}> {
  const db = store.set(writeDb$);
  const selectedModel = "claude-sonnet-4-6";
  const [secret] = await db
    .insert(secrets)
    .values({
      name: "ANTHROPIC_API_KEY",
      encryptedValue: encryptSecretForTests("queued-byok-key"),
      type: "model-provider",
      userId: ORG_SENTINEL_USER_ID,
      orgId: fixture.orgId,
    })
    .returning({ id: secrets.id });
  const [provider] = await db
    .insert(modelProviders)
    .values({
      type: "anthropic-api-key",
      secretId: secret!.id,
      isDefault: false,
      selectedModel,
      userId: ORG_SENTINEL_USER_ID,
      orgId: fixture.orgId,
    })
    .returning({ id: modelProviders.id });
  await db.insert(orgModelPolicies).values({
    orgId: fixture.orgId,
    model: selectedModel,
    isDefault: true,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: provider!.id,
    createdByUserId: fixture.userId,
    updatedByUserId: fixture.userId,
  });
  await db
    .update(chatThreads)
    .set({
      modelProviderId: "00000000-0000-4000-8000-000000000000",
      modelProviderType: "vm0",
      modelProviderCredentialScope: "org",
      selectedModel,
    })
    .where(eq(chatThreads.id, fixture.threadId));
  return { providerId: provider!.id, selectedModel };
}

async function createPushSubscription(
  fixture: ChatCallbackFixture,
): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await store.set(writeDb$).insert(pushSubscriptions).values({
    userId: fixture.userId,
    endpoint,
    p256dh: "test-p256dh",
    auth: "test-auth",
  });
  return endpoint;
}

async function listPushSubscriptions(userId: string) {
  return await store
    .set(writeDb$)
    .select({ endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(pushSubscriptions.endpoint);
}

function enableVapid(): void {
  mockOptionalEnv("VAPID_PUBLIC_KEY", "test-vapid-public-key");
  mockOptionalEnv("VAPID_PRIVATE_KEY", "test-vapid-private-key");
}

function mockOpenRouter(
  handler: (body: {
    readonly messages: readonly {
      readonly role: string;
      readonly content: string;
    }[];
  }) => string,
): void {
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        const body = (await request.json()) as {
          messages: readonly {
            readonly role: string;
            readonly content: string;
          }[];
        };
        return HttpResponse.json({
          choices: [{ message: { content: handler(body) } }],
        });
      },
    ),
  );
}

async function enableRecommendedFollowups(
  fixture: ChatCallbackFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(userFeatureSwitches)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.ChatRecommendedFollowups]: true },
    });
}

describe("POST /api/internal/callbacks/chat", () => {
  it("returns 200 for progress status without querying Axiom", async () => {
    const fixture = await track(seedChatCallbackFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid callback payloads", async () => {
    const fixture = await track(seedChatCallbackFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("returns success without side effects when the run has no chat thread mapping", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await store
      .set(writeDb$)
      .update(zeroRuns)
      .set({ chatThreadId: null })
      .where(eq(zeroRuns.id, fixture.runId));

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      expect.stringMatching(/^chatThreadRunUpdated:/),
      null,
    );
  });

  it("returns success without side effects after the chat thread was deleted", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await store
      .set(writeDb$)
      .delete(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Agent crashed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("inserts assistant output on completed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedAssistantOutput("final answer");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const messages = await listMessages(fixture.threadId);
    expect(
      messages.some((message) => {
        return (
          message.role === "assistant" &&
          message.runId === fixture.runId &&
          message.sequenceNumber === 1 &&
          message.content === "final answer"
        );
      }),
    ).toBeTruthy();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    await clearAllDetached();
  });

  it("advances last_message_at to run-end time on completed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedAssistantOutput("final answer");

    // The sidebar orders threads by last_message_at, and it must advance only
    // when a run reaches a terminal state — not when the user message was first
    // inserted or while the assistant streams. Backdate the column and a raw
    // streamed assistant event so the run-end bump is the only thing that can
    // move it forward.
    const stale = new Date("2020-01-01T00:00:00.000Z");
    await store
      .set(writeDb$)
      .update(chatThreads)
      .set({ lastMessageAt: stale })
      .where(eq(chatThreads.id, fixture.threadId));
    await insertAssistantEventMessages(fixture, fixture.runId, [
      { sequenceNumber: 0, content: "streaming chunk" },
    ]);

    const [beforeThread] = await store
      .set(writeDb$)
      .select({ lastMessageAt: chatThreads.lastMessageAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    if (!beforeThread) {
      throw new Error("thread row missing before callback");
    }
    expect(beforeThread.lastMessageAt.getTime()).toBe(stale.getTime());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });
    expect(response.status).toBe(200);

    const [afterThread] = await store
      .set(writeDb$)
      .select({ lastMessageAt: chatThreads.lastMessageAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId));
    if (!afterThread) {
      throw new Error("thread row missing after callback");
    }
    expect(afterThread.lastMessageAt.getTime()).toBeGreaterThan(
      stale.getTime(),
    );
    await clearAllDetached();
  });

  it("persists recommended follow-ups as an immutable assistant message when enabled", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await enableRecommendedFollowups(fixture);
    completedAssistantOutput("final answer");
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    mockOpenRouter((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        return "Completed Thread";
      }
      if (
        systemContent.includes("Generate up to three concise follow-up prompts")
      ) {
        expect(systemContent).toContain(
          "Make each prompt specific to the latest assistant reply",
        );
        return JSON.stringify([
          {
            prompt: "Turn this into a checklist",
            kind: "talk",
          },
          {
            prompt: "Generate a landing page for this plan",
            kind: "generate",
            generationType: "website",
          },
        ]);
      }
      return "Generated summary";
    });

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    const marker = messages.find((message) => {
      return (
        message.role === "assistant" &&
        message.runId === fixture.runId &&
        message.runLifecycleEvent === "completed"
      );
    });
    const recommender = messages.find((message) => {
      return (
        message.role === "assistant" &&
        message.runId === fixture.runId &&
        message.runLifecycleEvent === null &&
        (message.recommendedFollowups?.length ?? 0) > 0
      );
    });
    expect(marker?.recommendedFollowups).toBeNull();
    expect(recommender?.content).toBeNull();
    expect(recommender?.createdAt.getTime()).toBeGreaterThan(
      marker?.createdAt.getTime() ?? 0,
    );
    expect(recommender?.recommendedFollowups).toStrictEqual([
      {
        prompt: "Turn this into a checklist",
        kind: "talk",
      },
      {
        prompt: "Generate a landing page for this plan",
        kind: "generate",
        generationType: "website",
      },
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    await clearAllDetached();
  });

  it("uses the run's database thread mapping when the payload thread is stale", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedAssistantOutput("mapped thread answer");
    const staleThreadId = randomUUID();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: staleThreadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    expect(
      messages.some((message) => {
        return (
          message.role === "assistant" &&
          message.content === "mapped thread answer"
        );
      }),
    ).toBeTruthy();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    await clearAllDetached();
  });

  it("inserts the latest result event when no assistant event exists", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "result",
        sequenceNumber: 0,
        eventData: { result: "draft answer" },
      },
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "final fallback answer" },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    const assistantMessages = messages.filter((message) => {
      return message.role === "assistant" && message.content !== null;
    });
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      runId: fixture.runId,
      sequenceNumber: 1,
      content: "final fallback answer",
    });
    await clearAllDetached();
  });

  it("inserts Codex agent_message item.completed events", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "item.completed",
        sequenceNumber: 1,
        eventData: {
          item: { type: "agent_message", text: "Codex answer" },
        },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    expect(
      messages.some((message) => {
        return (
          message.role === "assistant" &&
          message.sequenceNumber === 1 &&
          message.content === "Codex answer"
        );
      }),
    ).toBeTruthy();
    await clearAllDetached();
  });

  it("ignores non-agent_message item.completed events", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "item.completed",
        sequenceNumber: 1,
        eventData: {
          item: { type: "tool_call", text: "internal tool text" },
        },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    expect(
      messages.filter((message) => {
        return message.role === "assistant" && message.content !== null;
      }),
    ).toHaveLength(0);
    await clearAllDetached();
  });

  it("uses eventData.sequenceNumber for result fallback events", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "result",
        eventData: { sequenceNumber: 1, result: "sequence from eventData" },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    expect(
      messages.find((message) => {
        return message.role === "assistant";
      }),
    ).toMatchObject({
      sequenceNumber: 1,
      content: "sequence from eventData",
    });
    await clearAllDetached();
  });

  it("uses result fallback when Axiom also has blank assistant text", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "assistant",
        sequenceNumber: 0,
        eventData: {
          message: { content: [{ type: "text", text: "" }] },
        },
      },
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "RESULT=579" },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const assistantMessages = (await listMessages(fixture.threadId)).filter(
      (message) => {
        return message.role === "assistant" && message.sequenceNumber !== null;
      },
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      sequenceNumber: 1,
      content: "RESULT=579",
    });
    await clearAllDetached();
  });

  it("uses result fallback when existing streamed assistant output is blank", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await insertAssistantEventMessages(fixture, fixture.runId, [
      { sequenceNumber: 0, content: "\n\t" },
    ]);
    completedOutputEvents([
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "Recovered result" },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const assistantMessages = (await listMessages(fixture.threadId)).filter(
      (message) => {
        return message.role === "assistant" && message.sequenceNumber !== null;
      },
    );
    expect(
      assistantMessages.map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["\n\t", "Recovered result"]);
    await clearAllDetached();
  });

  it("does not insert a result fallback when assistant output already exists", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await insertAssistantEventMessages(fixture, fixture.runId, [
      { sequenceNumber: 0, content: "Already streamed." },
    ]);
    completedOutputEvents([
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "Unknown command: /aaa" },
      },
    ]);

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const assistantMessages = (await listMessages(fixture.threadId)).filter(
      (message) => {
        return message.role === "assistant" && message.content !== null;
      },
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.content).toBe("Already streamed.");
    await clearAllDetached();
  });

  it("deduplicates assistant events across concurrent completed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    context.mocks.axiom.query.mockResolvedValue([
      {
        eventType: "assistant",
        sequenceNumber: 0,
        eventData: {
          message: { content: [{ type: "text", text: "First event" }] },
        },
      },
      {
        eventType: "assistant",
        sequenceNumber: 1,
        eventData: {
          message: { content: [{ type: "text", text: "Second event" }] },
        },
      },
    ]);

    const makeRequest = () => {
      return postSignedCallback({
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: { threadId: fixture.threadId, agentId: fixture.agentId },
      });
    };
    const [first, second] = await Promise.all([makeRequest(), makeRequest()]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const eventMessages = (await listMessages(fixture.threadId)).filter(
      (message) => {
        return message.role === "assistant" && message.sequenceNumber !== null;
      },
    );
    expect(
      eventMessages.map((message) => {
        return message.content;
      }),
    ).toStrictEqual(["First event", "Second event"]);
    await clearAllDetached();
  });

  it("does not insert assistant output when Axiom has no assistant or result events", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedNoOutputEvents();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const messages = await listMessages(fixture.threadId);
    expect(
      messages.filter((message) => {
        return message.role === "assistant" && message.content !== null;
      }),
    ).toHaveLength(0);
    await clearAllDetached();
  });

  it("inserts assistant error messages on failed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Cannot continue session from checkpoint",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const messages = await listMessages(fixture.threadId);
    expect(
      messages.some((message) => {
        return (
          message.role === "assistant" &&
          message.runId === fixture.runId &&
          message.error === "Cannot continue session from checkpoint"
        );
      }),
    ).toBeTruthy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("shows a report link after consecutive generic failed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await setRunStatus(fixture.runId, "failed", "First runner failure");
    await store
      .set(writeDb$)
      .update(agentRuns)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(agentRuns.id, fixture.runId));

    const first = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "First runner failure",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });
    expect(first.status).toBe(200);

    const secondRun = await seedAdditionalRun(fixture, {
      prompt: "try again",
      status: "failed",
      error: "Second runner failure",
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      completedAt: new Date("2026-01-01T00:01:10.000Z"),
    });
    const second = await postSignedCallback({
      callbackId: secondRun.callbackId,
      runId: secondRun.runId,
      status: "failed",
      error: "Second runner failure",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(second.status).toBe(200);
    const errorMessages = (await listMessages(fixture.threadId)).filter(
      (message) => {
        return message.role === "assistant" && message.error !== null;
      },
    );
    expect(errorMessages).toHaveLength(2);
    expect(errorMessages[0]?.error).toBe(
      "Oops, something went wrong. Please try again later.",
    );
    expect(errorMessages[1]?.error).toBe(
      `An unexpected error occurred. [Report this issue](/runs/${secondRun.runId}/report-error)`,
    );
  });

  it("preserves actionable failed run errors", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const actionableError =
      "No model provider configured. Run 'zero org model-provider setup' to configure one, or add environment variables to your vm0.yaml.";

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: actionableError,
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const errorMessage = (await listMessages(fixture.threadId)).find(
      (message) => {
        return message.role === "assistant" && message.runId === fixture.runId;
      },
    );
    expect(errorMessage?.error).toBe(actionableError);
    expect(errorMessage?.content).toBe(actionableError);
  });

  it("preserves non-Codex usage limit errors on failed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const usageLimitError =
      "Claude usage limit reached. Visit https://claude.ai/settings/usage or try again at 6:17 AM.";

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: usageLimitError,
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const messages = await listMessages(fixture.threadId);
    const errorMessage = messages.find((message) => {
      return message.role === "assistant" && message.runId === fixture.runId;
    });
    expect(errorMessage?.error).toBe(usageLimitError);
    expect(errorMessage?.content).toBe(usageLimitError);
    expect(errorMessage?.error).not.toBe(
      "Oops, something went wrong. Please try again later.",
    );
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("shows Codex usage limit errors verbatim on failed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const codexUsageLimitError =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:17 AM.";

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: codexUsageLimitError,
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const messages = await listMessages(fixture.threadId);
    const errorMessage = messages.find((message) => {
      return message.role === "assistant" && message.runId === fixture.runId;
    });
    expect(errorMessage?.error).toBe(codexUsageLimitError);
    expect(errorMessage?.content).toBe(codexUsageLimitError);
    expect(errorMessage?.error).not.toContain("switch to another model");
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("shows Claude session limit errors verbatim on failed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const sessionLimitError =
      "You've hit your session limit · resets 12:50pm (Asia/Shanghai)";

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: sessionLimitError,
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const messages = await listMessages(fixture.threadId);
    const errorMessage = messages.find((message) => {
      return message.role === "assistant" && message.runId === fixture.runId;
    });
    expect(errorMessage?.error).toBe(sessionLimitError);
    expect(errorMessage?.content).toBe(sessionLimitError);
    expect(errorMessage?.error).not.toBe(
      "Oops, something went wrong. Please try again later.",
    );
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("preserves user-cancelled failed run errors", async () => {
    const fixture = await track(seedChatCallbackFixture());

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Run cancelled",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const errorMessage = (await listMessages(fixture.threadId)).find(
      (message) => {
        return message.role === "assistant" && message.runId === fixture.runId;
      },
    );
    expect(errorMessage?.error).toBe("Run cancelled");
    expect(errorMessage?.content).toBe("Run cancelled");
  });

  it.each([
    {
      scenario: "failed",
      error: "Cannot continue session from checkpoint",
      lifecycleEvent: "failed",
    },
    {
      scenario: "cancelled",
      error: "Run cancelled",
      lifecycleEvent: "cancelled",
    },
  ] as const)(
    "does not advance last_message_at when $scenario callbacks are replayed",
    async ({ error, lifecycleEvent }) => {
      const fixture = await track(seedChatCallbackFixture());

      const first = await postSignedCallback({
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "failed",
        error,
        payload: { threadId: fixture.threadId, agentId: fixture.agentId },
      });
      expect(first.status).toBe(200);

      const stale = new Date("2020-01-01T00:00:00.000Z");
      await store
        .set(writeDb$)
        .update(chatThreads)
        .set({ lastMessageAt: stale })
        .where(eq(chatThreads.id, fixture.threadId));
      context.mocks.ably.publish.mockClear();

      const replay = await postSignedCallback({
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "failed",
        error,
        payload: { threadId: fixture.threadId, agentId: fixture.agentId },
      });

      expect(replay.status).toBe(200);
      await expect(
        readThreadLastMessageAt(fixture.threadId),
      ).resolves.toStrictEqual(stale);
      const lifecycleMessages = (await listMessages(fixture.threadId)).filter(
        (message) => {
          return (
            message.role === "assistant" &&
            message.runId === fixture.runId &&
            message.runLifecycleEvent === lifecycleEvent
          );
        },
      );
      expect(lifecycleMessages).toHaveLength(1);
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        `chatThreadMessageCreated:${fixture.threadId}`,
        null,
      );
    },
  );

  it("publishes message-created signals only for terminal callbacks with a mapped thread", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedNoOutputEvents();

    const completed = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });
    expect(completed.status).toBe(200);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );

    context.mocks.ably.publish.mockClear();
    const progress = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "progress",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(progress.status).toBe(200);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadMessageCreated:${fixture.threadId}`,
      null,
    );
    await clearAllDetached();
  });

  it("auto-sends the oldest queued user message after a terminal callback", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const db = store.set(writeDb$);
    const selectedModel = "claude-sonnet-4-6";
    const item = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const generationTemplate = {
      type: "presentation",
      selection: {
        designSystemId: item.designSystemId,
        templateId: item.templateId,
      },
    } satisfies ChatMessageGenerationTemplate;
    const [secret] = await db
      .insert(secrets)
      .values({
        name: "ANTHROPIC_API_KEY",
        encryptedValue: encryptSecretForTests("queued-byok-key"),
        type: "model-provider",
        userId: ORG_SENTINEL_USER_ID,
        orgId: fixture.orgId,
      })
      .returning({ id: secrets.id });
    const [provider] = await db
      .insert(modelProviders)
      .values({
        type: "anthropic-api-key",
        secretId: secret!.id,
        isDefault: false,
        selectedModel,
        userId: ORG_SENTINEL_USER_ID,
        orgId: fixture.orgId,
      })
      .returning({ id: modelProviders.id });
    await db.insert(orgModelPolicies).values({
      orgId: fixture.orgId,
      model: selectedModel,
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: provider!.id,
      createdByUserId: fixture.userId,
      updatedByUserId: fixture.userId,
    });
    await db
      .update(chatThreads)
      .set({
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        modelProviderType: "vm0",
        modelProviderCredentialScope: "org",
        selectedModel,
      })
      .where(eq(chatThreads.id, fixture.threadId));
    const [queued] = await db
      .insert(chatMessages)
      .values({
        chatThreadId: fixture.threadId,
        role: "user",
        content: "queued next turn",
        runId: null,
        generationTemplate,
      })
      .returning({ id: chatMessages.id });
    if (!queued) {
      throw new Error("queued message insert returned no row");
    }
    completedAssistantOutput("previous answer");

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });

    const [claimed] = await db
      .select({
        id: chatMessages.id,
        runId: chatMessages.runId,
        revokesMessageId: chatMessages.revokesMessageId,
        content: chatMessages.content,
        generationTemplate: chatMessages.generationTemplate,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, fixture.threadId),
          eq(chatMessages.revokesMessageId, queued.id),
          isNotNull(chatMessages.runId),
        ),
      )
      .limit(1);
    expect(claimed).toMatchObject({
      content: "queued next turn",
      generationTemplate,
      revokesMessageId: queued.id,
    });
    expect(claimed?.runId).toBeTruthy();
    expect(claimed?.runId).not.toBe(fixture.runId);

    const [callback] = await db
      .select({
        url: agentRunCallbacks.url,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, claimed!.runId!))
      .limit(1);
    expect(callback?.url).toContain(PATH);
    expect(callback?.payload).toStrictEqual({
      threadId: fixture.threadId,
      agentId: fixture.agentId,
    });

    const [run] = await db
      .select({ appendSystemPrompt: agentRuns.appendSystemPrompt })
      .from(agentRuns)
      .where(eq(agentRuns.id, claimed!.runId!))
      .limit(1);
    expect(run?.appendSystemPrompt).toContain("# Generation Template");
    expect(run?.appendSystemPrompt).toContain("Type: presentation");
    expect(run?.appendSystemPrompt).toContain(
      `Design system ID: ${item.designSystemId}`,
    );
    expect(run?.appendSystemPrompt).toContain(
      `Template ID: ${item.templateId}`,
    );

    const [zeroRun] = await db
      .select({
        chatThreadId: zeroRuns.chatThreadId,
        modelProvider: zeroRuns.modelProvider,
        modelProviderId: zeroRuns.modelProviderId,
        modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, claimed!.runId!))
      .limit(1);
    expect(zeroRun).toStrictEqual({
      chatThreadId: fixture.threadId,
      modelProvider: "anthropic-api-key",
      modelProviderId: provider!.id,
      modelProviderCredentialScope: "org",
      selectedModel,
    });
    await clearAllDetached();
  });

  it("auto-sends a queued user message after failed callbacks too", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await seedOrgDefaultModelProvider(fixture);
    await setRunStatus(fixture.runId, "failed", "boom");
    const queuedId = await insertQueuedMessage(fixture, {
      content: "queued after failure",
    });

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "boom",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const claimed = (await listMessages(fixture.threadId)).find((message) => {
      return (
        message.role === "user" &&
        message.revokesMessageId === queuedId &&
        message.runId !== null
      );
    });
    expect(claimed?.content).toBe("queued after failure");
    expect(claimed?.runId).not.toBe(fixture.runId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${fixture.threadId}`,
      null,
    );
    await clearAllDetached();
  });

  it("continues the latest chat session when auto-sending queued messages", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await seedOrgDefaultModelProvider(fixture);
    const continuedSessionId = randomUUID();
    await store.set(writeDb$).insert(agentSessions).values({
      id: continuedSessionId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.agentId,
    });
    await setRunResult(fixture.runId, { agentSessionId: continuedSessionId });
    const queuedId = await insertQueuedMessage(fixture, {
      content: "queued in same session",
    });
    completedNoOutputEvents();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const claimed = (await listMessages(fixture.threadId)).find((message) => {
      return message.revokesMessageId === queuedId && message.runId !== null;
    });
    expect(claimed?.runId).toBeTruthy();
    const [run] = await store
      .set(writeDb$)
      .select({
        sessionId: agentRuns.sessionId,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, claimed!.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      sessionId: continuedSessionId,
      continuedFromSessionId: continuedSessionId,
    });
    await clearAllDetached();
  });

  it("preserves queued message attachments when auto-sending", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await seedOrgDefaultModelProvider(fixture);
    const queuedId = await insertQueuedMessage(fixture, {
      content: "queued with files",
      attachFiles: ["file-1"],
    });
    completedNoOutputEvents();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const claimed = (await listMessages(fixture.threadId)).find((message) => {
      return message.revokesMessageId === queuedId && message.runId !== null;
    });
    expect(claimed?.attachFiles).toStrictEqual(["file-1"]);
    expect(claimed?.runId).not.toBe(fixture.runId);
    await clearAllDetached();
  });

  it("does not auto-send when no queued user message exists", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await seedOrgDefaultModelProvider(fixture);
    completedNoOutputEvents();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const userMessages = (await listMessages(fixture.threadId)).filter(
      (message) => {
        return message.role === "user";
      },
    );
    expect(userMessages).toHaveLength(1);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadRunCreated:${fixture.threadId}`,
      null,
    );
    await clearAllDetached();
  });

  it("generates a chat thread title from the completed callback exchange", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "Use --inspect for debugging." },
      },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let capturedTitlePrompt: string | null = null;
    mockOpenRouter((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        capturedTitlePrompt = body.messages[1]?.content ?? null;
        return "Debugging Node Apps";
      }
      return "Generated summary";
    });

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const [thread] = await store
      .set(writeDb$)
      .select({ title: chatThreads.title })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId))
      .limit(1);
    expect(thread?.title).toBe("Debugging Node Apps");
    const titlePrompt = capturedTitlePrompt ?? "";
    expect(titlePrompt).toContain("Most recent user message:\ntest prompt");
    expect(titlePrompt).toContain(
      "Most recent assistant reply:\nUse --inspect for debugging.",
    );
    await clearAllDetached();
  });

  it("feeds prior rounds into the callback title prompt without duplicating the current run", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const prior = await seedAdditionalRun(fixture, {
      prompt: "How do I parse JSON?",
      status: "completed",
      result: { agentSessionId: fixture.sessionId },
      createdAt: new Date("2025-12-31T23:59:00.000Z"),
      completedAt: new Date("2025-12-31T23:59:10.000Z"),
    });
    await insertAssistantEventMessages(fixture, prior.runId, [
      { sequenceNumber: 0, content: "Use JSON.parse(str)." },
    ]);
    completedAssistantOutput("Use JSON.stringify(value).");
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    let capturedTitlePrompt: string | null = null;
    mockOpenRouter((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("Generate a short, descriptive title")) {
        capturedTitlePrompt = body.messages[1]?.content ?? null;
        return "Working with JSON";
      }
      return "Generated summary";
    });

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const titlePrompt = capturedTitlePrompt ?? "";
    expect(titlePrompt).toContain("Previous conversation");
    expect(titlePrompt).toContain("How do I parse JSON?");
    expect(titlePrompt).toContain("Use JSON.parse(str).");
    const priorSection =
      titlePrompt.split("Most recent user message:")[0] ?? "";
    expect(priorSection).not.toContain("test prompt");
    await clearAllDetached();
  });

  it("does not fail completed callbacks when title generation returns an upstream error", async () => {
    const fixture = await track(seedChatCallbackFixture());
    completedOutputEvents([
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "Some result" },
      },
    ]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    server.use(
      http.post("https://openrouter.ai/api/v1/chat/completions", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
    );

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    const [thread] = await store
      .set(writeDb$)
      .select({ title: chatThreads.title })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId))
      .limit(1);
    expect(thread?.title).toBe("Test thread");
    await clearAllDetached();
  });

  it("sends a push notification on completed callbacks when subscriptions and VAPID are configured", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await createPushSubscription(fixture);
    completedOutputEvents([
      {
        eventType: "result",
        sequenceNumber: 1,
        eventData: { result: "Files created successfully." },
      },
    ]);
    enableVapid();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      context.mocks.webpush.sendNotification.mock.calls[0]?.[1] as string,
    ) as {
      readonly title: string;
      readonly body: string;
      readonly url: string;
    };
    expect(payload.title).toBe("test prompt");
    expect(payload.body).toBe("Your task is complete");
    expect(payload.url).toBe(`/chats/${fixture.threadId}`);
    await clearAllDetached();
  });

  it("sends a push notification on failed callbacks", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await createPushSubscription(fixture);
    enableVapid();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "failed",
      error: "Agent crashed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    expect(context.mocks.webpush.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      context.mocks.webpush.sendNotification.mock.calls[0]?.[1] as string,
    ) as {
      readonly title: string;
      readonly body: string;
      readonly url: string;
    };
    expect(payload.title).toBe("test prompt");
    expect(payload.body).toContain(
      "Oops, something went wrong. Please try again later.",
    );
    expect(payload.url).toBe(`/chats/${fixture.threadId}`);
  });

  it("does not send push notifications when VAPID keys are absent", async () => {
    const fixture = await track(seedChatCallbackFixture());
    await createPushSubscription(fixture);
    completedNoOutputEvents();

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    expect(context.mocks.webpush.sendNotification).not.toHaveBeenCalled();
    await clearAllDetached();
  });

  it("deletes stale push subscriptions after gone responses", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const endpoint = await createPushSubscription(fixture);
    completedNoOutputEvents();
    enableVapid();
    context.mocks.webpush.sendNotification.mockRejectedValueOnce(
      new WebPushError("Gone", 410, {}, "", endpoint),
    );

    const response = await postSignedCallback({
      callbackId: fixture.callbackId,
      runId: fixture.runId,
      status: "completed",
      payload: { threadId: fixture.threadId, agentId: fixture.agentId },
    });

    expect(response.status).toBe(200);
    await expect(listPushSubscriptions(fixture.userId)).resolves.toStrictEqual(
      [],
    );
    await clearAllDetached();
  });

  it("rejects invalid callback signatures", async () => {
    const fixture = await track(seedChatCallbackFixture());

    const response = await postSignedCallback(
      {
        callbackId: fixture.callbackId,
        runId: fixture.runId,
        status: "completed",
        payload: { threadId: fixture.threadId, agentId: fixture.agentId },
      },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
    const messages = await store
      .set(writeDb$)
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, fixture.threadId),
          eq(chatMessages.role, "assistant"),
          isNull(chatMessages.error),
        ),
      );
    expect(messages).toStrictEqual([]);
  });
});
