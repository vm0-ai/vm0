import { createHash, randomUUID } from "node:crypto";

import {
  sharedThreadsContract,
  type SharedThreadResponse,
} from "@vm0/api-contracts/contracts/shared-threads";
import {
  ARTIFACT_CATALOG_KINDS,
  artifactCatalogContract,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
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

interface CreatedSharedThreadResult {
  readonly status: 201;
  readonly body: { readonly id: string };
  readonly headers: Headers;
}

interface ReadSharedThreadResult {
  readonly status: 200;
  readonly body: SharedThreadResponse;
  readonly headers: Headers;
}

interface ReadSharedThreadMetaResult {
  readonly status: 200;
  readonly body: { readonly title: string };
  readonly headers: Headers;
}

async function createSharedThreadSnapshot(
  actor: ApiTestUser,
  threadId: string,
  eventIds: readonly string[],
): Promise<CreatedSharedThreadResult> {
  return await accept(
    sharedThreadsClient().create({
      headers: authenticate(actor),
      params: { threadId },
      body: { eventIds },
    }),
    [201],
  );
}

async function readSharedThreadSnapshot(
  id: string,
): Promise<ReadSharedThreadResult> {
  return await accept(sharedThreadsClient().get({ params: { id } }), [200]);
}

async function readSharedThreadMeta(
  id: string,
): Promise<ReadSharedThreadMetaResult> {
  return await accept(sharedThreadsClient().meta({ params: { id } }), [200]);
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
}>;
async function sendRun(
  owner: SharedThreadActor,
  prompt: string,
): Promise<{
  readonly runId: string;
  readonly threadId: string;
}>;
async function sendRun(
  owner: SharedThreadActor,
  prompt = "Prepare the private launch plan",
): Promise<{
  readonly runId: string;
  readonly threadId: string;
}> {
  const sent = await chat.requestSendEvent(
    owner.actor,
    {
      agentId: owner.agentId,
      prompt,
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

    let events: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
    await expect
      .poll(async () => {
        events = await chat.listThreadEvents(owner.actor, run.threadId);
        return events.events.some((event) => {
          return (
            event.eventType === "run.completed" && event.runId === run.runId
          );
        });
      })
      .toBe(true);
    if (!events) {
      throw new Error("Expected completed shared-thread fixture events");
    }
    const promptEvent = events.events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === run.runId;
    });
    const assistantEvent = events.events.find((event) => {
      return event.eventType === "output.message";
    });
    const nonShareableEvent = events.events.find((event) => {
      return event.eventType === "run.completed";
    });
    const otherRun = await sendRun(
      owner,
      "This other thread must stay private",
    );
    const otherEvents = await chat.listThreadEvents(
      owner.actor,
      otherRun.threadId,
    );
    const otherPromptEvent = otherEvents.events.find((event) => {
      return event.eventType === "input.prompt";
    });
    if (
      !promptEvent ||
      !assistantEvent ||
      !nonShareableEvent ||
      !otherPromptEvent
    ) {
      throw new Error(
        "Expected shareable, non-shareable, and cross-thread events",
      );
    }

    mockOptionalEnv("OPENROUTER_API_KEY", "shared-title-key");
    const titlePrompts: string[] = [];
    chatCallbacks.mockOpenRouterCompletions((body) => {
      const systemContent = body.messages[0]?.content ?? "";
      if (systemContent.includes("for this shared conversation")) {
        titlePrompts.push(body.messages[1]?.content ?? "");
        return "**Private launch plan**";
      }
      return "Generated summary";
    });

    const eventIds = [
      randomUUID(),
      otherPromptEvent.id,
      nonShareableEvent.id,
      assistantEvent.id,
      promptEvent.id,
      assistantEvent.id,
    ];
    const first = await createSharedThreadSnapshot(
      owner.actor,
      run.threadId,
      eventIds,
    );
    const second = await createSharedThreadSnapshot(
      owner.actor,
      run.threadId,
      eventIds,
    );
    expect(second.body.id).not.toBe(first.body.id);
    expect(titlePrompts).toHaveLength(2);
    expect(titlePrompts[0]).toContain("Prepare the private launch plan");
    expect(titlePrompts[0]).toContain(assistantText);
    expect(titlePrompts[0]).not.toContain(
      "This other thread must stay private",
    );

    const publicSnapshot = await readSharedThreadSnapshot(first.body.id);
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

    const metadata = await readSharedThreadMeta(first.body.id);
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

    const legacyCatalog = await accept(
      setupApp({ context })(artifactCatalogContract).list({
        headers: authenticate(owner.actor),
        query: {},
      }),
      [200],
    );
    expect(legacyCatalog.body.supportedKinds).toStrictEqual(
      ARTIFACT_CATALOG_KINDS.filter((kind) => {
        return kind !== "shared-thread";
      }),
    );
    expect(
      legacyCatalog.body.artifacts.some((artifact) => {
        return artifact.kind === "shared-thread";
      }),
    ).toBeFalsy();
    const legacyDetail = await accept(
      setupApp({ context })(artifactCatalogContract).get({
        headers: authenticate(owner.actor),
        params: { artifactId },
      }),
      [404],
    );
    expect(legacyDetail.body.error.code).toBe("NOT_FOUND");

    await chat.deleteThread(owner.actor, run.threadId);
    const afterSourceDeletion = await readSharedThreadSnapshot(first.body.id);
    expect(afterSourceDeletion.body).toStrictEqual(publicSnapshot.body);
  }, 180_000);

  it("allows API creation while the entry feature switch is disabled", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "shared-title-key");
    const owner = await createActor();
    const run = await sendRun(owner);
    const events = await chat.listThreadEvents(owner.actor, run.threadId);
    const promptEvent = events.events.find((event) => {
      return event.eventType === "input.prompt" && event.runId === run.runId;
    });
    if (!promptEvent) {
      throw new Error("Expected an associated prompt event");
    }
    chatCallbacks.mockOpenRouterCompletions(() => {
      return "Private launch plan";
    });

    const created = await createSharedThreadSnapshot(
      owner.actor,
      run.threadId,
      [promptEvent.id],
    );

    await expect(
      readSharedThreadSnapshot(created.body.id),
    ).resolves.toMatchObject({
      status: 200,
      body: { title: "Private launch plan" },
    });
  });
});
