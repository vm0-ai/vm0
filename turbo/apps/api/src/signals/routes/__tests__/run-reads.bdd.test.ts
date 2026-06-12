import { createHash, randomUUID } from "node:crypto";

import { CANONICAL_CLAUDE_MEMORY_MOUNT_PATH } from "@vm0/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { storageTextFile } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  createRunsSchedulesApi,
  uniqueScheduleName,
} from "./helpers/api-bdd-runs-schedules";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

/*
 * RUN-03/RUN-04 read surfaces for agent runs (list/read/queue/cancel,
 * sessions, checkpoints, telemetry families, zero run detail reads, queue
 * position, and zero logs) plus the RUN-01/02 direct-run create arms that
 * end in those reads (checkpoint resume, memory root policies, volume
 * pinning, concurrency caps, and the production capture gate).
 *
 * All state is constructed through public APIs: direct runs via compose
 * create + POST /api/agent/runs, runner claims, and sandbox webhooks
 * (events/checkpoint/complete). Axiom reads are answered by an
 * APL-dispatching mock so the run-event visibility poll is never left
 * unanswered (an unanswered poll burns its 2s timeout per read).
 */

// The sanitizer accepts the literal IANA name; built by parts to satisfy
// unicorn/text-encoding-identifier-case.
const UTF8_ENCODING = ["utf", "8"].join("-");

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsSchedulesApi(context);
const webhooks = createWebhookCallbackApi(context);
const reads = createRunReadsApi(context);

function mustOk<TResponse extends { readonly status: number }>(
  response: TResponse,
  what: string,
): asserts response is Extract<TResponse, { status: 200 }> {
  if (response.status !== 200) {
    throw new Error(`Expected ${what} to succeed`);
  }
}

async function entitledActor(): Promise<ApiTestUser> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  return actor;
}

async function createClaudeCompose(
  actor: ApiTestUser,
  prefix: string,
): Promise<{ readonly composeId: string; readonly name: string }> {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  return await api.createCompose(actor, {
    version: "1",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      },
    },
  });
}

function sandboxHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * Marks a claimed run completed through the sandbox webhooks. Successful
 * completion requires a checkpoint, so one is always posted first.
 */
async function completeRun(
  runId: string,
  sandboxToken: string,
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const headers = sandboxHeaders(sandboxToken);
  await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `bdd-cli-${runId}`,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`bdd run reads history ${runId}`)
        .digest("hex"),
    },
    headers,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      ...(options.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: options.lastEventSequence }),
    },
    headers,
    [200],
  );
}

describe("RUN-03/RUN-04: run read surface auth matrix", () => {
  it("rejects unauthenticated and org-less requests across the run read surfaces", async () => {
    const missingId = randomUUID();
    const NOT_AUTHENTICATED = {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    };

    const unauthenticated = [
      (await reads.requestListAgentRuns(null, {}, [401])).body,
      (await reads.requestReadAgentRun(null, missingId, [401])).body,
      (await reads.requestReadAgentRunQueue(null, [401])).body,
      (await reads.requestCancelAgentRun(null, missingId, [401])).body,
      (await reads.requestReadSession(null, missingId, [401])).body,
      (await reads.requestReadCheckpoint(null, missingId, [401])).body,
      (await reads.requestQueuePosition(null, missingId, [401])).body,
      (await reads.requestRunEvents(null, missingId, {}, [401])).body,
      (await reads.requestRunTelemetry(null, missingId, [401])).body,
      (await reads.requestRunAgentEvents(null, missingId, {}, [401])).body,
      (await reads.requestRunSystemLog(null, missingId, {}, [401])).body,
      (await reads.requestRunMetrics(null, missingId, {}, [401])).body,
      (await reads.requestRunNetworkLogs(null, missingId, {}, [401])).body,
      (await reads.requestZeroRunAgentEvents(null, missingId, {}, [401])).body,
      (await reads.requestZeroRunNetworkLogs(null, missingId, {}, [401])).body,
      (await reads.requestListLogs(null, {}, [401])).body,
      (await reads.requestReadLogById(null, missingId, [401])).body,
    ];
    for (const body of unauthenticated) {
      expect(body).toStrictEqual(NOT_AUTHENTICATED);
    }

    const orgless = bdd.user({ orgId: null });
    const orglessUnauthorized = [
      (await reads.requestListAgentRuns(orgless, {}, [401])).body,
      (await reads.requestReadAgentRunQueue(orgless, [401])).body,
      (await reads.requestCancelAgentRun(orgless, missingId, [401])).body,
      (await reads.requestReadCheckpoint(orgless, missingId, [401])).body,
      (await reads.requestListLogs(orgless, {}, [401])).body,
      (await reads.requestZeroRunAgentEvents(orgless, missingId, {}, [401]))
        .body,
      (await reads.requestZeroRunNetworkLogs(orgless, missingId, {}, [401]))
        .body,
    ];
    for (const body of orglessUnauthorized) {
      expect(body).toStrictEqual(NOT_AUTHENTICATED);
    }

    const orglessSession = await reads.requestReadSession(
      orgless,
      missingId,
      [404],
    );
    expect(orglessSession.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });

    // Telemetry routes require an organization without a custom missing-org
    // status, so org-less sessions fail as 400s.
    const orglessEvents = await reads.requestRunEvents(
      orgless,
      missingId,
      {},
      [400],
    );
    expectApiError(orglessEvents.body);
    expect(orglessEvents.body.error.code).toBe("BAD_REQUEST");

    const orglessTelemetry = await reads.rawApiRequest(
      orgless,
      `/api/agent/runs/${missingId}/telemetry`,
    );
    expect(orglessTelemetry.status).toBe(400);
  });
});

