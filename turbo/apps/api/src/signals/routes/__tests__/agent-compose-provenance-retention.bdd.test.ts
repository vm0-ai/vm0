import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { isLockNotAvailable } from "../../../lib/pg-errors";
import {
  holdAgentComposeVersionRowFixture,
  readAgentComposeVersionProvenanceFixture,
  readAgentComposeVersionReferenceCountsFixture,
  readAgentHeadVersionIdFixture,
  readCheckpointAgentComposeVersionIdFixture,
  setAgentComposeVersionCreatorFixture,
} from "../../../test-fixtures/agent-compose-provenance";
import {
  referenceAgentHeadFixture,
  referenceAgentRunVersionFixture,
} from "../../../test-fixtures/agent-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { clearAllDetached, settle } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

function configureClerkDeletion(): void {
  webhooks.configureClerkWebhookSecret();
  context.mocks.s3.send.mockResolvedValue({});
}

function preserveOrgWithPeer(peer: ApiTestUser): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [{ publicUserData: { userId: peer.userId } }],
    },
  );
}

async function prepareRunCreation(actor: ApiTestUser): Promise<void> {
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Nullable Provenance Default Agent",
  });
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
}

async function requestClerkDeletion(
  type: "organization.deleted" | "user.deleted",
  id: string,
): Promise<void> {
  webhooks.verifyNextClerkWebhook({ type, data: { id } });
  const response = await webhooks.requestClerkWebhook("{}", {}, [200]);
  expect(response.body).toBe("OK");
}

async function deliverClerkDeletion(
  type: "organization.deleted" | "user.deleted",
  id: string,
): Promise<void> {
  await requestClerkDeletion(type, id);
  await flushWaitUntilForTest();
}

