import { randomUUID } from "node:crypto";

import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { createStore } from "ccstate";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  decryptSecretValue,
  decryptSecretsMap,
} from "../../services/crypto.utils";
import { writeDb$ } from "../../external/db";
import { nowDate } from "../../external/time";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface ChatMessageFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly versionId: string;
}

const track = createFixtureTracker<ChatMessageFixture>(deleteFixture);

function client() {
  return setupApp({ context })(chatMessagesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function encryptedSecretsFromExecutionContext(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "encryptedSecrets" in value
  ) {
    const encryptedSecrets = (value as { encryptedSecrets: unknown })
      .encryptedSecrets;
    return typeof encryptedSecrets === "string" ? encryptedSecrets : null;
  }
  return null;
}

function vm0Template(expression: string): string {
  return `$${expression}`;
}

async function seedFixture(): Promise<ChatMessageFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const name = `agent-${agentId.slice(0, 8)}`;
  const writeDb = store.set(writeDb$);

  await writeDb.insert(agentComposes).values({
    id: agentId,
    userId,
    orgId,
    name,
    headVersionId: versionId,
  });
  await writeDb.insert(agentComposeVersions).values({
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
  await writeDb.insert(zeroAgents).values({
    id: agentId,
    orgId,
    owner: userId,
    name,
    visibility: "public",
  });

  mocks.clerk.session(userId, orgId);
  context.mocks.s3.send.mockResolvedValue({});
  mockEnv("VM0_API_URL", "http://localhost:3000");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");

  return { userId, orgId, agentId, versionId };
}

async function deleteFixture(fixture: ChatMessageFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  const threadRows = await writeDb
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.userId, fixture.userId));
  const threadIds = threadRows.map((row) => {
    return row.id;
  });
  const runRows = await writeDb
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, fixture.userId));
  const runIds = runRows.map((row) => {
    return row.id;
  });

  if (runIds.length > 0) {
    await writeDb
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    await writeDb
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
  }
  if (threadIds.length > 0) {
    await writeDb
      .delete(chatMessages)
      .where(inArray(chatMessages.chatThreadId, threadIds));
  }
  if (runIds.length > 0) {
    await writeDb.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    await writeDb.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  }
  await writeDb
    .delete(agentSessions)
    .where(eq(agentSessions.userId, fixture.userId));
  if (threadIds.length > 0) {
    await writeDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, fixture.orgId));
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, fixture.agentId));
  await writeDb
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, fixture.agentId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.agentId));
}

function send(body: Record<string, unknown>) {
  return accept(
    client().send({
      headers: authHeaders(),
      body: body as never,
    }),
    [201],
  );
}

async function firstUserMessage(threadId: string) {
  const [message] = await store
    .set(writeDb$)
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      runId: chatMessages.runId,
      revokesMessageId: chatMessages.revokesMessageId,
      interruptsRunId: chatMessages.interruptsRunId,
      goalRemainingTurns: chatMessages.goalRemainingTurns,
      goalOriginMessageId: chatMessages.goalOriginMessageId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.chatThreadId, threadId))
    .orderBy(chatMessages.createdAt)
    .limit(1);
  return message;
}

async function setRunStatus(runId: string, status: string): Promise<void> {
  await store
    .set(writeDb$)
    .update(agentRuns)
    .set({ status, completedAt: nowDate() })
    .where(eq(agentRuns.id, runId));
}

