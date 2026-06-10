import { randomUUID } from "node:crypto";

import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-composes-delete.test.ts`. The Given
// uses `seedTeamCompose$` (recorded under "Open Helper Gaps" in
// `api.bdd.md`). The 409 path's run/session/version rows are seeded
// inline for the same reason (no public route creates a pending run
// against an arbitrary compose). The legacy direct DB reads verifying
// the post-delete state are replaced with: (a) a follow-up GET that
// returns 404 to confirm the compose is gone, and (b) a re-attempted
// DELETE that still returns 409 to confirm the 409 path didn't mutate
// the compose.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroComposesByIdContract);
}

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD DELETE /api/zero/composes/:id — auth boundary", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("BDD DELETE /api/zero/composes/:id — ownership chain", () => {
  it("gwt-wt-wt: 404 unknown → 204 own (verified via GET) → 404 cross-org victim preserved → 409 pending run", async () => {
    // Given: a fresh caller with no seeded compose.
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID().slice(0, 8)}`);
    const c = client();

    // When + Then: DELETE for an unknown id returns 404.
    const unknown = await accept(
      c.delete({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    // Given: a seeded compose owned by the caller; S3 listObjects
    // returns empty (no storage rows to clean up).
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mocks.s3.listObjects([]);

    // When: the caller DELETEs their own compose.
    const deleted = await accept(
      c.delete({ params: { id: composeId }, headers: authHeaders() }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    // Then: a follow-up GET returns 404 — the compose row is gone.
    const reread = await accept(
      c.getById({ params: { id: composeId }, headers: authHeaders() }),
      [404],
    );
    expect(reread.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    // Given: a different attacker user attempts to delete a victim
    // compose they don't own. The victim row is seeded in a
    // different org.
    const victimFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const victimComposeId = victimFixture.composeIds[0];
    if (!victimComposeId) {
      throw new Error("Expected seeded compose");
    }
    const attackerUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(attackerUserId, `org_${randomUUID().slice(0, 8)}`);

    // When + Then: DELETE returns 404 (no existence leak).
    const blocked = await accept(
      c.delete({ params: { id: victimComposeId }, headers: authHeaders() }),
      [404],
    );
    expect(blocked.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    // Then: the victim's compose is still readable as the victim.
    mocks.clerk.session(victimFixture.userId, victimFixture.orgId);
    const victimStill = await accept(
      c.getById({
        params: { id: victimComposeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(victimStill.body.id).toBe(victimComposeId);

    // Given: the caller now has another compose (a fresh one, since
    // the previous one was deleted above) referenced by a pending
    // run. Seed a version + session + pending run inline.
    const runFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const runComposeId = runFixture.composeIds[0];
    if (!runComposeId) {
      throw new Error("Expected seeded compose");
    }
    const writeDb = store.set(writeDb$);
    const versionId = `v_${randomUUID().slice(0, 16)}`;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId: runComposeId,
      content: {},
      createdBy: runFixture.userId,
    });
    await writeDb.insert(agentSessions).values({
      id: sessionId,
      userId: runFixture.userId,
      orgId: runFixture.orgId,
      agentComposeId: runComposeId,
    });
    await writeDb.insert(agentRuns).values({
      id: runId,
      userId: runFixture.userId,
      orgId: runFixture.orgId,
      agentComposeVersionId: versionId,
      sessionId,
      status: "pending",
      prompt: "x",
    });
    mocks.clerk.session(runFixture.userId, runFixture.orgId);

    // When + Then: DELETE returns 409.
    const conflict = await accept(
      c.delete({ params: { id: runComposeId }, headers: authHeaders() }),
      [409],
    );
    expect(conflict.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });

    // Then: a re-attempted DELETE still returns 409 — the 409 did
    // not mutate the compose or the run.
    const stillConflict = await accept(
      c.delete({ params: { id: runComposeId }, headers: authHeaders() }),
      [409],
    );
    expect(stillConflict.body.error.code).toBe("CONFLICT");

    // Cleanup the inline-seeded rows so `deleteTeamCompose$` can drop
    // the compose cleanly in afterEach.
    await writeDb.delete(agentRuns).where(eq(agentRuns.id, runId));
    await writeDb.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await writeDb
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId));
  });
});