describe("Agent Compose nullable transition provenance", () => {
  it("retains shared and unreferenced versions after duplicate user deletion", async () => {
    configureClerkDeletion();
    const doomed = bdd.user();
    const survivor = bdd.user({
      orgId: orgIdOf(doomed),
      orgRole: "org:admin",
    });
    preserveOrgWithPeer(survivor);
    await prepareRunCreation(survivor);

    const sharedSource = await bdd.createAgent(doomed, {
      displayName: "Deleted User Shared Version Source",
    });
    const unreferencedSource = await bdd.createAgent(doomed, {
      displayName: "Deleted User Unreferenced Version",
    });
    const survivingAgent = await bdd.createAgent(survivor, {
      displayName: "Surviving Shared Version Agent",
    });
    const survivingRun = await runs.createRun(survivor, {
      agentId: survivingAgent.agentId,
      prompt: "retain the shared version",
      modelProvider: "anthropic-api-key",
    });

    const sharedVersionId = await referenceAgentHeadFixture({
      agentId: survivingAgent.agentId,
      versionAgentId: sharedSource.agentId,
    });
    await referenceAgentRunVersionFixture({
      runId: survivingRun.runId,
      versionAgentId: sharedSource.agentId,
    });
    const unreferencedVersionId = await readAgentHeadVersionIdFixture(
      unreferencedSource.agentId,
    );
    const sharedBefore =
      await readAgentComposeVersionProvenanceFixture(sharedVersionId);
    const unreferencedBefore = await readAgentComposeVersionProvenanceFixture(
      unreferencedVersionId,
    );

    await deliverClerkDeletion("user.deleted", doomed.userId);

    const sharedAfter =
      await readAgentComposeVersionProvenanceFixture(sharedVersionId);
    expect(sharedAfter).toStrictEqual({
      ...sharedBefore,
      composeId: null,
      createdBy: null,
    });
    await expect(
      readAgentComposeVersionReferenceCountsFixture(sharedVersionId),
    ).resolves.toStrictEqual({ agentHeads: 1, runs: 1 });

    const unreferencedAfter = await readAgentComposeVersionProvenanceFixture(
      unreferencedVersionId,
    );
    expect(unreferencedAfter).toStrictEqual({
      ...unreferencedBefore,
      composeId: null,
      createdBy: null,
    });
    await expect(
      readAgentComposeVersionReferenceCountsFixture(unreferencedVersionId),
    ).resolves.toStrictEqual({ agentHeads: 0, runs: 0 });

    await deliverClerkDeletion("user.deleted", doomed.userId);
    await expect(
      readAgentComposeVersionProvenanceFixture(sharedVersionId),
    ).resolves.toStrictEqual(sharedAfter);
    await expect(
      readAgentComposeVersionProvenanceFixture(unreferencedVersionId),
    ).resolves.toStrictEqual(unreferencedAfter);

    await expect(
      bdd.readAgent(survivor, survivingAgent.agentId),
    ).resolves.toMatchObject({ agentId: survivingAgent.agentId });
    await expect(
      runs.readRun(survivor, survivingRun.runId),
    ).resolves.toMatchObject({
      runId: survivingRun.runId,
      agentComposeVersionId: sharedVersionId,
    });

    const newRun = await runs.createRun(survivor, {
      agentId: survivingAgent.agentId,
      prompt: "resolve the retained nullable head",
      modelProvider: "anthropic-api-key",
    });
    await expect(runs.readRun(survivor, newRun.runId)).resolves.toMatchObject({
      runId: newRun.runId,
      agentComposeVersionId: sharedVersionId,
    });

    const history = `bdd session history ${survivingRun.runId}`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const checkpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: survivingRun.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `nullable-provenance-${survivingRun.runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      {
        authorization: `Bearer ${runs.sandboxTokenForRun(
          survivor,
          survivingRun.runId,
        )}`,
      },
      [200],
    );
    expect(checkpoint.status).toBe(200);
    await expect(
      readCheckpointAgentComposeVersionIdFixture(survivingRun.runId),
    ).resolves.toBe(sharedVersionId);
    const repeatedHistory = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: survivingRun.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history),
        encodedSize: Buffer.byteLength(history),
        encoding: "identity",
      },
      {
        authorization: `Bearer ${runs.sandboxTokenForRun(
          survivor,
          survivingRun.runId,
        )}`,
      },
      [200],
    );
    expect(repeatedHistory.body).toStrictEqual({
      existing: true,
      encoding: "identity",
    });

    await runs.requestCancelRun(survivor, survivingRun.runId, [200]);
    await runs.requestCancelRun(survivor, newRun.runId, [200]);
    await flushWaitUntilForTest();
  });

  it("clears an exact creator without inferring from the surviving Agent", async () => {
    configureClerkDeletion();
    bdd.acceptAgentStorageWrites();
    const doomed = bdd.user();
    const survivor = bdd.user({
      orgId: orgIdOf(doomed),
      orgRole: "org:member",
    });
    preserveOrgWithPeer(survivor);
    const survivingAgent = await bdd.createAgent(survivor, {
      displayName: "Cross Agent Creator Survivor",
    });
    const versionId = await readAgentHeadVersionIdFixture(
      survivingAgent.agentId,
    );
    const before = await readAgentComposeVersionProvenanceFixture(versionId);
    await setAgentComposeVersionCreatorFixture({
      versionId,
      createdBy: doomed.userId,
    });

    await deliverClerkDeletion("user.deleted", doomed.userId);
    await deliverClerkDeletion("user.deleted", doomed.userId);

    await expect(
      readAgentComposeVersionProvenanceFixture(versionId),
    ).resolves.toStrictEqual({
      ...before,
      createdBy: null,
    });
    await expect(
      bdd.readAgent(survivor, survivingAgent.agentId),
    ).resolves.toMatchObject({ agentId: survivingAgent.agentId });
  });

  it("clears only Agent provenance after duplicate organization deletion", async () => {
    configureClerkDeletion();
    bdd.acceptAgentStorageWrites();
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "Deleted Organization Version",
    });
    const versionId = await readAgentHeadVersionIdFixture(agent.agentId);
    const before = await readAgentComposeVersionProvenanceFixture(versionId);

    await deliverClerkDeletion("organization.deleted", orgIdOf(actor));
    const after = await readAgentComposeVersionProvenanceFixture(versionId);
    expect(after).toStrictEqual({
      ...before,
      composeId: null,
      createdBy: actor.userId,
    });

    await deliverClerkDeletion("organization.deleted", orgIdOf(actor));
    await expect(
      readAgentComposeVersionProvenanceFixture(versionId),
    ).resolves.toStrictEqual(after);
    await expect(
      readAgentComposeVersionReferenceCountsFixture(versionId),
    ).resolves.toStrictEqual({ agentHeads: 0, runs: 0 });
  });

  it("bounds lock contention and rolls back the lifecycle database step", async () => {
    configureClerkDeletion();
    const doomed = bdd.user();
    const survivor = bdd.user({
      orgId: orgIdOf(doomed),
      orgRole: "org:admin",
    });
    preserveOrgWithPeer(survivor);
    await prepareRunCreation(survivor);
    const doomedAgent = await bdd.createAgent(doomed, {
      displayName: "Contended Deleted User Agent",
    });
    const doomedRun = await runs.createRun(doomed, {
      agentId: doomedAgent.agentId,
      prompt: "remain until the transaction can commit",
      modelProvider: "anthropic-api-key",
    });
    const versionId = await readAgentHeadVersionIdFixture(doomedAgent.agentId);
    const before = await readAgentComposeVersionProvenanceFixture(versionId);
    const versionLock = await holdAgentComposeVersionRowFixture({
      versionId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      versionLock.release();
      await versionLock.done;
      await flushWaitUntilForTest();
    });

    await requestClerkDeletion("user.deleted", doomed.userId);
    const startedAt = performance.now();
    const cleanup = await settle(flushWaitUntilForTest());
    const elapsedMs = performance.now() - startedAt;
    expect(cleanup.ok).toBeFalsy();
    if (cleanup.ok) {
      throw new Error("Expected contended Clerk cleanup to fail closed");
    }
    expect(isLockNotAvailable(cleanup.error)).toBeTruthy();
    expect(elapsedMs).toBeLessThan(2000);
    await expect(
      readAgentComposeVersionProvenanceFixture(versionId),
    ).resolves.toStrictEqual(before);
    await expect(
      bdd.readAgent(doomed, doomedAgent.agentId),
    ).resolves.toMatchObject({ agentId: doomedAgent.agentId });
    await expect(runs.readRun(doomed, doomedRun.runId)).resolves.toMatchObject({
      runId: doomedRun.runId,
    });

    versionLock.release();
    await versionLock.done;
    const detachedCleanup = await settle(clearAllDetached());
    expect(detachedCleanup.ok).toBeFalsy();
    if (detachedCleanup.ok) {
      throw new Error("Expected detached Clerk cleanup to remain failed");
    }
    expect(isLockNotAvailable(detachedCleanup.error)).toBeTruthy();
    await deliverClerkDeletion("user.deleted", doomed.userId);
    await expect(
      bdd.requestReadAgent(doomed, doomedAgent.agentId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      runs.requestReadRun(doomed, doomedRun.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      readAgentComposeVersionProvenanceFixture(versionId),
    ).resolves.toStrictEqual({
      ...before,
      composeId: null,
      createdBy: null,
    });
  });
});
