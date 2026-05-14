import { randomBytes, randomUUID } from "node:crypto";

import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { blobs } from "@vm0/db/schema/blob";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const BUCKET = "test-user-storages";

const context = testContext();
const store = createStore();

interface AgentCheckpointFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
  readonly historyHash: string;
}

function sha256Hash(): string {
  return randomBytes(32).toString("hex");
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    runId: fixture.runId,
    userId: fixture.userId,
    orgId: fixture.orgId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function authHeaders(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): {
  readonly authorization: string;
} {
  return { authorization: `Bearer ${sandboxToken(fixture)}` };
}

function checkpointClient() {
  return setupApp({ context })(webhookCheckpointsContract);
}

function prepareHistoryClient() {
  return setupApp({ context })(webhookCheckpointsPrepareHistoryContract);
}

function checkpointBody(fixture: AgentCheckpointFixture) {
  return {
    runId: fixture.runId,
    cliAgentType: "codex",
    cliAgentSessionId: `session-${fixture.runId}`,
    cliAgentSessionHistoryHash: fixture.historyHash,
    artifactSnapshots: [
      {
        name: "workspace",
        version: sha256Hash(),
        mountPath: "/workspace",
      },
    ],
    volumeVersionsSnapshot: {
      versions: {
        cache: sha256Hash(),
      },
    },
  };
}

async function seedFixture(): Promise<AgentCheckpointFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: base.orgId, userId: base.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      status: "running",
    },
    context.signal,
  );

  const db = store.set(writeDb$);
  await db
    .update(agentRuns)
    .set({
      vars: { MODE: "test" },
      secretNames: ["API_TOKEN"],
      additionalVolumes: [
        {
          name: "cache",
          version: sha256Hash(),
          mountPath: "/cache",
        },
        {
          name: "workspace",
          mountPath: "/workspace",
        },
      ],
    })
    .where(eq(agentRuns.id, runId));

  return { ...base, composeId, runId, historyHash: sha256Hash() };
}

const track = createFixtureTracker<AgentCheckpointFixture>(async (fixture) => {
  const db = store.set(writeDb$);
  await db.delete(blobs).where(eq(blobs.hash, fixture.historyHash));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

beforeEach(() => {
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
});

describe("POST /api/webhooks/agent/checkpoints/prepare-history", () => {
  it("rejects missing sandbox auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareHistoryClient().prepare({
        body: {
          runId: fixture.runId,
          hash: fixture.historyHash,
          size: 123,
        },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated or runId mismatch",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns existing when the blob is registered and present in S3", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    await db
      .insert(blobs)
      .values({ hash: fixture.historyHash, size: 123, refCount: 0 });
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      prepareHistoryClient().prepare({
        body: {
          runId: fixture.runId,
          hash: fixture.historyHash,
          size: 123,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ existing: true });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("pre-registers a missing blob and returns a presigned upload URL", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareHistoryClient().prepare({
        body: {
          runId: fixture.runId,
          hash: fixture.historyHash,
          size: 456,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      existing: false,
      presignedUrl: "https://r2.example.com/upload?sig=test",
    });

    const db = store.set(writeDb$);
    const [blob] = await db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, fixture.historyHash))
      .limit(1);
    expect(blob).toMatchObject({
      hash: fixture.historyHash,
      size: 456,
      refCount: 0,
    });
  });

  it("returns 404 when the sandbox run does not exist", async () => {
    const fixture = await track(seedFixture());
    const missingRunId = randomUUID();

    const response = await accept(
      prepareHistoryClient().prepare({
        body: {
          runId: missingRunId,
          hash: fixture.historyHash,
          size: 123,
        },
        headers: authHeaders({ ...fixture, runId: missingRunId }),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });
});

describe("POST /api/webhooks/agent/checkpoints", () => {
  it("rejects a body runId that does not match the sandbox token", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      checkpointClient().create({
        body: { ...checkpointBody(fixture), runId: randomUUID() },
        headers: authHeaders(fixture),
      }),
      [401],
    );

    expect(response.body.error.message).toBe(
      "Not authenticated or runId mismatch",
    );
  });

  it("creates a checkpoint and persists conversation, artifact, volume, and session state", async () => {
    const fixture = await track(seedFixture());
    const body = checkpointBody(fixture);
    const db = store.set(writeDb$);
    await db
      .insert(blobs)
      .values({ hash: fixture.historyHash, size: 789, refCount: 0 });

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      artifacts: body.artifactSnapshots,
      volumes: body.volumeVersionsSnapshot.versions,
    });

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, response.body.conversationId))
      .limit(1);
    expect(conversation).toMatchObject({
      runId: fixture.runId,
      cliAgentType: body.cliAgentType,
      cliAgentSessionId: body.cliAgentSessionId,
      cliAgentSessionHistoryHash: fixture.historyHash,
    });

    const [run] = await db
      .select({
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        sessionId: agentRuns.sessionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    expect(run?.agentComposeVersionId).toBeTruthy();

    const [checkpoint] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint).toMatchObject({
      runId: fixture.runId,
      conversationId: response.body.conversationId,
      artifactSnapshots: body.artifactSnapshots,
      volumeVersionsSnapshot: {
        versions: body.volumeVersionsSnapshot.versions,
        additionalVolumes: [
          {
            name: "cache",
            versionId: body.volumeVersionsSnapshot.versions.cache,
            mountPath: "/cache",
          },
          {
            name: "workspace",
            versionId: "latest",
            mountPath: "/workspace",
          },
        ],
      },
    });
    expect(checkpoint?.agentComposeSnapshot).toStrictEqual({
      agentComposeVersionId: run?.agentComposeVersionId,
      vars: { MODE: "test" },
      secretNames: ["API_TOKEN"],
    });

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, run?.sessionId ?? ""))
      .limit(1);
    expect(session?.conversationId).toBe(response.body.conversationId);

    const [blob] = await db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, fixture.historyHash))
      .limit(1);
    expect(blob?.refCount).toBe(1);
  });

  it("normalizes empty artifact snapshots to a missing response field", async () => {
    const fixture = await track(seedFixture());
    const body = { ...checkpointBody(fixture), artifactSnapshots: [] };
    const db = store.set(writeDb$);
    await db
      .insert(blobs)
      .values({ hash: fixture.historyHash, size: 789, refCount: 0 });

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.artifacts).toBeUndefined();

    const [checkpoint] = await db
      .select({ artifactSnapshots: checkpoints.artifactSnapshots })
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint?.artifactSnapshots).toBeNull();
  });

  it("returns 404 when the sandbox run does not exist", async () => {
    const fixture = await track(seedFixture());
    const missingRunId = randomUUID();
    const body = { ...checkpointBody(fixture), runId: missingRunId };

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders({ ...fixture, runId: missingRunId }),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });
});
