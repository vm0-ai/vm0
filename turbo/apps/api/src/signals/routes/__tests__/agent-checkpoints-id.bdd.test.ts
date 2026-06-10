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

// BDD migration of the legacy `agent-checkpoints-id.test.ts`.
// The 7 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// auth boundary chain (401 unauth → 401 no-org), (2) 404
// chain (missing → other user → other org), (3) 200 success
// chain (owning user/org → array projection to record).
// Direct-DB writes for compose + run + checkpoint +
// conversation are the only preconditions not reachable
// from any public API (Open Helper Gap).

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

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function checkpointClient() {
  return setupApp({ context })(checkpointsByIdContract);
}

describe("BDD GET /api/agent/checkpoints/:id — auth boundary", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 no-org", async () => {
    // When + Then: 401.
    const unauth = await accept(
      checkpointClient().getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with no org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: 401.
    const noOrg = await accept(
      checkpointClient().getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/agent/checkpoints/:id — 404 chain", () => {
  it("gwt-wt-wt: 404 missing checkpoint → 404 checkpoint from another user → 404 checkpoint from another org", async () => {
    // Given: an authenticated session.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 missing.
    const missing = await accept(
      checkpointClient().getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });

    // Given: a checkpoint owned by the fixture's user/org.
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

    // When + Then: a different user in the same org → 404.
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const otherUser = await accept(
      checkpointClient().getById({
        params: { id: checkpoint.checkpointId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherUser.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });

    // When + Then: the same user in a different org → 404.
    mocks.clerk.session(fixture.userId, `org_${randomUUID()}`);
    const otherOrg = await accept(
      checkpointClient().getById({
        params: { id: checkpoint.checkpointId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherOrg.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/agent/checkpoints/:id — 200 success chain", () => {
  it("gwt-wt-wt: 200 returns checkpoint details for owning user/org → 200 projects array-shaped artifact snapshots to a record", async () => {
    // Given: a checkpoint with a volume version snapshot.
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

    // When + Then: the owning session sees the full detail.
    const detail = await accept(
      checkpointClient().getById({
        params: { id: checkpoint.checkpointId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(detail.body.id).toBe(checkpoint.checkpointId);
    expect(detail.body.runId).toBe(runId);
    expect(detail.body.conversationId).toBe(checkpoint.conversationId);
    expect(detail.body.agentComposeSnapshot.secretNames).toStrictEqual([
      "API_TOKEN",
    ]);
    expect(detail.body.agentComposeSnapshot.vars).toStrictEqual({
      MODE: "test",
    });
    expect(detail.body.volumeVersionsSnapshot).toStrictEqual({
      versions: { data: "vol-v1" },
    });
    expect(Number.isNaN(Date.parse(detail.body.createdAt))).toBeFalsy();

    // Given: a different checkpoint whose artifact snapshots
    // are stored as an array of {name, version, mountPath}.
    const fixtureB = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const composeB = await store.set(
      seedCompose$,
      { orgId: fixtureB.orgId, userId: fixtureB.userId },
      context.signal,
    );
    const { runId: runIdB } = await store.set(
      seedRun$,
      {
        orgId: fixtureB.orgId,
        userId: fixtureB.userId,
        composeId: composeB.composeId,
        status: "completed",
      },
      context.signal,
    );
    const arrayCheckpoint = await store.set(
      seedCheckpoint$,
      {
        runId: runIdB,
        artifactSnapshots: [
          { name: "frontend", version: "v-fe-1", mountPath: "/workspace/fe" },
          { name: "backend", version: "v-be-2", mountPath: "/workspace/be" },
        ],
      },
      context.signal,
    );
    mocks.clerk.session(fixtureB.userId, fixtureB.orgId);

    // When + Then: array-shaped snapshots are projected to a
    // record keyed by name.
    const projected = await accept(
      checkpointClient().getById({
        params: { id: arrayCheckpoint.checkpointId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(projected.body.artifactSnapshots).toStrictEqual({
      frontend: "v-fe-1",
      backend: "v-be-2",
    });
  });
});
