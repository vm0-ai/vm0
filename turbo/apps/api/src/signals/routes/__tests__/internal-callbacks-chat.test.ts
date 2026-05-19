import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { secrets } from "@vm0/db/schema/secret";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
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
  await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
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

async function listMessages(threadId: string) {
  return await store
    .set(writeDb$)
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, threadId))
    .orderBy(chatMessages.createdAt);
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
      `chatThreadRunUpdated:${fixture.threadId}`,
      null,
    );
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

  it("renders ChatGPT Codex usage limit errors with VM0 guidance", async () => {
    const fixture = await track(seedChatCallbackFixture());
    const codexUsageLimitError =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:17 AM.";
    const expectedDisplayError =
      "ChatGPT Codex usage limit reached. This limit resets at 6:17 AM. View details in [ChatGPT Codex usage settings](https://chatgpt.com/codex/settings/usage), or switch to another model to continue now.";

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
    expect(errorMessage?.error).toBe(expectedDisplayError);
    expect(errorMessage?.content).toBe(expectedDisplayError);
    expect(errorMessage?.error).not.toBe(codexUsageLimitError);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("auto-sends the oldest queued user message after a terminal callback", async () => {
    const fixture = await track(seedChatCallbackFixture());
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
    const [queued] = await db
      .insert(chatMessages)
      .values({
        chatThreadId: fixture.threadId,
        role: "user",
        content: "queued next turn",
        runId: null,
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