describe("RUN-03/RUN-04: direct run list, detail, and queue reads", () => {
  it("lists, reads, and queues direct runs with status, agent, and window filters", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const target = await createClaudeCompose(actor, "bdd-target");
    const other = await createClaudeCompose(actor, "bdd-other");
    const memberCompose = await createClaudeCompose(member, "bdd-member");

    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD run reads agent",
      description: "Queue privacy and session links.",
      visibility: "private",
    });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member agent",
      description: "Foreign queue entries.",
      visibility: "private",
    });

    // Seed a terminal zero-run session so a later queued run can carry a
    // continuation session link.
    const seedRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "seed a session",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, seedRun.runId, [200]);

    const malformed = await reads.rawCreateDirectRun(actor, {
      agentComposeId: target.composeId,
    });
    expect(malformed.status).toBe(400);

    const runA = await api.createDirectRun(actor, {
      agentComposeId: target.composeId,
      prompt: "target run a",
    });
    const runB = await api.createDirectRun(actor, {
      agentComposeId: other.composeId,
      prompt: "other run b",
    });

    const defaults = await reads.requestListAgentRuns(actor, {}, [200]);
    const defaultPrompts = defaults.body.runs.map((run) => {
      return run.prompt;
    });
    expect(defaultPrompts).toStrictEqual(
      expect.arrayContaining(["target run a", "other run b"]),
    );

    const memberView = await reads.requestListAgentRuns(member, {}, [200]);
    expect(
      memberView.body.runs.map((run) => {
        return run.id;
      }),
    ).not.toContain(runA.runId);

    const invalidStatus = await reads.requestListAgentRuns(
      actor,
      { status: "running,bogus" },
      [400],
    );
    expectApiError(invalidStatus.body);
    expect(invalidStatus.body.error.message).toContain("Invalid status: bogus");

    const invalidSince = await reads.requestListAgentRuns(
      actor,
      { since: "not-a-date" },
      [400],
    );
    expectApiError(invalidSince.body);
    expect(invalidSince.body.error.message).toBe(
      "Invalid since timestamp format",
    );

    const invalidUntil = await reads.requestListAgentRuns(
      actor,
      { until: "not-a-date" },
      [400],
    );
    expectApiError(invalidUntil.body);
    expect(invalidUntil.body.error.message).toBe(
      "Invalid until timestamp format",
    );

    const claimA = await api.claimRunnerJob(runA.runId);
    const claimB = await api.claimRunnerJob(runB.runId);
    await completeRun(runB.runId, claimB.sandboxToken);

    const runningOnly = await reads.requestListAgentRuns(
      actor,
      { status: "running" },
      [200],
    );
    const runningIds = runningOnly.body.runs.map((run) => {
      return run.id;
    });
    expect(runningIds).toContain(runA.runId);
    expect(runningIds).not.toContain(runB.runId);

    const afterComplete = await reads.requestListAgentRuns(actor, {}, [200]);
    expect(
      afterComplete.body.runs.map((run) => {
        return run.prompt;
      }),
    ).not.toContain("other run b");

    const completedByAgent = await reads.requestListAgentRuns(
      actor,
      { status: "completed", agent: other.name, limit: 1 },
      [200],
    );
    expect(completedByAgent.body.runs).toHaveLength(1);
    expect(completedByAgent.body.runs[0]).toMatchObject({
      id: runB.runId,
      agentName: other.name,
      status: "completed",
      prompt: "other run b",
    });
    expect(completedByAgent.body.runs[0]?.startedAt).not.toBeNull();

    const pastWindow = await reads.requestListAgentRuns(
      actor,
      {
        status: "completed",
        agent: other.name,
        until: new Date(now() - 60 * 60_000).toISOString(),
      },
      [200],
    );
    expect(pastWindow.body.runs).toStrictEqual([]);

    const insideWindow = await reads.requestListAgentRuns(
      actor,
      {
        status: "completed",
        agent: other.name,
        since: new Date(now() - 60 * 60_000).toISOString(),
        until: new Date(now() + 60_000).toISOString(),
      },
      [200],
    );
    expect(
      insideWindow.body.runs.map((run) => {
        return run.id;
      }),
    ).toContain(runB.runId);

    const detail = await reads.requestReadAgentRun(actor, runB.runId, [200]);
    expect(detail.body).toMatchObject({
      runId: runB.runId,
      status: "completed",
      prompt: "other run b",
    });
    expect(detail.body.startedAt).toBeDefined();
    expect(detail.body.completedAt).toBeDefined();

    const sandboxDetail = await reads.requestReadAgentRunAs(
      `Bearer ${claimA.sandboxToken}`,
      runB.runId,
      [200],
    );
    expect(sandboxDetail.body).toMatchObject({ runId: runB.runId });

    const invalidId = await reads.requestReadAgentRun(
      actor,
      "not-a-run-id",
      [400],
    );
    expectApiError(invalidId.body);
    expect(invalidId.body.error.code).toBe("BAD_REQUEST");

    const missing = await reads.requestReadAgentRun(actor, randomUUID(), [404]);
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Agent run not found");

    const runM = await api.createDirectRun(member, {
      agentComposeId: memberCompose.composeId,
      prompt: "member run m",
    });
    const hiddenFromActor = await reads.requestReadAgentRun(
      actor,
      runM.runId,
      [404],
    );
    expectApiError(hiddenFromActor.body);
    expect(hiddenFromActor.body.error.message).toBe("Agent run not found");
    const memberDetail = await reads.requestReadAgentRun(
      member,
      runM.runId,
      [200],
    );
    expect(memberDetail.body).toMatchObject({ runId: runM.runId });
    await api.claimRunnerJob(runM.runId);

    // auth-me refreshes the caller's user-cache email, which the queue
    // surfaces for owner entries.
    await bdd.readMe(actor);
    const agentQueue = await reads.requestReadAgentRunQueue(actor, [200]);
    expect(agentQueue.body.concurrency).toMatchObject({
      tier: "pro",
      limit: 2,
      active: 2,
      available: 0,
    });
    expect(agentQueue.body.runningTasks).toHaveLength(2);
    const ownTask = agentQueue.body.runningTasks.find((task) => {
      return task.isOwner;
    });
    expect(ownTask).toMatchObject({
      runId: runA.runId,
      userEmail: actor.email,
      isOwner: true,
    });
    expect(ownTask?.startedAt).not.toBeNull();
    const foreignTask = agentQueue.body.runningTasks.find((task) => {
      return !task.isOwner;
    });
    expect(foreignTask).toMatchObject({
      runId: null,
      userEmail: "unknown",
      isOwner: false,
    });
    expect(agentQueue.body.estimatedTimePerRun).not.toBeNull();

    const longPrompt = "q".repeat(220);
    const queuedOwn = await api.createRun(actor, {
      agentId: agent.agentId,
      sessionId: seedRun.sessionId,
      prompt: longPrompt,
      modelProvider: "anthropic-api-key",
    });
    expect(queuedOwn.status).toBe("queued");
    const queuedForeign = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member queued secret",
      modelProvider: "anthropic-api-key",
    });
    expect(queuedForeign.status).toBe("queued");

    const zeroQueue = await api.readRunQueue(actor);
    expect(zeroQueue.body.queue).toHaveLength(2);
    expect(zeroQueue.body.queue[0]).toMatchObject({
      position: 1,
      isOwner: true,
      runId: queuedOwn.runId,
      prompt: `${"q".repeat(200)}...`,
      userEmail: actor.email,
      sessionLink: `/chat/${seedRun.sessionId}`,
    });
    expect(zeroQueue.body.queue[1]).toMatchObject({
      position: 2,
      isOwner: false,
      runId: null,
      prompt: null,
      agentName: null,
      userEmail: null,
      triggerSource: null,
      sessionLink: null,
    });
    expect(JSON.stringify(zeroQueue.body)).not.toContain(
      "member queued secret",
    );

    await api.requestCancelRun(actor, queuedOwn.runId, [200]);
    await api.requestCancelRun(member, queuedForeign.runId, [200]);
    await api.requestCancelRun(actor, runA.runId, [200]);
    await api.requestCancelRun(member, runM.runId, [200]);

    const drained = await reads.requestReadAgentRunQueue(actor, [200]);
    expect(drained.body.concurrency.active).toBe(0);
    expect(drained.body.queue).toStrictEqual([]);
  });
});

describe("RUN-03: cancel through the agent route", () => {
  it("cancels runs through the agent cancel route across states and tokens", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeCompose(actor, "bdd-cancel");

    const c1 = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "cancel a running run",
    });
    await api.claimRunnerJob(c1.runId);
    const cancelled = await reads.requestCancelAgentRun(actor, c1.runId, [200]);
    expect(cancelled.body).toStrictEqual({
      id: c1.runId,
      status: "cancelled",
      message: "Run cancelled successfully",
    });
    const c1Detail = await api.readRun(actor, c1.runId);
    expect(c1Detail.status).toBe("cancelled");

    const repeated = await reads.requestCancelAgentRun(actor, c1.runId, [200]);
    expect(repeated.body).toMatchObject({ status: "cancelled" });

    const c2 = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "complete then cancel",
    });
    const claim2 = await api.claimRunnerJob(c2.runId);
    await completeRun(c2.runId, claim2.sandboxToken);
    const notCancellable = await reads.requestCancelAgentRun(
      actor,
      c2.runId,
      [400],
    );
    expectApiError(notCancellable.body);
    expect(notCancellable.body.error.code).toBe("RUN_NOT_CANCELLABLE");

    const unknown = await reads.requestCancelAgentRun(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(unknown.body);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const outsider = bdd.user();
    const crossOrg = await reads.requestCancelAgentRun(
      outsider,
      c2.runId,
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    const c3 = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "cancel via the sandbox token",
    });
    const claim3 = await api.claimRunnerJob(c3.runId);
    const sandboxCancelled = await reads.requestCancelAgentRunAs(
      `Bearer ${claim3.sandboxToken}`,
      c3.runId,
      [200],
    );
    expect(sandboxCancelled.body).toMatchObject({ status: "cancelled" });

    const orphanToken = api.sandboxTokenForRun(actor, randomUUID());
    const orphanCancel = await reads.requestCancelAgentRunAs(
      `Bearer ${orphanToken}`,
      c2.runId,
      [404],
    );
    expectApiError(orphanCancel.body);
    expect(orphanCancel.body.error.message).toBe("Agent run not found");

    // A queued zero run cancelled through the agent route disappears from
    // the visible queue.
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD cancel agent",
      description: "Queued cancellation through the agent route.",
      visibility: "private",
    });
    const d1 = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "occupy slot one",
    });
    const d2 = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "occupy slot two",
    });
    const c4 = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "queued run to cancel",
      modelProvider: "anthropic-api-key",
    });
    expect(c4.status).toBe("queued");
    const queuedCancelled = await reads.requestCancelAgentRun(
      actor,
      c4.runId,
      [200],
    );
    expect(queuedCancelled.body).toMatchObject({ status: "cancelled" });
    const queueAfter = await api.readRunQueue(actor);
    expect(queueAfter.body.queue).toStrictEqual([]);

    await api.requestCancelRun(actor, d1.runId, [200]);
    await api.requestCancelRun(actor, d2.runId, [200]);
  });
});

describe("RUN-03: queue position", () => {
  it("reports queue position for queued, running, and foreign runs", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const compose = await createClaudeCompose(actor, "bdd-position");
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD position agent",
      description: "Queue position reads.",
      visibility: "private",
    });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member position agent",
      description: "Foreign queue position reads.",
      visibility: "private",
    });

    const running = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "running run",
    });
    await api.claimRunnerJob(running.runId);
    const pending = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "pending run",
    });
    const queued = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "queued run",
      modelProvider: "anthropic-api-key",
    });
    expect(queued.status).toBe("queued");
    const memberQueued = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member queued run",
      modelProvider: "anthropic-api-key",
    });
    expect(memberQueued.status).toBe("queued");

    const first = await reads.requestQueuePosition(actor, queued.runId, [200]);
    expect(first.body).toStrictEqual({ position: 1, total: 1 });

    const second = await reads.requestQueuePosition(
      member,
      memberQueued.runId,
      [200],
    );
    expect(second.body).toStrictEqual({ position: 2, total: 2 });

    const unqueued = await reads.requestQueuePosition(
      actor,
      running.runId,
      [200],
    );
    expect(unqueued.body).toStrictEqual({ position: 0, total: 0 });

    const foreignUser = await reads.requestQueuePosition(
      actor,
      memberQueued.runId,
      [404],
    );
    expectApiError(foreignUser.body);
    expect(foreignUser.body.error.code).toBe("NOT_FOUND");

    const outsider = bdd.user();
    const foreignOrg = await reads.requestQueuePosition(
      outsider,
      queued.runId,
      [404],
    );
    expectApiError(foreignOrg.body);
    expect(foreignOrg.body.error.code).toBe("NOT_FOUND");

    const unknown = await reads.requestQueuePosition(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(unknown.body);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const missingRunId = await reads.rawApiRequest(
      null,
      "/api/zero/queue-position",
    );
    expect(missingRunId.status).toBe(400);
    expect(JSON.stringify(missingRunId.body)).toContain("runId");

    await api.requestCancelRun(actor, queued.runId, [200]);
    await api.requestCancelRun(member, memberQueued.runId, [200]);
    await api.requestCancelRun(actor, pending.runId, [200]);
    await api.requestCancelRun(actor, running.runId, [200]);
  });
});