describe("POST /api/zero/chat/messages", () => {
  it("returns 401 without auth", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      client().send({
        headers: {},
        body: { agentId: randomUUID(), prompt: "hello" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates a thread, run, callback, ZERO_TOKEN secret, and user message", async () => {
    const fixture = await track(seedFixture());

    const response = await send({
      agentId: fixture.agentId,
      prompt: "hello from api chat",
    });
    await clearAllDetached();

    expect(response.body.runId).toStrictEqual(expect.any(String));
    expect(response.body.threadId).toStrictEqual(expect.any(String));

    const writeDb = store.set(writeDb$);
    const [run] = await writeDb
      .select({
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        triggerSource: zeroRuns.triggerSource,
        chatThreadId: zeroRuns.chatThreadId,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(agentRuns.id, response.body.runId!))
      .limit(1);
    expect(run).toStrictEqual({
      prompt: "hello from api chat",
      appendSystemPrompt: expect.stringContaining(
        "You are currently running inside: Web",
      ),
      triggerSource: "web",
      chatThreadId: response.body.threadId,
    });

    const message = await firstUserMessage(response.body.threadId);
    expect(message).toMatchObject({
      content: "hello from api chat",
      runId: response.body.runId,
      revokesMessageId: null,
      interruptsRunId: null,
    });

    const [callback] = await writeDb
      .select({
        url: agentRunCallbacks.url,
        encryptedSecret: agentRunCallbacks.encryptedSecret,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.runId!))
      .limit(1);
    expect(callback?.url).toBe(
      "http://localhost:3000/api/internal/callbacks/chat",
    );
    expect(decryptSecretValue(callback!.encryptedSecret)).toHaveLength(64);
    expect(callback?.payload).toStrictEqual({
      threadId: response.body.threadId,
      agentId: fixture.agentId,
    });

    const [job] = await writeDb
      .select({ executionContext: runnerJobQueue.executionContext })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, response.body.runId!))
      .limit(1);
    const secrets = decryptSecretsMap(
      encryptedSecretsFromExecutionContext(job?.executionContext),
    );
    expect(secrets?.ZERO_TOKEN).toMatch(/^vm0_sandbox_/);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${response.body.threadId}`,
      null,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadRunCreated:${response.body.threadId}`,
      null,
    );
  });

  it("queues an unassociated user message when the thread has an active run", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();

    const second = await send({
      agentId: fixture.agentId,
      prompt: "queued",
      threadId: first.body.threadId,
    });

    expect(second.body.runId).toBeNull();
    const [queued] = await store
      .set(writeDb$)
      .select({
        content: chatMessages.content,
        runId: chatMessages.runId,
        revokesMessageId: chatMessages.revokesMessageId,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, first.body.threadId),
          eq(chatMessages.content, "queued"),
        ),
      )
      .limit(1);
    expect(queued).toStrictEqual({
      content: "queued",
      runId: null,
      revokesMessageId: null,
    });
  });

  it("recalls only queued user messages", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();
    await send({
      agentId: fixture.agentId,
      prompt: "queued for recall",
      threadId: first.body.threadId,
    });

    const [queued] = await store
      .set(writeDb$)
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, first.body.threadId),
          eq(chatMessages.content, "queued for recall"),
          isNull(chatMessages.runId),
        ),
      )
      .limit(1);

    const recallId = randomUUID();
    const recall = await send({
      agentId: fixture.agentId,
      threadId: first.body.threadId,
      revokesMessageId: queued!.id,
      clientMessageId: recallId,
    });
    expect(recall.body.runId).toBeNull();

    const [recallMessage] = await store
      .set(writeDb$)
      .select({
        id: chatMessages.id,
        runId: chatMessages.runId,
        content: chatMessages.content,
        revokesMessageId: chatMessages.revokesMessageId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, recallId))
      .limit(1);
    expect(recallMessage).toStrictEqual({
      id: recallId,
      runId: null,
      content: null,
      revokesMessageId: queued!.id,
    });
  });

  it("interrupts and cancels an active chat run", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "first" });
    await clearAllDetached();

    const interruptId = randomUUID();
    const interrupt = await send({
      agentId: fixture.agentId,
      threadId: first.body.threadId,
      interruptsRunId: first.body.runId,
      clientMessageId: interruptId,
    });
    expect(interrupt.body.runId).toBeNull();

    const writeDb = store.set(writeDb$);
    const [run] = await writeDb
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, first.body.runId!))
      .limit(1);
    expect(run?.status).toBe("cancelled");

    const [message] = await writeDb
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        runId: chatMessages.runId,
        interruptsRunId: chatMessages.interruptsRunId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, interruptId))
      .limit(1);
    expect(message).toStrictEqual({
      id: interruptId,
      content: null,
      runId: null,
      interruptsRunId: first.body.runId,
    });
  });

  it("injects incomplete cancelled rounds into the next run prompt", async () => {
    const fixture = await track(seedFixture());
    const first = await send({ agentId: fixture.agentId, prompt: "cancel me" });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "cancelled");

    const second = await send({
      agentId: fixture.agentId,
      prompt: "retry",
      threadId: first.body.threadId,
    });
    await clearAllDetached();

    const [run] = await store
      .set(writeDb$)
      .select({ appendSystemPrompt: agentRuns.appendSystemPrompt })
      .from(agentRuns)
      .where(eq(agentRuns.id, second.body.runId!))
      .limit(1);
    expect(run?.appendSystemPrompt).toContain("# Incomplete Rounds Context");
    expect(run?.appendSystemPrompt).toContain("RUN_STATUS: cancelled");
    expect(run?.appendSystemPrompt).toContain("User: cancel me");
  });

  it("persists goal columns for goal sends when the feature is enabled", async () => {
    const fixture = await track(seedFixture());
    await store
      .set(writeDb$)
      .insert(userFeatureSwitches)
      .values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        switches: { goal: true },
        updatedAt: nowDate(),
      });

    const response = await send({
      agentId: fixture.agentId,
      prompt: "finish the migration",
      goal: true,
    });
    await clearAllDetached();

    const message = await firstUserMessage(response.body.threadId);
    expect(message?.goalRemainingTurns).toBe(10);
    expect(message?.goalOriginMessageId).toBe(message?.id);
  });

  it("forceNewSession rewrites the model pin and injects prior chat context", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await writeDb.insert(userFeatureSwitches).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { modelFirstModelProvider: true },
      updatedAt: nowDate(),
    });
    await writeDb.insert(orgModelPolicies).values([
      {
        orgId: fixture.orgId,
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        createdByUserId: fixture.userId,
        updatedByUserId: fixture.userId,
      },
      {
        orgId: fixture.orgId,
        model: "claude-sonnet-4-6",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
        createdByUserId: fixture.userId,
        updatedByUserId: fixture.userId,
      },
    ]);

    const first = await send({
      agentId: fixture.agentId,
      prompt: "first on opus",
    });
    await clearAllDetached();
    await setRunStatus(first.body.runId!, "completed");

    const second = await send({
      agentId: fixture.agentId,
      prompt: "now on sonnet",
      threadId: first.body.threadId,
      modelSelection: {
        modelProviderId: "00000000-0000-4000-8000-000000000000",
        selectedModel: "claude-sonnet-4-6",
      },
      forceNewSession: true,
    });
    await clearAllDetached();

    const [thread] = await writeDb
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, first.body.threadId))
      .limit(1);
    expect(thread?.selectedModel).toBe("claude-sonnet-4-6");

    const [run] = await writeDb
      .select({
        selectedModel: zeroRuns.selectedModel,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
      .where(eq(zeroRuns.id, second.body.runId!))
      .limit(1);
    expect(run?.selectedModel).toBe("claude-sonnet-4-6");
    expect(run?.appendSystemPrompt).toContain("# Prior Chat Thread Context");
    expect(run?.appendSystemPrompt).toContain("User: first on opus");
  });
});
