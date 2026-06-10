import { randomUUID } from "node:crypto";

import { checkpointsByIdContract } from "@vm0/api-contracts/contracts/sessions";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { ContextArtifact } from "@vm0/db/types";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const TEST_SESSION_HISTORY_HASH =
  "ec3ac9679505be3bb8233c4ef0b39c8ee206d2c37fc8610edc19f41fbfb9661e";

interface SeedCheckpointArgs {
  readonly runId: string;
  readonly artifactSnapshots?: ContextArtifact[] | null;
  readonly volumeVersionsSnapshot?: {
    readonly versions: Record<string, string>;
  } | null;
}

interface SeedCheckpointResult {
  readonly checkpointId: string;
  readonly conversationId: string;
}

const seedCheckpoint$ = command(
  async (
    { set },
    args: SeedCheckpointArgs,
    signal: AbortSignal,
  ): Promise<SeedCheckpointResult> => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ agentComposeVersionId: agentRuns.agentComposeVersionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run?.agentComposeVersionId) {
      throw new Error("seedCheckpoint$: run has no compose version");
    }

    const [conversation] = await db
      .insert(conversations)
      .values({
        runId: args.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `test-session-${args.runId}`,
        cliAgentSessionHistoryHash: TEST_SESSION_HISTORY_HASH,
      })
      .returning({ id: conversations.id });
    signal.throwIfAborted();
    if (!conversation) {
      throw new Error("seedCheckpoint$: conversation insert returned no row");
    }

    const [checkpoint] = await db
      .insert(checkpoints)
      .values({
        runId: args.runId,
        conversationId: conversation.id,
        agentComposeSnapshot: {
          agentComposeVersionId: run.agentComposeVersionId,
          vars: { MODE: "test" },
          secretNames: ["API_TOKEN"],
        },
        artifactSnapshots: args.artifactSnapshots ?? null,
        volumeVersionsSnapshot: args.volumeVersionsSnapshot ?? null,
      })
      .returning({ id: checkpoints.id });
    signal.throwIfAborted();
    if (!checkpoint) {
      throw new Error("seedCheckpoint$: checkpoint insert returned no row");
    }

    return {
      checkpointId: checkpoint.id,
      conversationId: conversation.id,
    };
  },
);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/agent/checkpoints/:id", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when the checkpoint does not exist", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the checkpoint belongs to another user", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );
    const checkpoint = await store.set(
      seedCheckpoint$,
      { runId },
      context.signal,
    );
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: checkpoint.checkpointId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the checkpoint belongs to another organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );
    const checkpoint = await store.set(
      seedCheckpoint$,
      { runId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, `org_${randomUUID()}`);
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: checkpoint.checkpointId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });
  });

  it("returns checkpoint details for the owning user and organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );
    const checkpoint = await store.set(
      seedCheckpoint$,
      {
        runId,
        volumeVersionsSnapshot: { versions: { data: "vol-v1" } },
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: checkpoint.checkpointId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBe(checkpoint.checkpointId);
    expect(response.body.runId).toBe(runId);
    expect(response.body.conversationId).toBe(checkpoint.conversationId);
    expect(response.body.agentComposeSnapshot.secretNames).toStrictEqual([
      "API_TOKEN",
    ]);
    expect(response.body.agentComposeSnapshot.vars).toStrictEqual({
      MODE: "test",
    });
    expect(response.body.volumeVersionsSnapshot).toStrictEqual({
      versions: { data: "vol-v1" },
    });
    expect(Number.isNaN(Date.parse(response.body.createdAt))).toBeFalsy();
  });

  it("projects array-shaped artifact snapshots to a record", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );
    const checkpoint = await store.set(
      seedCheckpoint$,
      {
        runId,
        artifactSnapshots: [
          { name: "frontend", version: "v-fe-1", mountPath: "/workspace/fe" },
          { name: "backend", version: "v-be-2", mountPath: "/workspace/be" },
        ],
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(checkpointsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: checkpoint.checkpointId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.artifactSnapshots).toStrictEqual({
      frontend: "v-fe-1",
      backend: "v-be-2",
    });
  });
});
