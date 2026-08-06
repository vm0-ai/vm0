import { createHash, randomUUID } from "node:crypto";

import { sharedThreadsContract } from "@vm0/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createZeroRouteMocks(context);

interface SharedThreadActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
}

function sharedThreadsClient() {
  return setupApp({ context })(sharedThreadsContract);
}

function authenticate(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function createActor(): Promise<SharedThreadActor> {
  const actor = bdd.user();
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Shared thread test agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
}

async function sendRun(owner: SharedThreadActor): Promise<{
  readonly runId: string;
  readonly threadId: string;
}> {
  const sent = await chat.requestSendEvent(
    owner.actor,
    {
      agentId: owner.agentId,
      prompt: "Prepare the private launch plan",
      clientEventId: randomUUID(),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected shared-thread fixture run to be created");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function completeRun(
  runnerGroup: string,
  runId: string,
  assistantText: string,
): Promise<void> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  const sandboxHeaders = {
    authorization: `Bearer ${claim.sandboxToken}`,
  };
  chatCallbacks.mockChatOutputEvents([
    {
      eventType: "assistant",
      sequenceNumber: 0,
      eventData: {
        message: { content: [{ type: "text", text: assistantText }] },
      },
    },
  ]);
  const outputEvents = chatCallbacks.consumeMockChatOutputEvents();
  await webhooks.requestAgentEvents(
    { runId, events: outputEvents },
    sandboxHeaders,
    [200],
  );
  const historyHash = createHash("sha256")
    .update(`shared thread history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `shared-thread-${runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId, exitCode: 0, lastEventSequence: 0 },
    sandboxHeaders,
    [200],
  );
}

describe("shared thread routes", () => {
  it("creates immutable, redacted snapshots from selected visible messages", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    const owner = await createActor();
    if (!owner.actor.orgId) {
      throw new Error("Expected shared-thread actor to have an organization");
    }
    const run = await sendRun(owner);
    const assistantText = "Here is the **public** launch plan.";
    await completeRun(owner.runnerGroup, run.runId, assistantText);

    const events = await chat.listThreadEvents(owner.actor, run.threadId);
    const promptEvent = events.events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === run.runId;
    });
    const assistantEvent = events.events.find((event) => {
      return event.eventType === "output.message";
    });
    if (!promptEvent || !assistantEvent) {
      throw new Error("Expected prompt and assistant events");
    }

    const disabled = await accept(
      sharedThreadsClient().create({
        headers: authenticate(owner.actor),
        params: { threadId: run.threadId },
        body: { eventIds: [promptEvent.id] },
      }),
      [403],
    );
    expect(disabled.body.error.code).toBe("FORBIDDEN");

    await updateFeatureSwitchesForUser(
      context,
      {
        userId: owner.actor.userId,
        orgId: owner.actor.orgId,
        orgRole: owner.actor.orgRole,
      },
      { [FeatureSwitchKey.SharedThreadSharing]: true },
    );
    mockOptionalEnv("OPENROUTER_API_KEY", "shared-title-key");
    const titlePrompts: string[] = [];
    chatCallbacks.mockOpenRouterCompletions((body) => {
      titlePrompts.push(
        body.messages
          .map((message) => {
            return message.content;
          })
          .join("\n"),
      );
      return "**Private launch plan**";
    });

    const eventIds = [
      randomUUID(),
      assistantEvent.id,
      promptEvent.id,
      assistantEvent.id,
    ];
    const first = await accept(
      sharedThreadsClient().create({
        headers: authenticate(owner.actor),
        params: { threadId: run.threadId },
        body: { eventIds },
      }),
      [201],
    );
    const second = await accept(
      sharedThreadsClient().create({
        headers: authenticate(owner.actor),
        params: { threadId: run.threadId },
        body: { eventIds },
      }),
      [201],
    );
    expect(second.body.id).not.toBe(first.body.id);
    expect(titlePrompts).toHaveLength(2);
    expect(titlePrompts[0]).toContain("Prepare the private launch plan");
    expect(titlePrompts[0]).toContain(assistantText);

    const publicSnapshot = await accept(
      sharedThreadsClient().get({ params: { id: first.body.id } }),
      [200],
    );
    expect(publicSnapshot.headers.get("cache-control")).toBe("no-store");
    expect(publicSnapshot.body).toStrictEqual({
      id: first.body.id,
      title: "Private launch plan",
      messages: [
        {
          messageIndex: 0,
          role: "user",
          content: "Prepare the private launch plan",
          runIndex: 0,
        },
        {
          messageIndex: 1,
          role: "assistant",
          content: assistantText,
          runIndex: 0,
        },
      ],
    });

    const metadata = await accept(
      sharedThreadsClient().meta({ params: { id: first.body.id } }),
      [200],
    );
    expect(metadata.body).toStrictEqual({ title: "Private launch plan" });
    expect(metadata.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );

    const catalog = await chat.listArtifactCatalog(owner.actor, {
      kind: "shared-thread",
      chatThreadId: run.threadId,
    });
    expect(catalog.artifacts).toHaveLength(2);
    expect(catalog.artifacts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "shared-thread",
          title: "Private launch plan",
        }),
      ]),
    );
    const artifactId = catalog.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected a shared-thread artifact");
    }
    const detail = await chat.getArtifactCatalogEntry(owner.actor, artifactId);
    expect(detail.kind).toBe("shared-thread");

    await chat.deleteThread(owner.actor, run.threadId);
    const afterSourceDeletion = await accept(
      sharedThreadsClient().get({ params: { id: first.body.id } }),
      [200],
    );
    expect(afterSourceDeletion.body).toStrictEqual(publicSnapshot.body);
  }, 180_000);
});
