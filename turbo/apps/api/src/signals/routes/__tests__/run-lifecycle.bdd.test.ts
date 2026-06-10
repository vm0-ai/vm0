import { createHash, randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { clearAllDetached } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsSchedulesApi } from "./helpers/api-bdd-runs-schedules";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

/**
 * RUN-01..04 and CHAIN-RUN: successful run dispatch and lifecycle.
 *
 * The billing entitlement Given uses the public Stripe webhook contract
 * (invoice.paid for a mocked subscription) and verifies the grant through the
 * billing status API, so no DB fixtures are involved.
 */

const context = testContext();

async function entitledRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly granted: {
    readonly customerId: string;
    readonly subscriptionId: string;
  };
}> {
  const bdd = createBddApi(context);
  const api = createRunsSchedulesApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  const granted = await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD lifecycle agent",
    description: "Exercises the full run lifecycle.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, granted };
}

const CHAT_CALLBACK_URL = "http://localhost:3000/api/internal/callbacks/chat";

function proxyChatCallbackToApp(): void {
  server.use(
    http.post(CHAT_CALLBACK_URL, async ({ request }) => {
      const app = createApp({ signal: context.signal });
      return await app.request("/api/internal/callbacks/chat", {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      });
    }),
  );
}

async function sendChatRunMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly prompt: string;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const chat = createChatFilesBddApi(context);
  const sent = await chat.requestSendMessage(
    actor,
    { ...body, modelProvider: "anthropic-api-key" },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId: sent.body.threadId };
}

