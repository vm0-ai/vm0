import { randomUUID } from "node:crypto";

import { webhookPiTranscriptContract } from "@vm0/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);

const MODEL = "deepseek-v4-flash";
const COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";

interface PiEdgeFixture {
  readonly actor: ApiTestUser;
  readonly switchOwner: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly runnerGroup: string;
}

async function piEdgeFixture(): Promise<PiEdgeFixture> {
  const orgId = `org_pi_edge_${randomUUID()}`;
  const actor = bdd.user({ orgId });
  const switchOwner = bdd.user({ orgId });
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const provider = await api.createOrgModelProvider(actor, {
    type: "deepseek",
    secret: "pi-edge-deepseek-key",
  });
  await api.updateOrgModelPolicies(actor, [
    {
      model: MODEL,
      isDefault: true,
      defaultProviderType: "deepseek",
      credentialScope: "org",
      modelProviderId: provider.providerId,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Pi edge integration agent",
    description: "Exercises the in-API Pi edge turn.",
    visibility: "private",
  });
  return {
    actor,
    switchOwner,
    agentId: agent.agentId,
    orgId,
    runnerGroup,
  };
}

async function enablePiLoop(fixture: PiEdgeFixture): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: fixture.switchOwner.userId,
      orgId: fixture.orgId,
      orgRole: fixture.switchOwner.orgRole,
    },
    { [FeatureSwitchKey.PiLoop]: true },
  );
}

async function sendChatRun(
  fixture: PiEdgeFixture,
  prompt: string,
  threadId?: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      model: MODEL,
      clientEventId: randomUUID(),
      ...(threadId === undefined ? {} : { threadId }),
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

async function readTranscript(runId: string) {
  const response = await accept(
    setupApp({ context })(webhookPiTranscriptContract).read({
      headers: webhooks.sandboxWebhookHeaders({ runId }),
      query: { runId },
    }),
    [200],
  );
  return response.body;
}

async function outputMessages(actor: ApiTestUser, threadId: string) {
  const page = await chat.listThreadEvents(actor, threadId);
  return page.events.filter((event) => {
    return event.eventType === "output.message";
  });
}

describe("PiLoop edge turn", () => {
  it("uses the org gate, starts an existing thread without legacy backfill, and completes in the API", async () => {
    const fixture = await piEdgeFixture();
    const legacyPrompt = "legacy context must not enter the Pi transcript";
    const legacy = await sendChatRun(fixture, legacyPrompt);

    expect((await api.readRun(fixture.actor, legacy.runId)).status).toBe(
      "pending",
    );
    const legacyPoll = await api.pollRunner(fixture.runnerGroup);
    expect(legacyPoll.body.job?.runId).toBe(legacy.runId);
    await api.requestCancelRun(fixture.actor, legacy.runId, [200]);

    await enablePiLoop(fixture);
    const modelStarted = createDeferredPromise<void>(context.signal);
    const releaseModel = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseModel.settled()) {
        releaseModel.resolve();
      }
    });
    let completionRequest: unknown;
    server.use(
      http.post(COMPLETIONS_URL, async ({ request }) => {
        completionRequest = await request.json();
        modelStarted.resolve();
        await releaseModel.promise;
        return HttpResponse.json({
          choices: [
            {
              message: {
                role: "assistant",
                reasoning_content: "edge reasoning",
                content: "edge answer",
              },
            },
          ],
        });
      }),
    );

    const edgePrompt = "answer only this new message";
    const publishedBefore = context.mocks.ably.publish.mock.calls.length;
    const edge = await sendChatRun(fixture, edgePrompt, legacy.threadId);
    await modelStarted.promise;

    const defaultPoll = await api.pollRunner(fixture.runnerGroup);
    expect(defaultPoll.body.job).toBeNull();
    const standbyPoll = await api.requestPollRunner(
      true,
      {
        group: fixture.runnerGroup,
        supportedProfiles: ["vm0/pi-standby"],
      },
      [200],
    );
    expect(standbyPoll.body.job).toMatchObject({
      runId: edge.runId,
      experimentalProfile: "vm0/pi-standby",
    });

    releaseModel.resolve();
    await flushWaitUntilForTest();

    expect(completionRequest).toMatchObject({
      model: MODEL,
      messages: [{ role: "user", content: edgePrompt }],
      stream: false,
    });
    expect(JSON.stringify(completionRequest)).not.toContain(legacyPrompt);

    const transcript = await readTranscript(edge.runId);
    expect(transcript).toMatchObject({
      version: 1,
      lastOrdinal: 2,
      messages: [
        {
          ordinal: 1,
          messageId: `${edge.runId}/1`,
          runId: edge.runId,
          runEventSequenceNumber: 1,
          role: "user",
          payload: {
            role: "user",
            content: [{ type: "text", text: edgePrompt }],
          },
        },
        {
          ordinal: 2,
          messageId: `${edge.runId}/2`,
          runId: edge.runId,
          runEventSequenceNumber: 2,
          role: "assistant",
          payload: {
            role: "assistant",
            content: [
              { type: "thinking", text: "edge reasoning" },
              { type: "text", text: "edge answer" },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(transcript)).not.toContain(legacyPrompt);

    const projected = await outputMessages(fixture.actor, edge.threadId);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      runId: edge.runId,
      content: "edge answer",
    });
    expect((await api.readRun(fixture.actor, edge.runId)).status).toBe(
      "completed",
    );
    expect(
      context.mocks.ably.publish.mock.calls
        .slice(publishedBefore)
        .some(([topic]) => {
          return topic === `chatThreadMessageCreated:${edge.threadId}`;
        }),
    ).toBeTruthy();
  });

  it("fails the run after preserving the user message when the model call fails", async () => {
    const fixture = await piEdgeFixture();
    await enablePiLoop(fixture);
    server.use(
      http.post(COMPLETIONS_URL, () => {
        return HttpResponse.json(
          { error: "provider unavailable" },
          { status: 503 },
        );
      }),
    );

    const prompt = "this model call will fail";
    const run = await sendChatRun(fixture, prompt);
    await flushWaitUntilForTest();

    expect((await api.readRun(fixture.actor, run.runId)).status).toBe("failed");
    const transcript = await readTranscript(run.runId);
    expect(transcript).toMatchObject({
      version: 1,
      lastOrdinal: 1,
      messages: [
        {
          ordinal: 1,
          messageId: `${run.runId}/1`,
          role: "user",
          payload: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        },
      ],
    });
    await expect(
      outputMessages(fixture.actor, run.threadId),
    ).resolves.toHaveLength(0);
  });
});