describe("RUN-04: session and checkpoint reads", () => {
  it("exposes sessions and checkpoints created through run and webhook flows", async () => {
    const authOrg = createAuthOrgAgentsBddApi(context);
    const actor = await entitledActor();
    await authOrg.setSecret(actor, {
      name: "BDD_RUN_READS_TOKEN",
      value: "bdd-run-reads-secret",
    });

    const secretComposeName = `bdd-session-${randomUUID().slice(0, 8)}`;
    const secretCompose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [secretComposeName]: {
          framework: "claude-code",
          environment: {
            ANTHROPIC_API_KEY: "bdd-inline-key",
            API_TOKEN: `\${{ secrets.BDD_RUN_READS_TOKEN }}`,
          },
        },
      },
      artifacts: [{ name: "bdd-compose-art", mount_path: "/compose-art" }],
    });
    const plainCompose = await createClaudeCompose(actor, "bdd-plain");

    const r1 = await api.createDirectRun(actor, {
      agentComposeId: secretCompose.composeId,
      prompt: "produce a session with artifacts",
      artifacts: [{ name: "bdd-out", mountPath: "/out" }],
    });
    const claim1 = await api.claimRunnerJob(r1.runId);
    const outArtifact = claim1.storageManifest?.artifacts.find((artifact) => {
      return artifact.vasStorageName === "bdd-out";
    });
    if (!outArtifact) {
      throw new Error("Expected the claim manifest to mount bdd-out");
    }

    const headers1 = sandboxHeaders(claim1.sandboxToken);
    const withArtifacts = await webhooks.requestAgentCheckpoint(
      {
        runId: r1.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${r1.runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd session checkpoint ${r1.runId}`)
          .digest("hex"),
        artifactSnapshots: [
          {
            name: "bdd-out",
            version: outArtifact.vasVersionId,
            mountPath: "/out",
          },
        ],
        volumeVersionsSnapshot: { versions: { data: "vol-v1" } },
      },
      headers1,
      [200],
    );
    if (withArtifacts.status !== 200) {
      throw new Error("Expected the artifact checkpoint webhook to succeed");
    }
    await webhooks.requestAgentComplete(
      { runId: r1.runId, exitCode: 0 },
      headers1,
      [200],
    );

    const completed = await api.readRun(actor, r1.runId);
    expect(completed.status).toBe("completed");
    expect(completed.result?.checkpointId).toBeDefined();

    const session = await reads.requestReadSession(actor, r1.sessionId, [200]);
    expect(session.body).toMatchObject({
      id: r1.sessionId,
      agentComposeId: secretCompose.composeId,
      secretNames: ["BDD_RUN_READS_TOKEN"],
    });
    if (session.status !== 200) {
      throw new Error("Expected the session read to succeed");
    }
    expect([...session.body.artifactNames].sort()).toStrictEqual([
      "bdd-compose-art",
      "bdd-out",
      "memory",
    ]);
    expect(session.body.conversationId).not.toBeNull();

    const r2 = await api.createDirectRun(actor, {
      agentComposeId: plainCompose.composeId,
      prompt: "plain session without secret references",
    });
    const plainSession = await reads.requestReadSession(
      actor,
      r2.sessionId,
      [200],
    );
    if (plainSession.status !== 200) {
      throw new Error("Expected the plain session read to succeed");
    }
    expect(plainSession.body.secretNames).toBeNull();
    expect(plainSession.body.artifactNames).toContain("memory");

    // Checkpoints upsert one row per run, so the no-artifact projection
    // needs its own run.
    const withoutArtifacts = await webhooks.requestAgentCheckpoint(
      {
        runId: r2.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${r2.runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd empty checkpoint ${r2.runId}`)
          .digest("hex"),
      },
      sandboxHeaders(api.sandboxTokenForRun(actor, r2.runId)),
      [200],
    );
    if (withoutArtifacts.status !== 200) {
      throw new Error("Expected the bare checkpoint webhook to succeed");
    }
    await api.requestCancelRun(actor, r2.runId, [200]);

    const missingSession = await reads.requestReadSession(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.message).toBe("Session not found");

    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const memberSession = await reads.requestReadSession(
      member,
      r1.sessionId,
      [403],
    );
    expect(memberSession.body).toStrictEqual({
      error: {
        message: "You do not have permission to access this session",
        code: "FORBIDDEN",
      },
    });

    const sameUserOtherOrg = bdd.user({ userId: actor.userId });
    const crossOrgSession = await reads.requestReadSession(
      sameUserOtherOrg,
      r1.sessionId,
      [404],
    );
    expectApiError(crossOrgSession.body);
    expect(crossOrgSession.body.error.message).toBe("Session not found");

    const checkpoint = await reads.requestReadCheckpoint(
      actor,
      withArtifacts.body.checkpointId,
      [200],
    );
    expect(checkpoint.body).toMatchObject({
      id: withArtifacts.body.checkpointId,
      runId: r1.runId,
      artifactSnapshots: { "bdd-out": outArtifact.vasVersionId },
      volumeVersionsSnapshot: { versions: { data: "vol-v1" } },
    });
    if (checkpoint.status !== 200) {
      throw new Error("Expected the checkpoint read to succeed");
    }
    expect(checkpoint.body.agentComposeSnapshot.agentComposeVersionId).toMatch(
      /[0-9a-f-]{36}/,
    );
    expect(checkpoint.body.agentComposeSnapshot.secretNames).toContain(
      "BDD_RUN_READS_TOKEN",
    );
    expect(checkpoint.body.conversationId).not.toBeNull();

    const bareCheckpoint = await reads.requestReadCheckpoint(
      actor,
      withoutArtifacts.body.checkpointId,
      [200],
    );
    if (bareCheckpoint.status !== 200) {
      throw new Error("Expected the bare checkpoint read to succeed");
    }
    expect(bareCheckpoint.body.artifactSnapshots).toBeNull();

    const missingCheckpoint = await reads.requestReadCheckpoint(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(missingCheckpoint.body);
    expect(missingCheckpoint.body.error.message).toBe("Checkpoint not found");

    const memberCheckpoint = await reads.requestReadCheckpoint(
      member,
      withArtifacts.body.checkpointId,
      [404],
    );
    expectApiError(memberCheckpoint.body);
    expect(memberCheckpoint.body.error.code).toBe("NOT_FOUND");

    const crossOrgCheckpoint = await reads.requestReadCheckpoint(
      sameUserOtherOrg,
      withArtifacts.body.checkpointId,
      [404],
    );
    expectApiError(crossOrgCheckpoint.body);
    expect(crossOrgCheckpoint.body.error.code).toBe("NOT_FOUND");
  });
});