describe("CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks", () => {
  it("creates, dispatches, claims, reports, and completes a run through public APIs", async () => {
    const api = createRunsSchedulesApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const created = await api.createRun(actor, {
      agentId,
      prompt: "summarize the repository",
      modelProvider: "anthropic-api-key",
    });
    expect(created.status).toBe("pending");
    expect(created.sessionId).toMatch(/[0-9a-f-]{36}/);

    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.tier).toBe("pro");
    expect(queue.body.concurrency.active).toBe(1);

    await api.heartbeatRunner(runnerGroup);
    const poll = await api.pollRunner(runnerGroup);
    expect(poll.body.job?.runId).toBe(created.runId);
    expect(poll.body.job?.experimentalProfile).toBe("vm0/default");

    const claim = await api.claimRunnerJob(created.runId);
    expect(claim.sandboxToken).not.toBe("");
    expect(claim.prompt).toBe("summarize the repository");
    expect(claim.environment).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/.+/),
    });
    expect(claim.cliAgentType).toBe("claude-code");

    const running = await api.readRun(actor, created.runId);
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();

    const reclaimed = await api.requestClaimRunnerJob(
      true,
      created.runId,
      [404],
    );
    expectApiError(reclaimed.body);

    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    await webhooks.requestAgentHeartbeat(
      { runId: created.runId },
      sandboxHeaders,
      [200],
    );

    await webhooks.requestAgentTelemetry(
      {
        runId: created.runId,
        systemLog: "runner booted",
        metrics: [
          {
            ts: nowDate().toISOString(),
            cpu: 1,
            mem_used: 2,
            mem_total: 4,
            disk_used: 8,
            disk_total: 16,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    await webhooks.requestAgentEvents(
      {
        runId: created.runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      sandboxHeaders,
      [200],
    );

    const historyHash = createHash("sha256")
      .update(`bdd session history ${created.runId}`)
      .digest("hex");
    await webhooks.requestAgentCheckpoint(
      {
        runId: created.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${created.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders,
      [200],
    );

    await webhooks.requestAgentComplete(
      { runId: created.runId, exitCode: 0, lastEventSequence: 0 },
      sandboxHeaders,
      [200],
    );

    const completed = await api.readRun(actor, created.runId);
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.result?.checkpointId).toBeDefined();

    const drained = await api.readRunQueue(actor);
    expect(drained.body.concurrency.active).toBe(0);

    const uncancellable = await api.requestCancelRun(
      actor,
      created.runId,
      [400],
    );
    expectApiError(uncancellable.body);
  });

  it("resumes the previous session when a run is created with the same sessionId", async () => {
    const api = createRunsSchedulesApi(context);
    const { actor, agentId } = await entitledRunActor();

    const first = await api.createRun(actor, {
      agentId,
      prompt: "start a session",
      modelProvider: "anthropic-api-key",
    });

    const resumed = await api.createRun(actor, {
      agentId,
      sessionId: first.sessionId,
      prompt: "continue the session",
      modelProvider: "anthropic-api-key",
    });
    expect(resumed.sessionId).toBe(first.sessionId);

    const outsider = createBddApi(context).user();
    const crossUser = await api.requestCreateRun(
      outsider,
      {
        agentId,
        sessionId: first.sessionId,
        prompt: "steal the session",
        modelProvider: "anthropic-api-key",
      },
      [402, 404],
    );
    expectApiError(crossUser.body);

    await api.requestCancelRun(actor, resumed.runId, [200]);
    await api.requestCancelRun(actor, first.runId, [200]);
    await clearAllDetached();
    const cancelled = await api.readRun(actor, first.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("RUN-01: admission boundaries beyond request validation", () => {
  it("rejects runs for onboarded organizations that never gained an entitlement", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();

    await bdd.setupOnboarding(actor, { displayName: "BDD Suspended Agent" });
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD suspended-org agent",
      description: "Covers the pro-suspend admission branch.",
      visibility: "private",
    });

    const rejected = await api.requestCreateRun(
      actor,
      {
        agentId: agent.agentId,
        prompt: "should be rejected",
        modelProvider: "anthropic-api-key",
      },
      [402],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("queues runs over the concurrency limit and promotes them after cancellation", async () => {
    const api = createRunsSchedulesApi(context);
    const { actor, agentId } = await entitledRunActor();

    const first = await api.createRun(actor, {
      agentId,
      prompt: "active run one",
      modelProvider: "anthropic-api-key",
    });
    expect(first.status).toBe("pending");
    const second = await api.createRun(actor, {
      agentId,
      prompt: "active run two",
      modelProvider: "anthropic-api-key",
    });
    expect(second.status).toBe("pending");

    const third = await api.createRun(actor, {
      agentId,
      prompt: "queued run three",
      modelProvider: "anthropic-api-key",
    });
    expect(third.status).toBe("queued");

    const queued = await api.readRunQueue(actor);
    expect(queued.body.concurrency.active).toBe(2);
    expect(queued.body.queue).toHaveLength(1);
    expect(queued.body.queue[0]?.runId).toBe(third.runId);

    await api.requestCancelRun(actor, first.runId, [200]);
    await clearAllDetached();

    const promoted = await api.readRun(actor, third.runId);
    expect(promoted.status).toBe("pending");
    const drained = await api.readRunQueue(actor);
    expect(drained.body.queue).toHaveLength(0);

    await api.requestCancelRun(actor, second.runId, [200]);
    await api.requestCancelRun(actor, third.runId, [200]);
    await clearAllDetached();
    const emptied = await api.readRunQueue(actor);
    expect(emptied.body.concurrency.active).toBe(0);
  });

  it("removes cancelled runs from the claimable queue", async () => {
    const api = createRunsSchedulesApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "cancel before claim",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, run.runId, [200]);
    await clearAllDetached();

    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(claim.body);

    const missing = await api.requestClaimRunnerJob(true, randomUUID(), [404]);
    expectApiError(missing.body);
  });
});

describe("RUN-03: cancellation of dispatched and terminal runs", () => {
  it("cancels a claimed running run and treats repeat cancellation as settled", async () => {
    const api = createRunsSchedulesApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "cancel while running",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    await api.claimRunnerJob(run.runId);

    const running = await api.readRun(actor, run.runId);
    expect(running.status).toBe("running");

    await api.requestCancelRun(actor, run.runId, [200]);
    await clearAllDetached();
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    const repeated = await api.requestCancelRun(actor, run.runId, [200]);
    expect(repeated.status).toBe(200);
  });
});

describe("RUN-03: user-runner protocol and runner authentication", () => {
  it("dispatches, scopes, and claims runs through user API keys", async () => {
    const api = createRunsSchedulesApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    const apiKey = await api.createApiKey(actor);
    const bearer = `Bearer ${apiKey.token}`;

    const first = await api.createRun(actor, {
      agentId,
      prompt: "user runner job one",
      modelProvider: "anthropic-api-key",
    });
    const polled = await api.requestPollRunnerAs(
      bearer,
      { group: runnerGroup, profiles: ["vm0/default"] },
      [200],
    );
    if (polled.status !== 200) {
      throw new Error("Expected the user runner poll to succeed");
    }
    expect(polled.body.job?.runId).toBe(first.runId);

    const claimed = await api.requestClaimRunnerJobAs(
      bearer,
      first.runId,
      [200],
      {
        telemetry: {
          jobDiscoveredToClaimRequestMs: 1234,
          localAdmissionToClaimRequestMs: 56,
        },
      },
    );
    if (claimed.status !== 200) {
      throw new Error("Expected the user runner claim to succeed");
    }
    expect(claimed.body.prompt).toBe("user runner job one");
    expect(claimed.body.sandboxToken).not.toBe("");
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        expect.objectContaining({
          op_type: "job_discovered_to_claim_request",
          sandbox_type: "runner",
          run_id: first.runId,
          duration_ms: 1234,
          success: true,
          profile: "vm0/default",
          auth_type: "user",
        }),
      ],
    );
    expect(context.mocks.axiom.sdkIngest).toHaveBeenCalledWith(
      "vm0-sandbox-op-log-dev",
      [
        expect.objectContaining({
          op_type: "local_admission_to_claim_request",
          sandbox_type: "runner",
          run_id: first.runId,
          duration_ms: 56,
          success: true,
          profile: "vm0/default",
          auth_type: "user",
        }),
      ],
    );
    const claimedRun = await api.readRun(actor, first.runId);
    expect(claimedRun.status).toBe("running");

    const second = await api.createRun(actor, {
      agentId,
      prompt: "user runner job two",
      modelProvider: "anthropic-api-key",
    });

    const outsider = createBddApi(context).user();
    const outsiderKey = await api.createApiKey(outsider);
    const outsiderBearer = `Bearer ${outsiderKey.token}`;
    const outsiderPoll = await api.requestPollRunnerAs(
      outsiderBearer,
      { group: runnerGroup, profiles: ["vm0/default"] },
      [200],
    );
    if (outsiderPoll.status !== 200) {
      throw new Error("Expected the outsider poll to succeed");
    }
    expect(outsiderPoll.body.job ?? null).toBeNull();
    const crossClaim = await api.requestClaimRunnerJobAs(
      outsiderBearer,
      second.runId,
      [403],
    );
    expectApiError(crossClaim.body);
    expect(crossClaim.body.error.message).toBe("Job does not belong to user");

    const tokenRequest = {
      keyName: "bdd-key",
      timestamp: 1_700_000_000_000,
      capability: `{"runner-group:${runnerGroup}":["subscribe"]}`,
      nonce: "bdd-nonce",
      mac: "bdd-mac",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
    const realtime = await api.requestRunnerRealtimeTokenAs(
      bearer,
      { group: runnerGroup },
      [200],
    );
    expect(realtime.body).toStrictEqual(tokenRequest);
    const deniedRealtime = await api.requestRunnerRealtimeTokenAs(
      bearer,
      { group: "wrong-org/default" },
      [403],
    );
    expectApiError(deniedRealtime.body);
    expect(deniedRealtime.body.error.message).toBe(
      "Only vm0/* runner groups are supported",
    );

    await api.requestCancelRun(actor, first.runId, [200]);
    await api.requestCancelRun(actor, second.runId, [200]);
    await clearAllDetached();
    const settled = await api.readRunQueue(actor);
    expect(settled.body.concurrency.active).toBe(0);
  });

  it("rejects runner calls with malformed, revoked, or wrong runner credentials", async () => {
    const api = createRunsSchedulesApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const pollBody = { group: "vm0/bdd-auth", profiles: ["vm0/default"] };

    const rejectedAuthorizations = [
      "Basic vm0_official_credentials",
      "Bearer not-a-runner-token",
      "Bearer vm0_pat_not-a-valid-jwt",
      "Bearer vm0_official_too-short",
      `Bearer vm0_official_${"f".repeat(64)}`,
    ];
    for (const authorization of rejectedAuthorizations) {
      const poll = await api.requestPollRunnerAs(
        authorization,
        pollBody,
        [401],
      );
      expectApiError(poll.body);
      expect(poll.body.error.message).toBe("Authentication required");
    }

    const apiKey = await api.createApiKey(actor);
    const bearer = `Bearer ${apiKey.token}`;
    await api.requestPollRunnerAs(bearer, pollBody, [200]);

    await api.revokeApiKey(actor, apiKey.id);
    const revokedPoll = await api.requestPollRunnerAs(bearer, pollBody, [401]);
    expectApiError(revokedPoll.body);
    const revokedClaim = await api.requestClaimRunnerJobAs(
      bearer,
      randomUUID(),
      [401],
    );
    expectApiError(revokedClaim.body);
    expect(revokedClaim.body.error.message).toBe("Not authenticated");
    const revokedRealtime = await api.requestRunnerRealtimeTokenAs(
      bearer,
      { group: "vm0/bdd-auth" },
      [401],
    );
    expectApiError(revokedRealtime.body);
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });

  it("drops queued jobs whose runs reached a terminal state before the claim", async () => {
    const api = createRunsSchedulesApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "terminal before claim",
      modelProvider: "anthropic-api-key",
    });
    expect(run.status).toBe("pending");

    const sandboxHeaders = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "sandbox crashed before claim",
        lastEventSequence: 0,
      },
      sandboxHeaders,
      [200],
    );
    await clearAllDetached();
    const failed = await api.readRun(actor, run.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("sandbox crashed before claim");

    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(claim.body);
    expect(claim.body.error.message).toBe("Run not found");

    const reclaim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expectApiError(reclaim.body);
    expect(reclaim.body.error.message).toBe("Job not found in queue");
  });

  it("returns null claim secretValues for direct compose runs without stored secrets", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);

    // A plain compose carries inline environment values but no body, model
    // provider, or connector secrets, so no encrypted secrets map is stored
    // with the queued job.
    const composeName = `bdd-no-secrets-${randomUUID().slice(0, 8)}`;
    const compose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });

    const run = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "claim without stored secrets",
    });
    expect(run.status).toBe("pending");

    const claim = await api.claimRunnerJob(run.runId);
    expect(claim.secretValues).toBeNull();
    expect(claim.prompt).toBe("claim without stored secrets");

    await api.requestCancelRun(actor, run.runId, [200]);
    await clearAllDetached();
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");

    // A compose pinned to a non-vm0 runner group fails dispatch at creation.
    const foreignName = `bdd-foreign-${randomUUID().slice(0, 8)}`;
    const foreignCompose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [foreignName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
          experimental_runner: { group: "other/test" },
        },
      },
    });
    const failedRun = await api.createDirectRun(actor, {
      agentComposeId: foreignCompose.composeId,
      prompt: "dispatch to a foreign runner group",
    });
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toBe("Only vm0/* runner groups are supported");
  });
});

