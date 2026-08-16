import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  holdAgentDeletionRowLockFixture,
  holdAgentRunInsertFixture,
  holdAgentRunLocksFixture,
  holdAgentRunPromotionFixture,
  holdAgentSessionInsertFixture,
  holdAgentVersionInsertFixture,
  holdChatThreadThenSessionFixture,
  holdUsageEventMutationFixture,
  readAgentLifecycleCountsFixture,
  readAgentLifecycleIdsFixture,
  readDatabaseLockTimeoutFixture,
  readUsageEventRunIdFixture,
  referenceAgentHeadFixture,
  referenceAgentRunVersionFixture,
  removeAgentLegacyVersionsFixture,
  setAgentLifecycleOrgFixture,
  setAgentRunStatusFixture,
} from "../../../test-fixtures/agent-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  insertUsageEvent$,
  materializeHourlyUsage$,
  readUsageStorageCounts$,
  seedChatThread$,
} from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const storages = createStoragesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

interface HeldBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
}

function registerHeldBoundary(boundary: HeldBoundary): void {
  onTestFinished(async () => {
    boundary.release();
    await boundary.done;
  });
}

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

async function createAgent(
  actor: ApiTestUser,
  displayName: string,
): Promise<{ readonly agentId: string }> {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, { displayName });
}

async function prepareRunCreation(
  ...actors: readonly ApiTestUser[]
): Promise<void> {
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  for (const actor of actors) {
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
  }
}

async function pointTargetAtSurvivorVersion(args: {
  readonly targetAgentId: string;
  readonly targetRunIds: readonly string[];
  readonly survivorAgentId: string;
}): Promise<string> {
  const versionId = await referenceAgentHeadFixture({
    agentId: args.targetAgentId,
    versionAgentId: args.survivorAgentId,
  });
  for (const runId of args.targetRunIds) {
    await referenceAgentRunVersionFixture({
      runId,
      versionAgentId: args.survivorAgentId,
    });
  }
  await removeAgentLegacyVersionsFixture(args.targetAgentId);
  return versionId;
}

function expectRetryConflict(response: {
  readonly status: number;
  readonly body: unknown;
}): void {
  expect(response.status).toBe(409);
  expect(response.body).toStrictEqual({
    error: {
      message: "Cannot delete agent right now; retry shortly",
      code: "CONFLICT",
    },
  });
}

