import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";

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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/composes/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroComposesByIdContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("deletes the caller's own compose (DB read-after-delete)", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);
    // S3 listObjects returns empty; storages row not seeded so this won't be hit, but defensive.
    mocks.s3.listObjects([]);

    const client = setupApp({ context })(zeroComposesByIdContract);
    const response = await accept(
      client.delete({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const writeDb = store.set(writeDb$);
    const composeRows = await writeDb
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId));
    expect(composeRows).toHaveLength(0);
  });

  it("returns 404 for an unknown id", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, `org_${randomUUID().slice(0, 8)}`);
    const client = setupApp({ context })(zeroComposesByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when another user owns the compose (no-leak)", async () => {
    const victimFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const victimComposeId = victimFixture.composeIds[0];
    if (!victimComposeId) {
      throw new Error("Expected seeded compose");
    }

    const attackerUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(attackerUserId, `org_${randomUUID().slice(0, 8)}`);

    const client = setupApp({ context })(zeroComposesByIdContract);
    const response = await accept(
      client.delete({
        params: { id: victimComposeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    // No-leak: victim row physically still exists.
    const writeDb = store.set(writeDb$);
    const [survivor] = await writeDb
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, victimComposeId));
    expect(survivor).toBeDefined();
    expect(survivor?.userId).toBe(victimFixture.userId);
  });

  it("returns 409 when a pending run references the compose", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const writeDb = store.set(writeDb$);

    // Inline seed: a version + session + pending run.
    const versionId = `v_${randomUUID().slice(0, 16)}`;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: {},
      createdBy: fixture.userId,
    });
    await writeDb.insert(agentSessions).values({
      id: sessionId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: composeId,
    });
    await writeDb.insert(agentRuns).values({
      id: runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeVersionId: versionId,
      sessionId,
      status: "pending",
      prompt: "x",
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroComposesByIdContract);
    const response = await accept(
      client.delete({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });

    // No-leak: compose + run still present after 409.
    const composeRows = await writeDb
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId));
    expect(composeRows).toHaveLength(1);
    const runRows = await writeDb
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(runRows).toHaveLength(1);

    // Manual inline cleanup so deleteTeamCompose$ can drop the compose cleanly.
    await writeDb.delete(agentRuns).where(eq(agentRuns.id, runId));
    await writeDb.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await writeDb
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId));
  });
});