describe("HOOK-01/RUN-03: terminal run callbacks dispatch on cancellation", () => {
  it("delivers, fails, and retries chat run callbacks through cancellation side effects", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const { actor, agentId } = await entitledRunActor();
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bdd-bypass");

    const rejectedDeliveries: {
      readonly body: string;
      readonly signature: string | null;
      readonly timestamp: string | null;
      readonly bypass: string | null;
    }[] = [];
    server.use(
      http.post(CHAT_CALLBACK_URL, async ({ request }) => {
        rejectedDeliveries.push({
          body: await request.text(),
          signature: request.headers.get("x-vm0-signature"),
          timestamp: request.headers.get("x-vm0-timestamp"),
          bypass: request.headers.get("x-vercel-protection-bypass"),
        });
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );

    const first = await sendChatRunMessage(actor, {
      agentId,
      prompt: "first cancellable chat run",
    });
    await api.requestCancelRun(actor, first.runId, [200]);
    await clearAllDetached();

    const firstCancelled = await api.readRun(actor, first.runId);
    expect(firstCancelled.status).toBe("cancelled");
    expect(rejectedDeliveries).toHaveLength(1);
    expect(rejectedDeliveries[0]).toMatchObject({
      signature: expect.stringMatching(/.+/),
      timestamp: expect.stringMatching(/^\d+$/),
      bypass: "bdd-bypass",
    });
    const rejectedBody: unknown = JSON.parse(
      rejectedDeliveries[0]?.body ?? "{}",
    );
    expect(rejectedBody).toMatchObject({
      callbackId: expect.stringMatching(/[0-9a-f-]{36}/),
      runId: first.runId,
      status: "failed",
      error: "Run cancelled",
      payload: { threadId: first.threadId, agentId },
    });

    let unreachableDispatches = 0;
    server.use(
      http.post(CHAT_CALLBACK_URL, () => {
        unreachableDispatches += 1;
        return HttpResponse.error();
      }),
    );

    const second = await sendChatRunMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "second cancellable chat run",
    });
    await api.requestCancelRun(actor, second.runId, [200]);
    await clearAllDetached();

    const secondCancelled = await api.readRun(actor, second.runId);
    expect(secondCancelled.status).toBe("cancelled");
    expect(unreachableDispatches).toBe(1);

    proxyChatCallbackToApp();

    const third = await sendChatRunMessage(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "third cancellable chat run",
    });
    await api.requestCancelRun(actor, third.runId, [200]);
    // The delivered callback acknowledges immediately and persists its chat
    // side effects in a nested detached task, so drain twice.
    await clearAllDetached();
    await clearAllDetached();

    const thirdCancelled = await api.readRun(actor, third.runId);
    expect(thirdCancelled.status).toBe("cancelled");

    const messages = await chat.listThreadMessages(actor, first.threadId);
    const cancelNote = messages.messages.find((message) => {
      return message.role === "assistant" && message.runId === third.runId;
    });
    if (!cancelNote || cancelNote.role !== "assistant") {
      throw new Error(
        "Expected the delivered chat callback to append an assistant message",
      );
    }
    expect(cancelNote.runLifecycleEvent).toBe("cancelled");
    expect(cancelNote.content).toStrictEqual(expect.any(String));
  });
});

