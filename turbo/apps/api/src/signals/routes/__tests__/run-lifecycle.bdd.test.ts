import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { nowDate } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { clearAllDetached } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
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
}> {
  const bdd = createBddApi(context);
  const api = createRunsSchedulesApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD lifecycle agent",
    description: "Exercises the full run lifecycle.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup };
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
});
