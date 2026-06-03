import { randomBytes, randomUUID } from "node:crypto";

import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
} from "@vm0/api-contracts/contracts/webhooks";
import {
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
} from "@vm0/api-contracts/contracts/runners";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { blobs } from "@vm0/db/schema/blob";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

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

type CheckpointCreateBody = z.infer<
  typeof webhookCheckpointsContract.create.body
>;

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

function checkpointBody(fixture: AgentCheckpointFixture): CheckpointCreateBody {
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

function minimalCheckpointBody(
  fixture: AgentCheckpointFixture,
): CheckpointCreateBody {
  return {
    runId: fixture.runId,
    cliAgentType: "codex",
    cliAgentSessionId: `session-${fixture.runId}`,
    cliAgentSessionHistoryHash: fixture.historyHash,
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

  it("rejects invalid history hashes", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      prepareHistoryClient().prepare({
        body: {
          runId: fixture.runId,
          hash: "not-a-valid-hash",
          size: 123,
        },
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
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
  it("rejects missing sandbox auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      checkpointClient().create({
        body: checkpointBody(fixture),
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

  it("rejects missing required checkpoint fields", async () => {
    const fixture = await track(seedFixture());
    const body = checkpointBody(fixture);

    const missingRunId = await accept(
      checkpointClient().create({
        body: {
          cliAgentType: body.cliAgentType,
          cliAgentSessionId: body.cliAgentSessionId,
          cliAgentSessionHistoryHash: body.cliAgentSessionHistoryHash,
          artifactSnapshots: body.artifactSnapshots,
          volumeVersionsSnapshot: body.volumeVersionsSnapshot,
        } as unknown as CheckpointCreateBody,
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(missingRunId.body.error.message).toContain("runId");

    const missingSessionId = await accept(
      checkpointClient().create({
        body: {
          runId: body.runId,
          cliAgentType: body.cliAgentType,
          cliAgentSessionHistoryHash: body.cliAgentSessionHistoryHash,
          artifactSnapshots: body.artifactSnapshots,
          volumeVersionsSnapshot: body.volumeVersionsSnapshot,
        } as unknown as CheckpointCreateBody,
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(missingSessionId.body.error.message).toContain("cliAgentSessionId");

    const missingHistoryHash = await accept(
      checkpointClient().create({
        body: {
          runId: body.runId,
          cliAgentType: body.cliAgentType,
          cliAgentSessionId: body.cliAgentSessionId,
          artifactSnapshots: body.artifactSnapshots,
          volumeVersionsSnapshot: body.volumeVersionsSnapshot,
        } as unknown as CheckpointCreateBody,
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(missingHistoryHash.body.error.message).toContain(
      "cliAgentSessionHistoryHash",
    );
  });

  it("rejects removed singleton artifactSnapshot payloads", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      checkpointClient().create({
        body: {
          ...minimalCheckpointBody(fixture),
          artifactSnapshot: {
            artifactName: "test-artifact",
            artifactVersion: "v1",
          },
        } as unknown as CheckpointCreateBody,
        headers: authHeaders(fixture),
      }),
      [400],
    );

    expect(response.body.error.message).toContain("artifactSnapshot");
  });

  it("creates a checkpoint and persists conversation, artifact, volume, and session state", async () => {
    const fixture = await track(seedFixture());
    const body = checkpointBody(fixture);
    const volumeVersions = body.volumeVersionsSnapshot?.versions;
    if (!volumeVersions) {
      throw new Error("checkpointBody must include volume versions");
    }
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
      volumes: volumeVersions,
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
        versions: volumeVersions,
        additionalVolumes: [
          {
            name: "cache",
            versionId: volumeVersions.cache,
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

  it("accepts checkpoints without artifact snapshots", async () => {
    const fixture = await track(seedFixture());
    const originalArtifacts = [
      {
        name: "existing-artifact",
        version: "existing-version",
        mountPath: "/existing",
      },
    ];
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toBeDefined();
    await db
      .update(agentSessions)
      .set({ artifacts: originalArtifacts })
      .where(eq(agentSessions.id, run!.sessionId));

    const response = await accept(
      checkpointClient().create({
        body: minimalCheckpointBody(fixture),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.checkpointId).toBeTruthy();
    expect(response.body.agentSessionId).toBeTruthy();
    expect(response.body.conversationId).toBeTruthy();
    expect(response.body.artifacts).toBeUndefined();

    const [checkpoint] = await db
      .select({ artifactSnapshots: checkpoints.artifactSnapshots })
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint?.artifactSnapshots).toBeNull();
    const [session] = await db
      .select({ artifacts: agentSessions.artifacts })
      .from(agentSessions)
      .where(eq(agentSessions.id, run!.sessionId))
      .limit(1);
    expect(session?.artifacts).toStrictEqual(originalArtifacts);
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

  it("persists artifact snapshots without overwriting session artifact declarations", async () => {
    const fixture = await track(seedFixture());
    const artifactSnapshots = [
      {
        name: "artifact-a",
        version: "version-aaa",
        mountPath: "/workspace/a",
      },
      {
        name: "memory",
        version: "version-bbb",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
      {
        name: "memory",
        version: "version-codex",
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
      {
        name: "artifact-c",
        version: "version-ccc",
        mountPath: "/workspace/c",
        generatedBy: "apiAutoMemory" as const,
      },
    ];
    const persistedArtifactSnapshots = [
      {
        name: "artifact-a",
        version: "version-aaa",
        mountPath: "/workspace/a",
      },
      {
        name: "memory",
        version: "version-bbb",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
      {
        name: "memory",
        version: "version-codex",
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
      {
        name: "artifact-c",
        version: "version-ccc",
        mountPath: "/workspace/c",
      },
    ];
    const body = {
      ...minimalCheckpointBody(fixture),
      artifactSnapshots,
    };
    const db = store.set(writeDb$);
    const [run] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toBeDefined();
    const originalSessionArtifacts = [
      {
        name: "memory",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
      {
        name: "memory",
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
    ];
    await db
      .update(agentSessions)
      .set({
        artifacts: originalSessionArtifacts,
      })
      .where(eq(agentSessions.id, run!.sessionId));

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.artifacts).toStrictEqual(artifactSnapshots);

    const [checkpoint] = await db
      .select({ artifactSnapshots: checkpoints.artifactSnapshots })
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint?.artifactSnapshots).toStrictEqual(
      persistedArtifactSnapshots,
    );
    const [session] = await db
      .select({ artifacts: agentSessions.artifacts })
      .from(agentSessions)
      .where(eq(agentSessions.id, run!.sessionId))
      .limit(1);
    expect(session?.artifacts).toStrictEqual(originalSessionArtifacts);
  });

  it("strips canonical memory provenance unless the session expects api auto memory", async () => {
    const fixture = await track(seedFixture());
    const artifactSnapshots = [
      {
        name: "memory",
        version: "version-bbb",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        generatedBy: "apiAutoMemory" as const,
      },
    ];
    const body = {
      ...minimalCheckpointBody(fixture),
      artifactSnapshots,
    };

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.artifacts).toStrictEqual(artifactSnapshots);

    const db = store.set(writeDb$);
    const [checkpoint] = await db
      .select({ artifactSnapshots: checkpoints.artifactSnapshots })
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint?.artifactSnapshots).toStrictEqual([
      {
        name: "memory",
        version: "version-bbb",
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
      },
    ]);
  });

  it("creates independent sessions for separate runs", async () => {
    const fixture = await track(seedFixture());
    const { runId: secondRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
      },
      context.signal,
    );

    const firstResponse = await accept(
      checkpointClient().create({
        body: minimalCheckpointBody(fixture),
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const secondFixture = { ...fixture, runId: secondRunId };
    const secondResponse = await accept(
      checkpointClient().create({
        body: minimalCheckpointBody(secondFixture),
        headers: authHeaders(secondFixture),
      }),
      [200],
    );

    expect(firstResponse.body.agentSessionId).not.toBe(
      secondResponse.body.agentSessionId,
    );
  });

  it("reuses the existing session assigned to a continued run", async () => {
    const fixture = await track(seedFixture());
    const firstResponse = await accept(
      checkpointClient().create({
        body: minimalCheckpointBody(fixture),
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const originalSessionId = firstResponse.body.agentSessionId;

    const { runId: continuedRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        status: "running",
        continuedFromSessionId: originalSessionId,
      },
      context.signal,
    );

    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({ sessionId: originalSessionId })
      .where(eq(agentRuns.id, continuedRunId));

    const continuedFixture = { ...fixture, runId: continuedRunId };
    const response = await accept(
      checkpointClient().create({
        body: minimalCheckpointBody(continuedFixture),
        headers: authHeaders(continuedFixture),
      }),
      [200],
    );

    expect(response.body.agentSessionId).toBe(originalSessionId);

    const [session] = await db
      .select({ conversationId: agentSessions.conversationId })
      .from(agentSessions)
      .where(eq(agentSessions.id, originalSessionId))
      .limit(1);
    expect(session?.conversationId).toBe(response.body.conversationId);

    const [run] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, continuedRunId))
      .limit(1);
    expect(run?.sessionId).toBe(originalSessionId);
  });

  it("binds checkpoint conversations to the pre-created run session", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    const [runBefore] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    expect(runBefore?.sessionId).toBeTruthy();

    const response = await accept(
      checkpointClient().create({
        body: minimalCheckpointBody(fixture),
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.agentSessionId).toBe(runBefore?.sessionId);

    const [session] = await db
      .select({ conversationId: agentSessions.conversationId })
      .from(agentSessions)
      .where(eq(agentSessions.id, runBefore?.sessionId ?? ""))
      .limit(1);
    expect(session?.conversationId).toBe(response.body.conversationId);

    const [runAfter] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, fixture.runId))
      .limit(1);
    expect(runAfter?.sessionId).toBe(runBefore?.sessionId);
  });

  it("handles duplicate checkpoint requests via upsert", async () => {
    const fixture = await track(seedFixture());
    const body = checkpointBody(fixture);

    const firstResponse = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const secondResponse = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(secondResponse.body.checkpointId).toBe(
      firstResponse.body.checkpointId,
    );
  });

  it("omits additional volume snapshots when the run has no additional volumes", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({ additionalVolumes: null })
      .where(eq(agentRuns.id, fixture.runId));
    const body = {
      ...minimalCheckpointBody(fixture),
      volumeVersionsSnapshot: { versions: { "compose-vol": "xyz789hash" } },
    };

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.volumes).toStrictEqual(
      body.volumeVersionsSnapshot.versions,
    );

    const [checkpoint] = await db
      .select({ volumeVersionsSnapshot: checkpoints.volumeVersionsSnapshot })
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint?.volumeVersionsSnapshot).toStrictEqual({
      versions: body.volumeVersionsSnapshot.versions,
    });
  });

  it("falls back to the run volume version when the runner omits it", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    await db
      .update(agentRuns)
      .set({
        additionalVolumes: [
          { name: "my-vol", version: "v1.0", mountPath: "/mnt" },
        ],
      })
      .where(eq(agentRuns.id, fixture.runId));
    const body = {
      ...minimalCheckpointBody(fixture),
      volumeVersionsSnapshot: { versions: {} },
    };

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.volumes).toStrictEqual({});

    const [checkpoint] = await db
      .select({ volumeVersionsSnapshot: checkpoints.volumeVersionsSnapshot })
      .from(checkpoints)
      .where(eq(checkpoints.id, response.body.checkpointId))
      .limit(1);
    expect(checkpoint?.volumeVersionsSnapshot).toStrictEqual({
      versions: {},
      additionalVolumes: [
        { name: "my-vol", versionId: "v1.0", mountPath: "/mnt" },
      ],
    });
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

  it("returns 404 when the sandbox user does not own the run", async () => {
    const fixture = await track(seedFixture());
    const otherFixture = await track(seedFixture());
    const body = checkpointBody(otherFixture);

    const response = await accept(
      checkpointClient().create({
        body,
        headers: authHeaders({ ...fixture, runId: otherFixture.runId }),
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });
  });
});
