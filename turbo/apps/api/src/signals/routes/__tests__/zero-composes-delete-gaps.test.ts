import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroComposesByIdContract } from "@vm0/api-contracts/contracts/zero-composes";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const trackCompose = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function byIdClient() {
  return setupApp({ context })(zeroComposesByIdContract);
}

async function seedCompose(): Promise<TeamComposeFixture> {
  return await trackCompose(
    store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
  );
}

describe("/api/zero/composes/:id delete helper gaps", () => {
  it("returns 409 without deleting a compose referenced by a pending run", async () => {
    const fixture = await seedCompose();
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const writeDb = store.set(writeDb$);
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
    const response = await accept(
      byIdClient().delete({
        params: { id: composeId },
        headers: authHeaders(),
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });

    const composeRows = await writeDb
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId));
    const runRows = await writeDb
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(composeRows).toHaveLength(1);
    expect(runRows).toHaveLength(1);

    await writeDb.delete(agentRuns).where(eq(agentRuns.id, runId));
    await writeDb.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await writeDb
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId));
  });
});