async function expectCheckpointSucceeds(
  actor: ApiTestUser,
  runId: string,
): Promise<void> {
  const response = await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `agent-delete-${runId}`,
      cliAgentSessionHistoryDisposition: "unavailable",
    },
    { authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}` },
    [200],
  );
  expect(response.status).toBe(200);
}

describe("DELETE /api/zero/agents/:id bounded deletion interlock", () => {
  it("vetoes a target-owned legacy version without invalidating a shared Run", async () => {
    const actor = bdd.user();
    await prepareRunCreation(actor);
    const target = await createAgent(actor, "Legacy Version Target");
    const survivor = await createAgent(actor, "Independent Head Survivor");
    const targetHistoricalRun = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "retain target lifecycle on veto",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, targetHistoricalRun.runId, [200]);
    const survivorRun = await api.createRun(actor, {
      agentId: survivor.agentId,
      prompt: "retain shared provenance",
      modelProvider: "anthropic-api-key",
    });
    const survivorHistoricalRun = await api.createRun(actor, {
      agentId: survivor.agentId,
      prompt: "retain historical shared provenance",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, survivorHistoricalRun.runId, [200]);
    const targetVersionId = await referenceAgentRunVersionFixture({
      runId: survivorRun.runId,
      versionAgentId: target.agentId,
    });
    await referenceAgentRunVersionFixture({
      runId: survivorHistoricalRun.runId,
      versionAgentId: target.agentId,
    });
    const usageEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: orgIdOf(actor),
        userId: actor.userId,
        runId: targetHistoricalRun.runId,
        status: "pending",
        creditsCharged: 2,
      },
      context.signal,
    );
    const volumesBefore = await storages.listStorages(actor, "organization");
    const lockTimeoutBefore = await readDatabaseLockTimeoutFixture();
    context.mocks.s3.send.mockClear();

    const response = await bdd.requestDeleteAgent(actor, target.agentId, [409]);

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Cannot delete agent while its configuration is being migrated",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    await expect(bdd.readAgent(actor, target.agentId)).resolves.toMatchObject({
      agentId: target.agentId,
    });
    await expect(
      readAgentLifecycleCountsFixture(target.agentId),
    ).resolves.toStrictEqual({ agents: 1, sessions: 1, runs: 1 });
    await expect(
      api.readRun(actor, targetHistoricalRun.runId),
    ).resolves.toMatchObject({
      runId: targetHistoricalRun.runId,
      agentComposeVersionId: targetVersionId,
    });
    await expect(bdd.readAgent(actor, survivor.agentId)).resolves.toMatchObject(
      { agentId: survivor.agentId },
    );
    await expect(api.readRun(actor, survivorRun.runId)).resolves.toMatchObject({
      runId: survivorRun.runId,
      agentComposeVersionId: targetVersionId,
      status: "pending",
    });
    await expect(
      api.readRun(actor, survivorHistoricalRun.runId),
    ).resolves.toMatchObject({
      runId: survivorHistoricalRun.runId,
      agentComposeVersionId: targetVersionId,
    });
    await expectCheckpointSucceeds(actor, survivorRun.runId);
    await expect(readUsageEventRunIdFixture(usageEventId)).resolves.toBe(
      targetHistoricalRun.runId,
    );
    await expect(
      storages.listStorages(actor, "organization"),
    ).resolves.toStrictEqual(volumesBefore);
    await expect(readDatabaseLockTimeoutFixture()).resolves.toBe(
      lockTimeoutBefore,
    );
    await api.requestCancelRun(actor, survivorRun.runId, [200]);
  });

  it("detects an active target Run through its Session instead of its version", async () => {
    const actor = bdd.user();
    await prepareRunCreation(actor);
    const survivor = await createAgent(actor, "Active Version Survivor");
    const target = await createAgent(actor, "Active Session Target");
    const targetRun = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "block target deletion",
      modelProvider: "anthropic-api-key",
    });
    const versionId = await pointTargetAtSurvivorVersion({
      targetAgentId: target.agentId,
      targetRunIds: [targetRun.runId],
      survivorAgentId: survivor.agentId,
    });

    const response = await bdd.requestDeleteAgent(actor, target.agentId, [409]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });
    await expect(api.readRun(actor, targetRun.runId)).resolves.toMatchObject({
      runId: targetRun.runId,
      agentComposeVersionId: versionId,
      status: "pending",
    });
    await expect(bdd.readAgent(actor, target.agentId)).resolves.toMatchObject({
      agentId: target.agentId,
    });
    await api.requestCancelRun(actor, targetRun.runId, [200]);
  });

  it("cascades queued and terminal target Runs while preserving cross-org provenance and billing", async () => {
    const targetOwner = bdd.user();
    const survivorOwner = bdd.user();
    await prepareRunCreation(targetOwner, survivorOwner);
    const survivor = await createAgent(
      survivorOwner,
      "Cross Org Version Survivor",
    );
    const target = await createAgent(targetOwner, "Terminal Cleanup Target");
    const survivorRun = await api.createRun(survivorOwner, {
      agentId: survivor.agentId,
      prompt: "survive another org deletion",
      modelProvider: "anthropic-api-key",
    });
    const terminalRun = await api.createRun(targetOwner, {
      agentId: target.agentId,
      prompt: "terminal target Run",
      modelProvider: "anthropic-api-key",
    });
    const queuedRun = await api.createRun(targetOwner, {
      agentId: target.agentId,
      prompt: "queued target Run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(targetOwner, terminalRun.runId, [200]);
    await flushWaitUntilForTest();
    await setAgentRunStatusFixture(queuedRun.runId, "queued");
    const survivorVersionId = await pointTargetAtSurvivorVersion({
      targetAgentId: target.agentId,
      targetRunIds: [terminalRun.runId, queuedRun.runId],
      survivorAgentId: survivor.agentId,
    });
    const orgId = orgIdOf(targetOwner);
    const pendingUsageId = await store.set(
      insertUsageEvent$,
      {
        orgId,
        userId: targetOwner.userId,
        runId: terminalRun.runId,
        status: "pending",
        creditsCharged: 3,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId,
        userId: targetOwner.userId,
        runId: terminalRun.runId,
        status: "processed",
        creditsCharged: 5,
      },
      context.signal,
    );
    await expect(
      store.set(
        materializeHourlyUsage$,
        { orgId, userId: targetOwner.userId, runId: terminalRun.runId },
        context.signal,
      ),
    ).resolves.toBe(1);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });

    await bdd.deleteVersionFreeAgent(targetOwner, target.agentId);

    await expect(
      bdd.requestReadAgent(targetOwner, target.agentId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      api.requestReadRun(targetOwner, terminalRun.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      api.requestReadRun(targetOwner, queuedRun.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      readAgentLifecycleCountsFixture(target.agentId),
    ).resolves.toStrictEqual({ agents: 0, sessions: 0, runs: 0 });
    await expect(
      bdd.readAgent(survivorOwner, survivor.agentId),
    ).resolves.toMatchObject({ agentId: survivor.agentId });
    await expect(
      api.readRun(survivorOwner, survivorRun.runId),
    ).resolves.toMatchObject({
      runId: survivorRun.runId,
      agentComposeVersionId: survivorVersionId,
      status: "pending",
    });
    await expectCheckpointSucceeds(survivorOwner, survivorRun.runId);
    await expect(
      readUsageEventRunIdFixture(pendingUsageId),
    ).resolves.toBeNull();
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });
    await api.requestCancelRun(survivorOwner, survivorRun.runId, [200]);
  });

  it.each(["session", "run"] as const)(
    "fails closed when a target %s carries another org identity",
    async (kind) => {
      const actor = bdd.user();
      await prepareRunCreation(actor);
      const survivor = await createAgent(actor, `Org ${kind} Survivor`);
      const target = await createAgent(actor, `Org ${kind} Target`);
      const run = await api.createRun(actor, {
        agentId: target.agentId,
        prompt: `corrupt ${kind} org identity`,
        modelProvider: "anthropic-api-key",
      });
      await api.requestCancelRun(actor, run.runId, [200]);
      await pointTargetAtSurvivorVersion({
        targetAgentId: target.agentId,
        targetRunIds: [run.runId],
        survivorAgentId: survivor.agentId,
      });
      const lifecycle = await readAgentLifecycleIdsFixture(target.agentId);
      const id =
        kind === "session" ? lifecycle.sessionIds[0] : lifecycle.runIds[0];
      if (!id) {
        throw new Error(`Expected a target ${kind}`);
      }
      await setAgentLifecycleOrgFixture({
        kind,
        id,
        orgId: `org_corrupt_${randomUUID()}`,
      });

      const response = await bdd.requestDeleteAgent(
        actor,
        target.agentId,
        [409],
      );

      expect(response.body).toStrictEqual({
        error: {
          message:
            "Cannot delete agent because its lifecycle ownership is inconsistent",
          code: "CONFLICT",
        },
      });
      await expect(
        readAgentLifecycleCountsFixture(target.agentId),
      ).resolves.toStrictEqual({ agents: 1, sessions: 1, runs: 1 });
      await expect(bdd.readAgent(actor, target.agentId)).resolves.toMatchObject(
        {
          agentId: target.agentId,
        },
      );
    },
  );

  it.each(["agent", "session", "run"] as const)(
    "returns a retryable conflict without waiting on a locked target %s",
    async (kind) => {
      const actor = bdd.user();
      await prepareRunCreation(actor);
      const survivor = await createAgent(actor, `Lock ${kind} Survivor`);
      const target = await createAgent(actor, `Lock ${kind} Target`);
      const run = await api.createRun(actor, {
        agentId: target.agentId,
        prompt: `lock target ${kind}`,
        modelProvider: "anthropic-api-key",
      });
      await api.requestCancelRun(actor, run.runId, [200]);
      await pointTargetAtSurvivorVersion({
        targetAgentId: target.agentId,
        targetRunIds: [run.runId],
        survivorAgentId: survivor.agentId,
      });
      const lifecycle = await readAgentLifecycleIdsFixture(target.agentId);
      const id =
        kind === "agent"
          ? target.agentId
          : kind === "session"
            ? lifecycle.sessionIds[0]
            : lifecycle.runIds[0];
      if (!id) {
        throw new Error(`Expected a target ${kind}`);
      }
      const lockTimeoutBefore = await readDatabaseLockTimeoutFixture();
      const held = await holdAgentDeletionRowLockFixture({
        kind,
        id,
        signal: context.signal,
      });
      registerHeldBoundary(held);
      context.mocks.s3.send.mockClear();

      const startedAt = performance.now();
      const response = await bdd.requestDeleteAgent(
        actor,
        target.agentId,
        [409],
      );
      const elapsedMs = performance.now() - startedAt;

      expectRetryConflict(response);
      expect(elapsedMs).toBeLessThan(750);
      await expect(held.blockedWaiterCount()).resolves.toBe(0);
      expect(context.mocks.s3.send).not.toHaveBeenCalled();
      await expect(
        readAgentLifecycleCountsFixture(target.agentId),
      ).resolves.toStrictEqual({ agents: 1, sessions: 1, runs: 1 });
      await expect(readDatabaseLockTimeoutFixture()).resolves.toBe(
        lockTimeoutBefore,
      );

      held.release();
      await held.done;
      await bdd.deleteVersionFreeAgent(actor, target.agentId);
    },
  );

  it.each([
    [
      "version",
      [409],
      {
        error: {
          message:
            "Cannot delete agent while its configuration is being migrated",
          code: "CONFLICT",
        },
      },
    ],
    ["session", [204], undefined],
    [
      "run",
      [409],
      {
        error: {
          message: "Cannot delete agent: agent is currently running",
          code: "CONFLICT",
        },
      },
    ],
  ] as const)(
    "serializes a concurrent target %s insert without partial deletion",
    async (kind, afterReleaseStatuses, expectedAfterReleaseBody) => {
      const actor = bdd.user();
      const orgId = orgIdOf(actor);
      await prepareRunCreation(actor);
      const survivor = await createAgent(actor, `Insert ${kind} Survivor`);
      const target = await createAgent(actor, `Insert ${kind} Target`);
      const run = await api.createRun(actor, {
        agentId: target.agentId,
        prompt: `hold target ${kind} insert`,
        modelProvider: "anthropic-api-key",
      });
      await api.requestCancelRun(actor, run.runId, [200]);
      await pointTargetAtSurvivorVersion({
        targetAgentId: target.agentId,
        targetRunIds: [run.runId],
        survivorAgentId: survivor.agentId,
      });
      const lifecycle = await readAgentLifecycleIdsFixture(target.agentId);
      const sessionId = lifecycle.sessionIds[0];
      if (!sessionId) {
        throw new Error("Expected a target Session");
      }
      const held =
        kind === "version"
          ? await holdAgentVersionInsertFixture({
              agentId: target.agentId,
              userId: actor.userId,
              signal: context.signal,
            })
          : kind === "session"
            ? await holdAgentSessionInsertFixture({
                agentId: target.agentId,
                orgId,
                userId: actor.userId,
                signal: context.signal,
              })
            : await holdAgentRunInsertFixture({
                sessionId,
                orgId,
                userId: actor.userId,
                signal: context.signal,
              });
      registerHeldBoundary(held);

      const response = await bdd.requestDeleteAgent(
        actor,
        target.agentId,
        [409],
      );

      expectRetryConflict(response);
      await expect(held.blockedWaiterCount()).resolves.toBe(0);
      await expect(
        readAgentLifecycleCountsFixture(target.agentId),
      ).resolves.toStrictEqual({ agents: 1, sessions: 1, runs: 1 });
      held.release();
      await held.done;

      const retry = await bdd.requestDeleteAgent(
        actor,
        target.agentId,
        afterReleaseStatuses,
      );
      expect(retry.body).toStrictEqual(expectedAfterReleaseBody);
    },
  );

  it("fails fast across reverse Run locks and a queued promotion", async () => {
    const actor = bdd.user();
    await prepareRunCreation(actor);
    const survivor = await createAgent(actor, "Reverse Lock Survivor");
    const target = await createAgent(actor, "Reverse Lock Target");
    const first = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "first queued Run",
      modelProvider: "anthropic-api-key",
    });
    const second = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "second queued Run",
      modelProvider: "anthropic-api-key",
    });
    await setAgentRunStatusFixture(first.runId, "queued");
    await setAgentRunStatusFixture(second.runId, "queued");
    await pointTargetAtSurvivorVersion({
      targetAgentId: target.agentId,
      targetRunIds: [first.runId, second.runId],
      survivorAgentId: survivor.agentId,
    });
    const lifecycle = await readAgentLifecycleIdsFixture(target.agentId);
    const reverseRunIds = [...lifecycle.runIds].reverse();
    const reverseLocks = await holdAgentRunLocksFixture({
      runIds: reverseRunIds,
      signal: context.signal,
    });
    registerHeldBoundary(reverseLocks);

    const reverseResponse = await bdd.requestDeleteAgent(
      actor,
      target.agentId,
      [409],
    );

    expectRetryConflict(reverseResponse);
    await expect(reverseLocks.blockedWaiterCount()).resolves.toBe(0);
    reverseLocks.release();
    await reverseLocks.done;

    const promotion = await holdAgentRunPromotionFixture({
      runId: lifecycle.runIds[0] ?? first.runId,
      signal: context.signal,
    });
    registerHeldBoundary(promotion);
    const promotionResponse = await bdd.requestDeleteAgent(
      actor,
      target.agentId,
      [409],
    );
    expectRetryConflict(promotionResponse);
    await expect(promotion.blockedWaiterCount()).resolves.toBe(0);
    promotion.release();
    await promotion.done;

    const activeResponse = await bdd.requestDeleteAgent(
      actor,
      target.agentId,
      [409],
    );
    expect(activeResponse.body).toMatchObject({
      error: { message: "Cannot delete agent: agent is currently running" },
    });
  });

  it("bounds the Session and ChatThread reverse path without a deadlock", async () => {
    const actor = bdd.user();
    await prepareRunCreation(actor);
    const survivor = await createAgent(actor, "ChatThread Cycle Survivor");
    const target = await createAgent(actor, "ChatThread Cycle Target");
    const run = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "terminal ChatThread cycle Run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, run.runId, [200]);
    await pointTargetAtSurvivorVersion({
      targetAgentId: target.agentId,
      targetRunIds: [run.runId],
      survivorAgentId: survivor.agentId,
    });
    const lifecycle = await readAgentLifecycleIdsFixture(target.agentId);
    const sessionId = lifecycle.sessionIds[0];
    if (!sessionId) {
      throw new Error("Expected a target Session");
    }
    const threadId = await store.set(
      seedChatThread$,
      { userId: actor.userId, composeId: target.agentId },
      context.signal,
    );
    const lockTimeoutBefore = await readDatabaseLockTimeoutFixture();
    const held = await holdChatThreadThenSessionFixture({
      threadId,
      sessionId,
      signal: context.signal,
    });
    registerHeldBoundary(held);

    const startedAt = performance.now();
    const deletion = bdd.requestDeleteAgent(actor, target.agentId, [409]);
    await expect
      .poll(held.blockedWaiterCount, { interval: 2, timeout: 500 })
      .toBeGreaterThan(0);
    held.startSessionLock();
    const response = await deletion;
    const elapsedMs = performance.now() - startedAt;

    expectRetryConflict(response);
    expect(elapsedMs).toBeLessThan(750);
    await held.sessionLocked;
    await expect(
      readAgentLifecycleCountsFixture(target.agentId),
    ).resolves.toStrictEqual({ agents: 1, sessions: 1, runs: 1 });
    await expect(readDatabaseLockTimeoutFixture()).resolves.toBe(
      lockTimeoutBefore,
    );
    held.release();
    await held.done;
    await bdd.deleteVersionFreeAgent(actor, target.agentId);
  });

  it("rolls back a cascade-child timeout and retains billing on retry", async () => {
    const actor = bdd.user();
    const orgId = orgIdOf(actor);
    await prepareRunCreation(actor);
    const survivor = await createAgent(actor, "Cascade Child Survivor");
    const target = await createAgent(actor, "Cascade Child Target");
    const run = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "terminal cascade-child Run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, run.runId, [200]);
    await pointTargetAtSurvivorVersion({
      targetAgentId: target.agentId,
      targetRunIds: [run.runId],
      survivorAgentId: survivor.agentId,
    });
    const usageEventId = await store.set(
      insertUsageEvent$,
      {
        orgId,
        userId: actor.userId,
        runId: run.runId,
        status: "pending",
        creditsCharged: 7,
      },
      context.signal,
    );
    const lockTimeoutBefore = await readDatabaseLockTimeoutFixture();
    const held = await holdUsageEventMutationFixture({
      usageEventId,
      signal: context.signal,
    });
    registerHeldBoundary(held);

    const startedAt = performance.now();
    const deletion = bdd.requestDeleteAgent(actor, target.agentId, [409]);
    await expect
      .poll(held.blockedWaiterCount, { interval: 2, timeout: 500 })
      .toBeGreaterThan(0);
    const response = await deletion;
    const elapsedMs = performance.now() - startedAt;

    expectRetryConflict(response);
    expect(elapsedMs).toBeLessThan(750);
    await expect(
      readAgentLifecycleCountsFixture(target.agentId),
    ).resolves.toStrictEqual({ agents: 1, sessions: 1, runs: 1 });
    await expect(readUsageEventRunIdFixture(usageEventId)).resolves.toBe(
      run.runId,
    );
    await expect(readDatabaseLockTimeoutFixture()).resolves.toBe(
      lockTimeoutBefore,
    );
    held.release();
    await held.done;

    await bdd.deleteVersionFreeAgent(actor, target.agentId);

    await expect(readUsageEventRunIdFixture(usageEventId)).resolves.toBeNull();
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 0 });
  });
});