describe("RUN-01/RUN-02: checkpoint resume, memory policies, and volume pinning", () => {
  it("restores volumes, memory, and conversation state when resuming checkpoints", async () => {
    const storages = createStoragesBddApi(context);
    const actor = await entitledActor();
    storages.mockStoragePresignedUrls();
    storages.mockStorageObjectsExist();

    const volumeName = `bdd-vol-${randomUUID().slice(0, 8)}`;
    const volumeFile = storageTextFile("data/cache.txt", "bdd volume payload");
    const prepared = await storages.prepareStorage(actor, {
      storageName: volumeName,
      storageType: "volume",
      files: [volumeFile],
    });
    const volumeVersion = prepared.versionId;
    await storages.commitStorage(actor, {
      storageName: volumeName,
      storageType: "volume",
      versionId: volumeVersion,
      files: [volumeFile],
    });

    const composeName = `bdd-resume-${randomUUID().slice(0, 8)}`;
    const compose = await api.createCompose(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
          volumes: ["data:/data"],
        },
      },
      volumes: {
        data: { name: volumeName, version: `\${{ vars.VOL_VERSION }}` },
      },
    });

    // The session-history blob for checkpointed conversations is hash-only
    // in R2 — answer the GetObject for it while keeping other s3 sends inert.
    const history = '{"type":"init"}\n{"type":"human","text":"hi"}\n';
    const historyHash = createHash("sha256").update(history).digest("hex");
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = (command as { readonly input?: { readonly Key?: string } })
        .input;
      if (input?.Key === `blobs/${historyHash}.blob`) {
        return Promise.resolve({
          Body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(history, "utf8");
            },
          },
        });
      }
      return Promise.resolve({});
    });

    const versionPrefix = volumeVersion.slice(0, 16);
    const r1 = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "pin the volume by version prefix",
      vars: { VOL_VERSION: versionPrefix },
      artifacts: [
        { name: "memory", mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH },
      ],
    });
    const claim1 = await api.claimRunnerJob(r1.runId);
    expect(claim1.storageManifest?.storages).toMatchObject([
      { name: "data", mountPath: "/data", vasVersionId: volumeVersion },
    ]);
    const memory1 = claim1.storageManifest?.artifacts.find((artifact) => {
      return artifact.vasStorageName === "memory";
    });
    expect(memory1).toMatchObject({
      mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
      missingRootPolicy: "preserveParentVersion",
    });
    if (!memory1) {
      throw new Error("Expected the claim manifest to mount memory");
    }

    const headers1 = sandboxHeaders(claim1.sandboxToken);
    const checkpointed = await webhooks.requestAgentCheckpoint(
      {
        runId: r1.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${r1.runId}`,
        cliAgentSessionHistoryHash: historyHash,
        artifactSnapshots: [
          {
            name: "memory",
            version: memory1.vasVersionId,
            mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
          },
        ],
        volumeVersionsSnapshot: { versions: { data: volumeVersion } },
      },
      headers1,
      [200],
    );
    if (checkpointed.status !== 200) {
      throw new Error("Expected the resume checkpoint webhook to succeed");
    }
    const checkpointId = checkpointed.body.checkpointId;
    await webhooks.requestAgentComplete(
      { runId: r1.runId, exitCode: 0 },
      headers1,
      [200],
    );

    const resumed = await api.createDirectRun(actor, {
      checkpointId,
      prompt: "resume from the checkpoint",
    });
    const claim2 = await api.claimRunnerJob(resumed.runId);
    expect(claim2.checkpointId).toBe(checkpointId);
    expect(claim2.vars).toStrictEqual({ VOL_VERSION: versionPrefix });
    expect(claim2.resumeSession).toStrictEqual({
      sessionId: `bdd-cli-${r1.runId}`,
      sessionHistory: history,
    });
    expect(claim2.storageManifest?.storages).toMatchObject([
      { name: "data", vasVersionId: volumeVersion },
    ]);
    const memory2 = claim2.storageManifest?.artifacts.find((artifact) => {
      return artifact.vasStorageName === "memory";
    });
    expect(memory2).toMatchObject({
      mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
      missingRootPolicy: "preserveParentVersion",
    });
    // A checkpoint without volume or artifact snapshots still resumes.
    const bareCheckpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: resumed.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${resumed.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      sandboxHeaders(claim2.sandboxToken),
      [200],
    );
    if (bareCheckpoint.status !== 200) {
      throw new Error("Expected the bare resume checkpoint to succeed");
    }
    await api.requestCancelRun(actor, resumed.runId, [200]);

    const bareResume = await api.createDirectRun(actor, {
      checkpointId: bareCheckpoint.body.checkpointId,
      prompt: "resume without snapshots",
    });
    await api.requestCancelRun(actor, bareResume.runId, [200]);

    const bothIds = await reads.requestCreateDirectRun(
      actor,
      {
        checkpointId,
        sessionId: r1.sessionId,
        prompt: "ambiguous resume",
      },
      [400],
    );
    expectApiError(bothIds.body);
    expect(bothIds.body.error.message).toContain(
      "both checkpointId and sessionId",
    );

    if (!claim1.agentComposeVersionId) {
      throw new Error("Expected the claim to carry a compose version id");
    }
    const byVersion = await reads.requestCreateDirectRun(
      actor,
      {
        agentComposeVersionId: claim1.agentComposeVersionId,
        prompt: "run a pinned compose version",
        vars: { VOL_VERSION: volumeVersion },
      },
      [201],
    );
    if (byVersion.status !== 201) {
      throw new Error("Expected the version-pinned run create to succeed");
    }
    await api.requestCancelRun(actor, byVersion.body.runId, [200]);

    const strictMemory = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "user-authored memory stays strict",
      vars: { VOL_VERSION: volumeVersion },
      artifacts: [{ name: "memory", mountPath: "/mnt/user-memory" }],
    });
    const strictClaim = await api.claimRunnerJob(strictMemory.runId);
    expect(
      strictClaim.storageManifest?.artifacts.map((artifact) => {
        return {
          name: artifact.vasStorageName,
          mountPath: artifact.mountPath,
          missingRootPolicy: artifact.missingRootPolicy,
        };
      }),
    ).toStrictEqual([
      {
        name: "memory",
        mountPath: "/mnt/user-memory",
        missingRootPolicy: undefined,
      },
    ]);
    await api.requestCancelRun(actor, strictMemory.runId, [200]);

    const customCanonical = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "custom artifact claims the canonical memory mount",
      vars: { VOL_VERSION: volumeVersion },
      artifacts: [
        {
          name: "custom-memory",
          mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        },
      ],
    });
    const customClaim = await api.claimRunnerJob(customCanonical.runId);
    expect(
      customClaim.storageManifest?.artifacts.map((artifact) => {
        return {
          name: artifact.vasStorageName,
          mountPath: artifact.mountPath,
          missingRootPolicy: artifact.missingRootPolicy,
        };
      }),
    ).toStrictEqual([
      {
        name: "custom-memory",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        missingRootPolicy: undefined,
      },
    ]);
    await api.requestCancelRun(actor, customCanonical.runId, [200]);

    const continued = await api.createDirectRun(actor, {
      sessionId: r1.sessionId,
      prompt: "continue the checkpointed session",
    });
    expect(continued.sessionId).toBe(r1.sessionId);
    const continuedClaim = await api.claimRunnerJob(continued.runId);
    expect(continuedClaim.resumeSession).toStrictEqual({
      sessionId: `bdd-cli-${r1.runId}`,
      sessionHistory: history,
    });
    const continuedMemory = continuedClaim.storageManifest?.artifacts.find(
      (artifact) => {
        return artifact.vasStorageName === "memory";
      },
    );
    expect(continuedMemory).toMatchObject({
      mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
      missingRootPolicy: "preserveParentVersion",
    });
    await api.requestCancelRun(actor, continued.runId, [200]);
  });
});

describe("RUN-01: direct run admission boundaries", () => {
  it("enforces direct-run concurrency, caps, and the production capture gate", async () => {
    const actor = await entitledActor();
    const compose = await createClaudeCompose(actor, "bdd-admission");

    const first = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "first concurrent run",
    });
    const second = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "second concurrent run",
    });
    const limited = await reads.requestCreateDirectRun(
      actor,
      { agentComposeId: compose.composeId, prompt: "third concurrent run" },
      [429],
    );
    expectApiError(limited.body);
    expect(limited.body.error.code).toBe("CONCURRENT_RUN_LIMIT");

    const outsider = bdd.user();
    const foreignCompose = await createClaudeCompose(outsider, "bdd-foreign");
    const crossOrgCompose = await reads.requestCreateDirectRun(
      actor,
      {
        agentComposeId: foreignCompose.composeId,
        prompt: "run a foreign compose",
      },
      [404],
    );
    expectApiError(crossOrgCompose.body);
    expect(crossOrgCompose.body.error.message).toBe("Resource not found");

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const uncapped = await reads.requestCreateDirectRun(
      actor,
      { agentComposeId: compose.composeId, prompt: "uncapped third run" },
      [201],
    );
    if (uncapped.status !== 201) {
      throw new Error("Expected the uncapped run create to succeed");
    }
    await api.requestCancelRun(actor, uncapped.body.runId, [200]);
    await api.requestCancelRun(actor, first.runId, [200]);
    await api.requestCancelRun(actor, second.runId, [200]);

    mockEnv("ENV", "production");
    const uncachedGate = await reads.requestCreateDirectRun(
      actor,
      {
        agentComposeId: compose.composeId,
        prompt: "capture without a cached email",
        captureNetworkBodies: true,
      },
      [403],
    );
    expectApiError(uncachedGate.body);
    expect(uncachedGate.body.error.message).toContain("internal accounts");

    // auth-me caches the caller email; a non-vm0 address still fails the gate.
    await bdd.readMe(actor);
    const externalGate = await reads.requestCreateDirectRun(
      actor,
      {
        agentComposeId: compose.composeId,
        prompt: "capture with an external email",
        captureNetworkBodies: true,
      },
      [403],
    );
    expectApiError(externalGate.body);
    expect(externalGate.body.error.message).toContain("internal accounts");

    const internal = bdd.user({
      orgId: actor.orgId,
      email: `bdd-${randomUUID().slice(0, 8)}@vm0.ai`,
    });
    await bdd.readMe(internal);
    const allowed = await reads.requestCreateDirectRun(
      internal,
      {
        agentComposeId: compose.composeId,
        prompt: "capture from an internal account",
        captureNetworkBodies: true,
      },
      [201],
    );
    if (allowed.status !== 201) {
      throw new Error("Expected the internal capture run create to succeed");
    }
    const captureClaim = await api.claimRunnerJob(allowed.body.runId);
    expect(captureClaim.captureNetworkBodies).toBeTruthy();
    await api.requestCancelRun(internal, allowed.body.runId, [200]);
  });
});

interface AxiomQueryRows {
  readonly visibility?: readonly Record<string, unknown>[];
  readonly events?: readonly Record<string, unknown>[];
  readonly systemLogs?: readonly Record<string, unknown>[];
  readonly metrics?: readonly Record<string, unknown>[];
  readonly network?: readonly Record<string, unknown>[];
  readonly runContext?: readonly Record<string, unknown>[];
}

/**
 * Answers every Axiom query by APL shape and runId. The visibility poll
 * (`| project sequenceNumber`) MUST be matched before the events dataset:
 * leaving it unanswered burns the 2s watermark timeout on every read of a
 * run with a non-null lastEventSequence.
 */
function dispatchAxiomQueries(
  rowsByRun: Readonly<Record<string, AxiomQueryRows>>,
): void {
  context.mocks.axiom.query.mockImplementation((apl: unknown) => {
    if (typeof apl !== "string") {
      return Promise.resolve([]);
    }
    const runId = Object.keys(rowsByRun).find((id) => {
      return apl.includes(id);
    });
    const rows = runId === undefined ? undefined : rowsByRun[runId];
    if (!rows) {
      return Promise.resolve([]);
    }
    if (apl.includes("| project sequenceNumber")) {
      return Promise.resolve([...(rows.visibility ?? [])]);
    }
    if (apl.includes("['agent-run-events']")) {
      return Promise.resolve([...(rows.events ?? [])]);
    }
    if (apl.includes("['sandbox-telemetry-system']")) {
      return Promise.resolve([...(rows.systemLogs ?? [])]);
    }
    if (apl.includes("['sandbox-telemetry-metrics']")) {
      return Promise.resolve([...(rows.metrics ?? [])]);
    }
    if (apl.includes("['sandbox-telemetry-network']")) {
      return Promise.resolve([...(rows.network ?? [])]);
    }
    if (apl.includes("['run-context']")) {
      return Promise.resolve([...(rows.runContext ?? [])]);
    }
    return Promise.resolve([]);
  });
}

function axiomCallCount(): number {
  return context.mocks.axiom.query.mock.calls.length;
}

function axiomCallAt(index: number): readonly unknown[] {
  const call = context.mocks.axiom.query.mock.calls[index];
  if (!call) {
    throw new Error(`Expected an Axiom query call at index ${index}`);
  }
  return call;
}

function agentEvent(
  runId: string,
  sequenceNumber: number,
  text: string,
  timestamp = "2026-06-10T10:30:00Z",
): Record<string, unknown> {
  return {
    _time: timestamp,
    runId,
    userId: "bdd-run-reads",
    sequenceNumber,
    eventType: "assistant",
    eventData: { type: "assistant", text },
  };
}

describe("RUN-04: agent run telemetry families", () => {
  it("serves run events and telemetry families from axiom with watermark waits", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const compose = await createClaudeCompose(actor, "bdd-telemetry");

    const completedRun = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "emit telemetry",
    });
    const claim = await api.claimRunnerJob(completedRun.runId);
    await completeRun(completedRun.runId, claim.sandboxToken, {
      lastEventSequence: 2,
    });
    const pendingRun = await api.createDirectRun(actor, {
      agentComposeId: compose.composeId,
      prompt: "never claimed",
    });

    const runId = completedRun.runId;
    dispatchAxiomQueries({
      [runId]: {
        visibility: [
          { sequenceNumber: 0 },
          { sequenceNumber: 1 },
          { sequenceNumber: 2 },
        ],
        events: [
          agentEvent(runId, 0, "first"),
          agentEvent(runId, 1, "second"),
          agentEvent(runId, 3, "gapped"),
        ],
        systemLogs: [
          { _time: "2026-06-10T10:30:00Z", runId, log: "boot\n" },
          { _time: "2026-06-10T10:31:00Z", runId, log: "ready\n" },
        ],
        metrics: [
          {
            _time: "2026-06-10T10:30:00Z",
            runId,
            userId: actor.userId,
            cpu: 0.4,
            mem_used: 40,
            mem_total: 100,
            disk_used: 50,
            disk_total: 200,
          },
          {
            _time: "2026-06-10T10:31:00Z",
            runId,
            userId: actor.userId,
            cpu: 0.5,
            mem_used: 41,
            mem_total: 100,
            disk_used: 51,
            disk_total: 200,
          },
        ],
        network: [
          {
            _time: "2026-06-10T10:30:00Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "example.com",
            port: 443,
            method: "GET",
            url: "https://example.com/",
            status: 200,
            latency_ms: 12,
            request_size: 10,
            response_size: 20,
            browser_user_agent: true,
            dns_event: "resolve",
            dns_query_type: "A",
            dns_result: "1.2.3.4",
            dns_serial: "dns-1",
            firewall_base: "base",
            firewall_name: "net",
            firewall_permission: "github:read",
            firewall_rule_match: "allow",
            firewall_params: { owner: "vm0-ai", empty: null },
            firewall_billable: true,
            firewall_error: "none",
            auth_resolved_secrets: ["TOKEN"],
            auth_refreshed_connectors: ["github"],
            auth_refreshed_secrets: ["TOKEN"],
            auth_cache_hit: false,
            auth_url_rewrite: true,
            request_headers: { host: "example.com", authorization: null },
            request_body: "abc",
            request_body_encoding: "base64",
            request_body_truncated: false,
            response_headers: { server: "test", date: null },
            response_body: "def",
            response_body_encoding: "base64",
            response_body_truncated: false,
          },
          {
            _time: "2026-06-10T10:31:00Z",
            runId,
            userId: actor.userId,
            type: "tcp",
            action: null,
            host: null,
            port: 0,
            method: null,
            url: null,
            status: 0,
            latency_ms: 0,
            request_size: null,
            response_size: null,
            firewall_params: null,
            auth_resolved_secrets: null,
            error: null,
          },
        ],
      },
    });

    // Watermark wait: gap-filtered consecutive events with noCache reads.
    const eventsStart = axiomCallCount();
    const events = await reads.requestRunEvents(
      actor,
      runId,
      { since: -1, limit: 10 },
      [200],
    );
    if (events.status !== 200) {
      throw new Error("Expected the run events read to succeed");
    }
    expect(events.body.events).toStrictEqual([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { type: "assistant", text: "first" },
        createdAt: "2026-06-10T10:30:00Z",
      },
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: { type: "assistant", text: "second" },
        createdAt: "2026-06-10T10:30:00Z",
      },
    ]);
    expect(events.body.hasMore).toBeTruthy();
    expect(events.body.nextSequence).toBe(1);
    expect(events.body.framework).toBe("claude-code");
    expect(events.body.run).toMatchObject({
      status: "completed",
      lastEventSequence: 2,
    });
    expect(axiomCallCount()).toBe(eventsStart + 2);
    const visibilityCall = axiomCallAt(eventsStart);
    expect(visibilityCall[0]).toContain("| project sequenceNumber");
    expect(visibilityCall[1]).toStrictEqual({ noCache: true });
    const eventsCall = axiomCallAt(eventsStart + 1);
    expect(eventsCall[0]).toContain(`runId == "${runId}"`);
    expect(eventsCall[1]).toStrictEqual({ noCache: true });

    // A cursor at or past the watermark skips the visibility wait.
    const pastWatermarkStart = axiomCallCount();
    const pastWatermark = await reads.requestRunEvents(
      actor,
      runId,
      { since: 2, limit: 10 },
      [200],
    );
    if (pastWatermark.status !== 200) {
      throw new Error("Expected the past-watermark events read to succeed");
    }
    expect(
      pastWatermark.body.events.map((event) => {
        return event.sequenceNumber;
      }),
    ).toStrictEqual([3]);
    expect(axiomCallCount()).toBe(pastWatermarkStart + 1);
    expect(axiomCallAt(pastWatermarkStart)[1]).toBeUndefined();

    // The page limit caps the watermark target below lastEventSequence.
    const cappedStart = axiomCallCount();
    await reads.requestRunEvents(actor, runId, { since: -1, limit: 2 }, [200]);
    expect(axiomCallCount()).toBe(cappedStart + 2);

    // Pending runs without a watermark never poll visibility.
    const pendingStart = axiomCallCount();
    const pendingEvents = await reads.requestRunEvents(
      actor,
      pendingRun.runId,
      {},
      [200],
    );
    if (pendingEvents.status !== 200) {
      throw new Error("Expected the pending run events read to succeed");
    }
    expect(pendingEvents.body.events).toStrictEqual([]);
    expect(pendingEvents.body.nextSequence).toBe(-1);
    expect(pendingEvents.body.run.status).toBe("pending");
    expect(axiomCallCount()).toBe(pendingStart + 1);
    expect(axiomCallAt(pendingStart)[1]).toBeUndefined();

    // Sandbox tokens read the telemetry families without a Zero capability.
    const sandboxEvents = await reads.requestRunEventsAs(
      `Bearer ${claim.sandboxToken}`,
      runId,
      { since: -1, limit: 10 },
      [200],
    );
    expect(sandboxEvents.body).toMatchObject({ hasMore: true });

    // Legacy combined telemetry stays empty without Postgres rows.
    const combined = await reads.requestRunTelemetry(actor, runId, [200]);
    expect(combined.body).toStrictEqual({ systemLog: "", metrics: [] });

    // Paged agent events: asc with since, then desc past the watermark.
    const ascStart = axiomCallCount();
    const ascEvents = await reads.requestRunAgentEvents(
      actor,
      runId,
      { since: 0, limit: 2, order: "asc" },
      [200],
    );
    if (ascEvents.status !== 200) {
      throw new Error("Expected the asc agent events read to succeed");
    }
    expect(ascEvents.body.events).toHaveLength(2);
    expect(ascEvents.body.hasMore).toBeTruthy();
    expect(ascEvents.body.framework).toBe("claude-code");
    expect(axiomCallCount()).toBe(ascStart + 2);
    const ascApl = axiomCallAt(ascStart + 1)[0];
    expect(ascApl).toContain("| where sequenceNumber > 0");
    expect(ascApl).toContain("| order by sequenceNumber asc");

    const descStart = axiomCallCount();
    const descEvents = await reads.requestRunAgentEvents(
      actor,
      runId,
      { since: 5, limit: 5, order: "desc" },
      [200],
    );
    if (descEvents.status !== 200) {
      throw new Error("Expected the desc agent events read to succeed");
    }
    expect(descEvents.body.hasMore).toBeFalsy();
    expect(axiomCallCount()).toBe(descStart + 1);
    expect(axiomCallAt(descStart)[1]).toBeUndefined();

    // System log pages.
    const sinceMs = Date.parse("2026-06-10T10:29:00Z");
    const systemAsc = await reads.requestRunSystemLog(
      actor,
      runId,
      { limit: 1, order: "asc", since: sinceMs },
      [200],
    );
    expect(systemAsc.body).toStrictEqual({
      systemLog: "boot\n",
      hasMore: true,
    });
    const systemApl = axiomCallAt(axiomCallCount() - 1)[0];
    expect(systemApl).toContain("sandbox-telemetry-system");
    expect(systemApl).toContain(new Date(sinceMs).toISOString());
    expect(systemApl).toContain("| order by _time asc");

    const systemEmpty = await reads.requestRunSystemLog(
      actor,
      pendingRun.runId,
      { limit: 10, order: "desc" },
      [200],
    );
    expect(systemEmpty.body).toStrictEqual({ systemLog: "", hasMore: false });

    const invalidSystemQuery = await reads.rawApiRequest(
      actor,
      `/api/agent/runs/${runId}/telemetry/system-log?limit=101`,
    );
    expect(invalidSystemQuery.status).toBe(400);

    // Metric pages.
    const metricsPage = await reads.requestRunMetrics(
      actor,
      runId,
      { limit: 1, order: "desc", since: sinceMs },
      [200],
    );
    expect(metricsPage.body).toStrictEqual({
      metrics: [
        {
          ts: "2026-06-10T10:30:00Z",
          cpu: 0.4,
          mem_used: 40,
          mem_total: 100,
          disk_used: 50,
          disk_total: 200,
        },
      ],
      hasMore: true,
    });
    const metricsApl = axiomCallAt(axiomCallCount() - 1)[0];
    expect(metricsApl).toContain("sandbox-telemetry-metrics");
    expect(metricsApl).toContain("| order by _time desc");

    // Network pages with capture fields and sparse-null omission.
    const networkPage = await reads.requestRunNetworkLogs(
      actor,
      runId,
      { limit: 10, order: "desc" },
      [200],
    );
    if (networkPage.status !== 200) {
      throw new Error("Expected the network log read to succeed");
    }
    expect(networkPage.body.hasMore).toBeFalsy();
    expect(networkPage.body.networkLogs[0]).toMatchObject({
      timestamp: "2026-06-10T10:30:00Z",
      action: "ALLOW",
      host: "example.com",
      browser_user_agent: true,
      dns_result: "1.2.3.4",
      firewall_params: { owner: "vm0-ai" },
      request_headers: { host: "example.com" },
      request_body: "abc",
      response_headers: { server: "test" },
      response_body: "def",
    });
    expect(networkPage.body.networkLogs[1]).toStrictEqual({
      timestamp: "2026-06-10T10:31:00Z",
      type: "tcp",
      port: 0,
      status: 0,
      latency_ms: 0,
    });

    // Telemetry families hide other users' runs without leaking existence.
    const memberEvents = await reads.requestRunEvents(member, runId, {}, [404]);
    expectApiError(memberEvents.body);
    expect(memberEvents.body.error.message).toBe("Agent run not found");
    const memberSystem = await reads.requestRunSystemLog(
      member,
      runId,
      {},
      [404],
    );
    expectApiError(memberSystem.body);
    const memberTelemetry = await reads.requestRunTelemetry(
      member,
      runId,
      [404],
    );
    expectApiError(memberTelemetry.body);

    await api.requestCancelRun(actor, pendingRun.runId, [200]);
  });

  it("maps zero run context, network, events, and runner metadata from axiom snapshots", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD zero detail agent",
      description: "Zero run detail reads.",
      visibility: "private",
    });

    const zeroRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "zero run detail",
      modelProvider: "anthropic-api-key",
    });
    const claim = await api.claimRunnerJob(zeroRun.runId);
    const headers = sandboxHeaders(claim.sandboxToken);
    await webhooks.requestAgentCheckpoint(
      {
        runId: zeroRun.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${zeroRun.runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`bdd zero detail ${zeroRun.runId}`)
          .digest("hex"),
      },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: zeroRun.runId,
        exitCode: 0,
        lastEventSequence: 1,
        sandboxReuseResult: "reused",
      },
      headers,
      [200],
    );

    const bareRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "zero run without snapshots",
      modelProvider: "anthropic-api-key",
    });

    const runId = zeroRun.runId;
    dispatchAxiomQueries({
      [runId]: {
        visibility: [{ sequenceNumber: 0 }, { sequenceNumber: 1 }],
        events: [
          agentEvent(runId, 0, "zero one"),
          agentEvent(runId, 1, "zero two"),
        ],
        network: [
          {
            _time: "2026-06-10T11:00:00Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "api.example.com",
            port: 443,
            method: "GET",
            url: "https://api.example.com/data",
            status: 200,
            latency_ms: 150,
            request_size: 100,
            response_size: 2048,
            firewall_params: { owner: "vm0-ai", broken: 5 },
            request_headers: { accept: "application/json", junk: 9 },
            request_body: "req",
            request_body_encoding: UTF8_ENCODING,
            request_body_truncated: false,
            response_body: "cmVz",
            response_body_encoding: "base64",
            response_body_truncated: true,
          },
          {
            _time: "2026-06-10T11:00:01Z",
            runId,
            userId: actor.userId,
            type: "tcp",
            action: "MAYBE",
            host: "redis.example.com",
            port: 6379,
            request_body_encoding: "weird",
            auth_cache_hit: null,
          },
          {
            _time: "2026-06-10T11:00:02Z",
            runId,
            userId: actor.userId,
            type: "dns",
            host: "api.github.com",
            port: 53,
            dns_event: "reply",
            dns_result: "140.82.121.4",
            dns_serial: "42",
          },
        ],
        runContext: [
          {
            runId,
            sessionId: "bdd-session-1",
            environment: { LEGACY_IGNORED: "legacy-map" },
            environmentEntries: [
              { name: "NODE_ENV", value: "production" },
              { name: "EMPTY", value: null },
              { name: "NUM", value: 5 },
              { value: "missing-name" },
            ],
            firewalls: [
              {
                name: "test-fw",
                apis: [
                  {
                    base: "https://api.example.com",
                    permissions: [{ name: "read", rules: ["GET /users/*"] }],
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "data",
                mountPath: "/data",
                vasStorageName: "vol-1",
                vasVersionId: "ver-1",
              },
            ],
            artifact: {
              mountPath: "/artifacts",
              vasStorageName: "art-1",
              vasVersionId: "art-ver-1",
            },
            featureFlags: { legacyIgnored: true },
            featureFlagEntries: [
              { name: "computerUse", enabled: true },
              { name: "dummy", enabled: null },
              { enabled: true },
            ],
            networkPolicies: {
              legacyIgnored: {
                allow: ["legacy"],
                deny: [],
                ask: [],
                unknownPolicy: "deny",
              },
            },
            networkPolicyEntries: [
              {
                name: "github",
                policy: {
                  allow: ["repo-read"],
                  deny: [],
                  ask: [],
                  unknownPolicy: "allow",
                },
              },
              { name: "broken", policy: "nope" },
              { name: "invalid", policy: { unknownPolicy: "bogus" } },
              {
                policy: {
                  allow: ["missing-name"],
                  deny: [],
                  ask: [],
                  unknownPolicy: "allow",
                },
              },
            ],
          },
        ],
      },
    });

    const contextRead = await api.requestRunContext(actor, runId, [200]);
    if (contextRead.status !== 200) {
      throw new Error("Expected the run context read to succeed");
    }
    expect(contextRead.body).toMatchObject({
      runId,
      prompt: "zero run detail",
      sessionId: "bdd-session-1",
      environment: { NODE_ENV: "production" },
      networkPolicies: {
        github: {
          allow: ["repo-read"],
          deny: [],
          ask: [],
          unknownPolicy: "allow",
        },
      },
      featureFlags: { computerUse: true },
      artifact: { vasStorageName: "art-1" },
    });
    expect(contextRead.body.environment).toStrictEqual({
      NODE_ENV: "production",
    });
    expect(Object.keys(contextRead.body.networkPolicies ?? {})).toStrictEqual([
      "github",
    ]);
    expect(contextRead.body.firewalls).toHaveLength(1);
    expect(contextRead.body.volumes).toHaveLength(1);

    // Sparse snapshots drop non-string and null values entirely.
    dispatchAxiomQueries({ [runId]: { runContext: [{ runId }] } });
    const sparseContext = await api.requestRunContext(actor, runId, [200]);
    if (sparseContext.status !== 200) {
      throw new Error("Expected the sparse run context read to succeed");
    }
    expect(sparseContext.body).toMatchObject({
      runId,
      sessionId: null,
      environment: {},
      networkPolicies: null,
      featureFlags: null,
      firewalls: [],
      volumes: [],
      artifact: null,
    });

    const noSnapshot = await api.requestRunContext(actor, bareRun.runId, [404]);
    expectApiError(noSnapshot.body);
    expect(noSnapshot.body.error.message).toBe("Run context not available");

    // Re-dispatch the full row set for the network and event reads.
    dispatchAxiomQueries({
      [runId]: {
        visibility: [{ sequenceNumber: 0 }, { sequenceNumber: 1 }],
        events: [
          agentEvent(runId, 0, "zero one"),
          agentEvent(runId, 1, "zero two"),
        ],
        network: [
          {
            _time: "2026-06-10T11:00:00Z",
            runId,
            userId: actor.userId,
            type: "http",
            action: "ALLOW",
            host: "api.example.com",
            port: 443,
            method: "GET",
            url: "https://api.example.com/data",
            status: 200,
            latency_ms: 150,
            request_size: 100,
            response_size: 2048,
            firewall_params: { owner: "vm0-ai", broken: 5 },
            request_headers: { accept: "application/json", junk: 9 },
            request_body: "req",
            request_body_encoding: UTF8_ENCODING,
            request_body_truncated: false,
            response_body: "cmVz",
            response_body_encoding: "base64",
            response_body_truncated: true,
          },
          {
            _time: "2026-06-10T11:00:01Z",
            runId,
            userId: actor.userId,
            type: "tcp",
            action: "MAYBE",
            host: "redis.example.com",
            port: 6379,
            request_body_encoding: "weird",
            auth_cache_hit: null,
          },
          {
            _time: "2026-06-10T11:00:02Z",
            runId,
            userId: actor.userId,
            type: "dns",
            host: "api.github.com",
            port: 53,
            dns_event: "reply",
            dns_result: "140.82.121.4",
            dns_serial: "42",
          },
        ],
      },
    });

    const network = await reads.requestZeroRunNetworkLogs(
      actor,
      runId,
      {},
      [200],
    );
    if (network.status !== 200) {
      throw new Error("Expected the zero network log read to succeed");
    }
    expect(network.body.networkLogs).toHaveLength(3);
    expect(network.body.hasMore).toBeFalsy();
    expect(network.body.networkLogs[0]).toStrictEqual({
      timestamp: "2026-06-10T11:00:00Z",
      type: "http",
      action: "ALLOW",
      host: "api.example.com",
      port: 443,
      method: "GET",
      url: "https://api.example.com/data",
      status: 200,
      latency_ms: 150,
      request_size: 100,
      response_size: 2048,
      firewall_params: { owner: "vm0-ai" },
      request_headers: { accept: "application/json" },
      request_body: "req",
      request_body_encoding: UTF8_ENCODING,
      request_body_truncated: false,
      response_body: "cmVz",
      response_body_encoding: "base64",
      response_body_truncated: true,
    });
    expect(network.body.networkLogs[1]).toStrictEqual({
      timestamp: "2026-06-10T11:00:01Z",
      type: "tcp",
      host: "redis.example.com",
      port: 6379,
    });
    expect(network.body.networkLogs[2]).toMatchObject({
      type: "dns",
      dns_event: "reply",
      dns_result: "140.82.121.4",
      dns_serial: "42",
    });

    const sinceMs = Date.parse("2026-06-10T10:59:00Z");
    const pagedNetwork = await reads.requestZeroRunNetworkLogs(
      actor,
      runId,
      { limit: 2, since: sinceMs },
      [200],
    );
    if (pagedNetwork.status !== 200) {
      throw new Error("Expected the paged zero network log read to succeed");
    }
    expect(pagedNetwork.body.networkLogs).toHaveLength(2);
    expect(pagedNetwork.body.hasMore).toBeTruthy();
    const networkApl = axiomCallAt(axiomCallCount() - 1)[0];
    expect(networkApl).toContain(new Date(sinceMs).toISOString());

    const emptyNetwork = await reads.requestZeroRunNetworkLogs(
      actor,
      bareRun.runId,
      {},
      [200],
    );
    if (emptyNetwork.status !== 200) {
      throw new Error("Expected the empty zero network log read to succeed");
    }
    expect(emptyNetwork.body).toStrictEqual({
      networkLogs: [],
      hasMore: false,
    });

    // Zero agent events: desc waits for the watermark, a cursor at the
    // watermark skips the wait, and asc pages cap the target.
    const descStart = axiomCallCount();
    const descEvents = await reads.requestZeroRunAgentEvents(
      actor,
      runId,
      { limit: 10, order: "desc" },
      [200],
    );
    if (descEvents.status !== 200) {
      throw new Error("Expected the zero desc events read to succeed");
    }
    expect(descEvents.body.events).toHaveLength(2);
    expect(descEvents.body.hasMore).toBeFalsy();
    expect(descEvents.body.framework).toBe("claude-code");
    expect(axiomCallCount()).toBe(descStart + 2);
    expect(axiomCallAt(descStart)[0]).toContain("| project sequenceNumber");
    expect(axiomCallAt(descStart)[1]).toStrictEqual({ noCache: true });
    expect(axiomCallAt(descStart + 1)[1]).toStrictEqual({ noCache: true });

    const skipStart = axiomCallCount();
    await reads.requestZeroRunAgentEvents(
      actor,
      runId,
      { limit: 10, order: "desc", since: 5 },
      [200],
    );
    expect(axiomCallCount()).toBe(skipStart + 1);
    expect(axiomCallAt(skipStart)[1]).toBeUndefined();

    const ascPage = await reads.requestZeroRunAgentEvents(
      actor,
      runId,
      { limit: 1, order: "asc", since: 0 },
      [200],
    );
    if (ascPage.status !== 200) {
      throw new Error("Expected the zero asc events read to succeed");
    }
    expect(ascPage.body.events).toHaveLength(1);
    expect(ascPage.body.hasMore).toBeTruthy();

    const memberEvents = await reads.requestZeroRunAgentEvents(
      member,
      runId,
      { limit: 10, order: "desc" },
      [404],
    );
    expectApiError(memberEvents.body);
    expect(memberEvents.body.error.message).toBe("Agent run not found");

    const memberNetwork = await reads.requestZeroRunNetworkLogs(
      member,
      runId,
      {},
      [404],
    );
    expectApiError(memberNetwork.body);
    expect(memberNetwork.body.error.message).toBe("Agent run not found");

    // A run without a recorded watermark reads events without any wait.
    const noWatermarkStart = axiomCallCount();
    const noWatermark = await reads.requestZeroRunAgentEvents(
      actor,
      bareRun.runId,
      { limit: 10, order: "desc" },
      [200],
    );
    if (noWatermark.status !== 200) {
      throw new Error("Expected the watermark-less events read to succeed");
    }
    expect(noWatermark.body.events).toStrictEqual([]);
    expect(axiomCallCount()).toBe(noWatermarkStart + 1);
    expect(axiomCallAt(noWatermarkStart)[1]).toBeUndefined();

    // Runner metadata mirrors the sandbox reuse outcome from completion.
    const runner = await api.requestRunRunner(actor, runId, [200]);
    expect(runner.body).toStrictEqual({ sandboxReuseResult: "reused" });
    const bareRunner = await api.requestRunRunner(actor, bareRun.runId, [200]);
    expect(bareRunner.body).toStrictEqual({ sandboxReuseResult: null });

    await api.requestCancelRun(actor, bareRun.runId, [200]);
  });
});

/**
 * Quiet capture handlers for every callback URL a schedule-fired run can
 * carry, so cancelling the run-now run never hits an unhandled MSW route
 * (same pattern as runs-schedules.bdd.test.ts).
 */
function captureScheduleRunCallbacks(): void {
  webhooks.captureInternalCallbackDeliveries(
    "/api/internal/callbacks/schedule/loop",
  );
  webhooks.captureInternalCallbackDeliveries(
    "/api/internal/callbacks/schedule/cron",
  );
  webhooks.captureInternalCallbackDeliveries("/api/internal/callbacks/chat");
  webhooks.captureInternalCallbackDeliveries(
    "/api/internal/callbacks/trigger/loop",
  );
  webhooks.captureInternalCallbackDeliveries(
    "/api/internal/callbacks/trigger/cron",
  );
}

async function expectSingleLogSourceMatch(args: {
  readonly actor: ApiTestUser;
  readonly triggerSource: "schedule" | "automation";
  readonly runId: string;
}): Promise<void> {
  const response = await reads.requestListLogs(
    args.actor,
    { triggerSource: args.triggerSource },
    [200],
  );
  mustOk(response, `${args.triggerSource}-source log list`);
  expect(
    response.body.data.map((entry) => {
      return entry.id;
    }),
  ).toStrictEqual([args.runId]);
}

describe("RUN-04/OPS-01: zero run logs", () => {
  it("lists run logs with filters, paging, zero tokens, and detail residue", async () => {
    const actor = await entitledActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    await api.ensureOrgModelProvider(actor);
    const agentOne = await bdd.createAgent(actor, {
      displayName: "BDD logs agent one",
      description: "Primary logs agent.",
      visibility: "private",
    });
    const agentTwo = await bdd.createAgent(actor, {
      displayName: "BDD logs agent two",
      description: "Secondary logs agent.",
      visibility: "private",
    });
    const memberAgent = await bdd.createAgent(member, {
      displayName: "BDD member logs agent",
      description: "Member isolation.",
      visibility: "private",
    });
    const cliCompose = await createClaudeCompose(actor, "bdd-cli-logs");
    const authOrg = createAuthOrgAgentsBddApi(context);
    const agentOneName = (
      await authOrg.readComposeById(actor, agentOne.agentId)
    ).name;
    captureScheduleRunCallbacks();

    const webRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "web run on agent one",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, webRun.runId, [200]);
    const secondAgentRun = await api.createRun(actor, {
      agentId: agentTwo.agentId,
      prompt: "web run on agent two",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, secondAgentRun.runId, [200]);
    const cliRun = await api.createDirectRun(actor, {
      agentComposeId: cliCompose.composeId,
      prompt: "direct cli run",
    });
    await api.requestCancelRun(actor, cliRun.runId, [200]);

    // A far-future yearly cron keeps the global execute-schedules sweep from
    // ever considering this schedule due; only run-now fires it.
    const schedule = await api.deploySchedule(actor, {
      name: uniqueScheduleName("bdd-log-sched"),
      agentId: agentOne.agentId,
      cronExpression: "0 0 1 1 *",
      prompt: "scheduled run for logs",
      description: "Schedule-source log entries",
      timezone: "UTC",
      enabled: true,
    });
    const scheduleRun = await api.runScheduleNow(
      actor,
      schedule.schedule.id,
      [201],
    );
    if (scheduleRun.status !== 201) {
      throw new Error("Expected the run-now schedule run to be created");
    }
    await api.requestCancelRun(actor, scheduleRun.body.runId, [200]);

    const memberRun = await api.createRun(member, {
      agentId: memberAgent.agentId,
      prompt: "member run stays invisible",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(member, memberRun.runId, [200]);

    const listed = await reads.requestListLogs(actor, {}, [200]);
    mustOk(listed, "the logs list");
    const listedIds = listed.body.data.map((entry) => {
      return entry.id;
    });
    expect([...listedIds].sort()).toStrictEqual(
      [
        webRun.runId,
        secondAgentRun.runId,
        cliRun.runId,
        scheduleRun.body.runId,
      ].sort(),
    );
    const webEntry = listed.body.data.find((entry) => {
      return entry.id === webRun.runId;
    });
    expect(webEntry).toMatchObject({
      agentId: agentOne.agentId,
      displayName: "BDD logs agent one",
      framework: "claude-code",
      triggerSource: "web",
      scheduleId: null,
      status: "cancelled",
      prompt: "web run on agent one",
    });
    const cliEntry = listed.body.data.find((entry) => {
      return entry.id === cliRun.runId;
    });
    expect(cliEntry).toMatchObject({
      agentId: null,
      displayName: null,
      triggerSource: "cli",
      scheduleId: null,
    });
    const scheduleEntry = listed.body.data.find((entry) => {
      return entry.id === scheduleRun.body.runId;
    });
    expect(scheduleEntry).toMatchObject({
      triggerSource: "automation",
      scheduleId: schedule.schedule.id,
    });

    const pageOne = await reads.requestListLogs(actor, { limit: 1 }, [200]);
    if (pageOne.status !== 200) {
      throw new Error("Expected the first log page to succeed");
    }
    expect(pageOne.body.data).toHaveLength(1);
    expect(pageOne.body.pagination.hasMore).toBeTruthy();
    const cursor = pageOne.body.pagination.nextCursor;
    if (cursor === null) {
      throw new Error("Expected a next cursor on the first log page");
    }
    const pageTwo = await reads.requestListLogs(
      actor,
      { limit: 1, cursor },
      [200],
    );
    if (pageTwo.status !== 200) {
      throw new Error("Expected the second log page to succeed");
    }
    expect(pageTwo.body.data).toHaveLength(1);
    expect(pageTwo.body.data[0]?.id).not.toBe(pageOne.body.data[0]?.id);

    const malformedCursor = await reads.requestListLogs(
      actor,
      { limit: 1, cursor: "garbage" },
      [200],
    );
    if (malformedCursor.status !== 200) {
      throw new Error("Expected the malformed-cursor list to succeed");
    }
    expect(malformedCursor.body.data[0]?.id).toBe(pageOne.body.data[0]?.id);

    const agentOneRunIds = [webRun.runId, scheduleRun.body.runId].sort();
    const fuzzy = await reads.requestListLogs(
      actor,
      { search: agentOneName.toUpperCase() },
      [200],
    );
    if (fuzzy.status !== 200) {
      throw new Error("Expected the fuzzy search list to succeed");
    }
    expect(
      fuzzy.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(agentOneRunIds);

    const byName = await reads.requestListLogs(
      actor,
      { name: agentOneName },
      [200],
    );
    if (byName.status !== 200) {
      throw new Error("Expected the name-filtered list to succeed");
    }
    expect(
      byName.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(agentOneRunIds);

    const byAgentId = await reads.requestListLogs(
      actor,
      { agentId: agentOne.agentId, search: "zzz-no-such-agent" },
      [200],
    );
    if (byAgentId.status !== 200) {
      throw new Error("Expected the agent-id list to succeed");
    }
    expect(
      byAgentId.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual(agentOneRunIds);

    const byStatusAndSource = await reads.requestListLogs(
      actor,
      { status: "cancelled", triggerSource: "web" },
      [200],
    );
    if (byStatusAndSource.status !== 200) {
      throw new Error("Expected the status+source list to succeed");
    }
    expect(
      byStatusAndSource.body.data
        .map((entry) => {
          return entry.id;
        })
        .sort(),
    ).toStrictEqual([webRun.runId, secondAgentRun.runId].sort());

    await expectSingleLogSourceMatch({
      actor,
      triggerSource: "schedule",
      runId: scheduleRun.body.runId,
    });
    await expectSingleLogSourceMatch({
      actor,
      triggerSource: "automation",
      runId: scheduleRun.body.runId,
    });

    const noSourceMatch = await reads.requestListLogs(
      actor,
      { triggerSource: "telegram" },
      [200],
    );
    if (noSourceMatch.status !== 200) {
      throw new Error("Expected the empty source list to succeed");
    }
    expect(noSourceMatch.body.data).toStrictEqual([]);

    const byScheduleId = await reads.requestListLogs(
      actor,
      { scheduleId: schedule.schedule.id, limit: 1 },
      [200],
    );
    if (byScheduleId.status !== 200) {
      throw new Error("Expected the schedule-filtered list to succeed");
    }
    expect(byScheduleId.body.data).toStrictEqual([
      expect.objectContaining({ id: scheduleRun.body.runId }),
    ]);
    expect(byScheduleId.body.pagination.totalPages).toBe(1);

    expect(listed.body.filters.statuses).toContain("cancelled");
    expect([...listed.body.filters.sources].sort()).toStrictEqual([
      "automation",
      "cli",
      "web",
    ]);
    expect(listed.body.filters.agents).toContain(agentOne.agentId);
    expect(listed.body.filters.agents).toContain(agentTwo.agentId);

    // Detail residue: schedule provenance, pending nulls, and failure error.
    const scheduleDetail = await reads.requestReadLogById(
      actor,
      scheduleRun.body.runId,
      [200],
    );
    expect(scheduleDetail.body).toMatchObject({
      id: scheduleRun.body.runId,
      triggerSource: "automation",
      scheduleId: schedule.schedule.id,
    });

    const pendingRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "pending detail run",
      modelProvider: "anthropic-api-key",
    });
    const pendingDetail = await reads.requestReadLogById(
      actor,
      pendingRun.runId,
      [200],
    );
    expect(pendingDetail.body).toMatchObject({
      id: pendingRun.runId,
      status: "pending",
      sessionId: null,
      completedAt: null,
    });
    await api.requestCancelRun(actor, pendingRun.runId, [200]);

    const failedRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "failed detail run",
      modelProvider: "anthropic-api-key",
    });
    await webhooks.requestAgentComplete(
      { runId: failedRun.runId, exitCode: 1, error: "bdd failure" },
      sandboxHeaders(api.sandboxTokenForRun(actor, failedRun.runId)),
      [200],
    );
    const failedDetail = await reads.requestReadLogById(
      actor,
      failedRun.runId,
      [200],
    );
    expect(failedDetail.body).toMatchObject({
      id: failedRun.runId,
      status: "failed",
      error: "bdd failure",
    });

    // A claimed run's real zero token reads the log surfaces by capability.
    const tokenRun = await api.createRun(actor, {
      agentId: agentOne.agentId,
      prompt: "zero token run",
      modelProvider: "anthropic-api-key",
    });
    const tokenClaim = await api.claimRunnerJob(tokenRun.runId);
    const zeroToken = tokenClaim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error("Expected the claimed run to expose a ZERO_TOKEN");
    }
    const tokenList = await reads.requestListLogsAs(
      `Bearer ${zeroToken}`,
      {},
      [200],
    );
    if (tokenList.status !== 200) {
      throw new Error("Expected the zero-token log list to succeed");
    }
    expect(
      tokenList.body.data.map((entry) => {
        return entry.id;
      }),
    ).toContain(webRun.runId);
    const tokenDetail = await reads.requestReadLogByIdAs(
      `Bearer ${zeroToken}`,
      webRun.runId,
      [200],
    );
    expect(tokenDetail.body).toMatchObject({ id: webRun.runId });

    await api.requestCancelRun(actor, tokenRun.runId, [200]);
  });

  it("splits multi-run log searches into a bounded run-id filter", async () => {
    const misc = createMiscRoutesApi(context);
    const actor = await entitledActor();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD search agent",
      description: "Multi-run search chunking.",
      visibility: "private",
    });

    const firstRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "first searchable run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, firstRun.runId, [200]);
    const secondRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "second searchable run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, secondRun.runId, [200]);

    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      if (typeof apl === "string" && apl.includes("runId in (")) {
        return Promise.resolve([
          agentEvent(secondRun.runId, 7, "chunked match"),
        ]);
      }
      return Promise.resolve([]);
    });

    const searched = await misc.searchLogs(actor, "chunked");
    expect(searched.body.results).toHaveLength(1);
    expect(searched.body.results[0]?.runId).toBe(secondRun.runId);

    const searchApl = context.mocks.axiom.query.mock.calls.at(-1)?.[0];
    if (typeof searchApl !== "string") {
      throw new Error("Expected the search to query Axiom with an APL string");
    }
    expect(searchApl).toContain("runId in (");
    expect(searchApl).toContain(firstRun.runId);
    expect(searchApl).toContain(secondRun.runId);
  });
});