describe("HOOK-02: event-consumer dispatch failures", () => {
  it("surfaces required event-consumer failures and recovers on retry", async () => {
    const api = createRunsSchedulesApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "report events",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    context.mocks.axiom.flush.mockResolvedValue(undefined);
    context.mocks.axiom.flush.mockRejectedValueOnce(new Error("axiom down"));
    const failed = await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      sandboxHeaders,
      [500],
    );
    expectApiError(failed.body);
    expect(failed.body.error.message).toContain(
      "Required event consumer dispatch failed",
    );

    const recovered = await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [{ type: "system", sequenceNumber: 1 }],
      },
      sandboxHeaders,
      [200],
    );
    expect(recovered.status).toBe(200);
  });
});

describe("HOOK-02/CHAT-02: assistant events reach optional chat consumers", () => {
  it("persists assistant events into the linked thread and swallows optional consumer failures", async () => {
    const api = createRunsSchedulesApi(context);
    const chat = createChatFilesBddApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();
    proxyChatCallbackToApp();

    const { runId, threadId } = await sendChatRunMessage(actor, {
      agentId,
      prompt: "bdd assistant events",
    });

    const pending = await api.readRun(actor, runId);
    expect(pending.status).toBe("pending");

    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              id: "msg_bdd_1",
              content: [{ type: "text", text: "Hello from BDD events" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );

    const afterFirst = await chat.listThreadMessages(actor, threadId);
    const firstAssistant = afterFirst.messages.find((message) => {
      return message.role === "assistant" && message.runId === runId;
    });
    expect(firstAssistant?.content).toBe("Hello from BDD events");

    context.mocks.ably.publish.mockRejectedValueOnce(
      new Error("chat assistant publish failed"),
    );
    const swallowed = await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 2,
            message: {
              id: "msg_bdd_2",
              content: [{ type: "text", text: "Survives optional failure" }],
            },
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    expect(swallowed.status).toBe(200);

    const afterSecond = await chat.listThreadMessages(actor, threadId);
    const persisted = afterSecond.messages.filter((message) => {
      return message.role === "assistant" && message.runId === runId;
    });
    expect(persisted).toHaveLength(2);
    expect(
      persisted.map((message) => {
        return message.content;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "Hello from BDD events",
        "Survives optional failure",
      ]),
    );

    await api.requestCancelRun(actor, runId, [200]);
    await clearAllDetached();
    const cancelled = await api.readRun(actor, runId);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("BILL-02: usage reads for an entitled organization with runs", () => {
  it("exposes usage runs, members, and processed usage events through public reads", async () => {
    const api = createRunsSchedulesApi(context);
    const billing = createBillingMediaApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const run = await api.createRun(actor, {
      agentId,
      prompt: "generate usage",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };

    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      sandboxHeaders,
      [200],
    );
    await billing.processUsageEvents();

    const usageRuns = await billing.readUsageRuns(actor, [200]);
    if (usageRuns.status !== 200) {
      throw new Error("Expected usage runs read to succeed");
    }
    const listedRun = usageRuns.body.runs.find((entry) => {
      return entry.runId === run.runId;
    });
    expect(listedRun).toBeDefined();
    expect(listedRun?.prompt).toBe("generate usage");
    expect(usageRuns.body.pagination.total).toBeGreaterThanOrEqual(1);

    const members = await billing.readUsageMembers(actor);
    expect(members.body.period).not.toBeNull();

    const record = await billing.readUsageRecord(actor);
    expect(record.status).toBe(200);
  });

  it("aggregates usage members across organization users", async () => {
    const bdd = createBddApi(context);
    const api = createRunsSchedulesApi(context);
    const billing = createBillingMediaApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const { actor, agentId, runnerGroup } = await entitledRunActor();

    const beforeUsage = await billing.readUsageMembers(actor);
    expect(beforeUsage.body.period).not.toBeNull();
    expect(beforeUsage.body.members).toStrictEqual([]);

    const member = bdd.user({ orgId: actor.orgId });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member usage agent",
      visibility: "private",
    });

    const actorRun = await api.createRun(actor, {
      agentId,
      prompt: "actor usage",
      modelProvider: "anthropic-api-key",
    });
    const memberRun = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member usage",
      modelProvider: "anthropic-api-key",
    });

    await api.heartbeatRunner(runnerGroup);
    const actorClaim = await api.claimRunnerJob(actorRun.runId);
    const memberClaim = await api.claimRunnerJob(memberRun.runId);

    await webhooks.requestAgentUsageEvent(
      {
        runId: actorRun.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 1,
          },
        ],
      },
      { authorization: `Bearer ${actorClaim.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentUsageEvent(
      {
        runId: memberRun.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "connector",
            provider: "github",
            category: "api_request",
            quantity: 2,
          },
        ],
      },
      { authorization: `Bearer ${memberClaim.sandboxToken}` },
      [200],
    );
    await billing.processUsageEvents();

    const aggregated = await billing.readUsageMembers(actor);
    expect(aggregated.body.members).toHaveLength(2);
    expect(
      aggregated.body.members.map((entry) => {
        return entry.userId;
      }),
    ).toStrictEqual(expect.arrayContaining([actor.userId, member.userId]));
    for (const entry of aggregated.body.members) {
      expect(entry.email).toStrictEqual(expect.any(String));
      expect(entry.inputTokens).toBe(0);
      expect(entry.outputTokens).toBe(0);
      expect(entry.creditsCharged).toBeGreaterThanOrEqual(0);
    }

    await api.requestCancelRun(actor, actorRun.runId, [200]);
    await api.requestCancelRun(member, memberRun.runId, [200]);
    await clearAllDetached();
    const settled = await api.readRunQueue(actor);
    expect(settled.body.concurrency.active).toBe(0);
  });
});

describe("BILL-01: billing entitlement reconciliation cron", () => {
  function subscriptionEvent(args: {
    readonly subscriptionId: string;
    readonly customerId: string;
    readonly status: string;
    readonly periodEndUnix: number;
  }): unknown {
    return {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: args.subscriptionId,
          status: args.status,
          customer: args.customerId,
          cancel_at: args.periodEndUnix,
          cancel_at_period_end: false,
          schedule: null,
          trial_end: null,
          metadata: {},
          items: {
            data: [
              {
                price: { id: "price_bdd_pro" },
                current_period_end: args.periodEndUnix,
              },
            ],
          },
        },
      },
    };
  }

  async function failSubscription(args: {
    readonly subscriptionId: string;
    readonly customerId: string;
  }): Promise<void> {
    const webhooks = createWebhookCallbackApi(context);
    const event = subscriptionEvent({
      ...args,
      status: "past_due",
      periodEndUnix: Math.floor(now() / 1000) - 2 * 86_400,
    });
    webhooks.configureStripeWebhookSecret();
    webhooks.acceptNextStripeWebhookEvent(event);
    await webhooks.requestStripeWebhook(
      JSON.stringify(event),
      { "stripe-signature": "t=1,v1=bdd" },
      [200],
    );
  }

  it("recovers payment-failed subscriptions that became active again", async () => {
    const api = createRunsSchedulesApi(context);
    const billing = createBillingMediaApi(context);
    const { actor, granted } = await entitledRunActor();
    await failSubscription(granted);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "active",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_bdd_pro" },
            current_period_end: Math.floor(now() / 1000) + 30 * 86_400,
          },
        ],
      },
    });
    const unauthorizedReconcile = await api.reconcileBillingCron(false);
    expect(unauthorizedReconcile.status).toBe(401);
    await api.reconcileBillingCron(true);

    const status = await billing.readBillingStatus(actor);
    expect(status.tier).toBe("pro");

    await failSubscription(granted);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "incomplete",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [] },
    });
    await api.reconcileBillingCron(true);
    const skipped = await billing.readBillingStatus(actor);
    expect(skipped.tier).toBe("pro");
  });

  it("keeps recently paid-through subscriptions and downgrades stale ones", async () => {
    const api = createRunsSchedulesApi(context);
    const billing = createBillingMediaApi(context);
    const { actor, granted } = await entitledRunActor();
    await failSubscription(granted);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "past_due",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_bdd_pro" },
            current_period_end: Math.floor(now() / 1000) + 7 * 86_400,
          },
        ],
      },
    });
    await api.reconcileBillingCron(true);
    const synced = await billing.readBillingStatus(actor);
    expect(synced.tier).toBe("pro");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "past_due",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: "price_bdd_pro" },
            current_period_end: Math.floor(now() / 1000) - 2 * 86_400,
          },
        ],
      },
    });
    await failSubscription(granted);
    await api.reconcileBillingCron(true);

    const downgraded = await billing.readBillingStatus(actor);
    expect(downgraded.tier).not.toBe("pro");
  });

  it("clears cancelled subscriptions during reconciliation", async () => {
    const api = createRunsSchedulesApi(context);
    const billing = createBillingMediaApi(context);
    const { actor, granted } = await entitledRunActor();
    await failSubscription(granted);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: granted.subscriptionId,
      status: "canceled",
      customer: granted.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: { data: [] },
    });
    await api.reconcileBillingCron(true);

    const cleared = await billing.readBillingStatus(actor);
    expect(cleared.tier).not.toBe("pro");
  });
});
