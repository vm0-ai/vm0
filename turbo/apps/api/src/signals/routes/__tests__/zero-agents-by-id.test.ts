import { randomUUID } from "node:crypto";

import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/agents/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the agent when found in the active org", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Test Agent",
              description: "Test description",
              sound: "friendly",
            },
          ],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const agentId = fixture.composeIds[0]!;

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      agentId,
      ownerId: fixture.userId,
      displayName: "Test Agent",
      description: "Test description",
      sound: "friendly",
      avatarUrl: null,
      permissionPolicies: null,
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });

  it("returns 404 for an unknown agent id", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org (no existence leak)", async () => {
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other Org Agent" }] },
        context.signal,
      ),
    );
    const sharedId = otherFixture.composeIds[0]!;

    const myFixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: sharedId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${sharedId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 403 for a sandbox token without agent:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("DELETE /api/zero/agents/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for a sandbox token without agent:delete capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:delete",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 for an unknown agent id", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org", async () => {
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other Org Agent" }] },
        context.signal,
      ),
    );
    const agentId = otherFixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }

    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });

    const writeDb = store.set(writeDb$);
    const survivor = await writeDb
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, agentId));
    expect(survivor).toStrictEqual([{ id: agentId }]);
  });

  it("rejects same-org members who are not the agent owner", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner or org admin can delete agent",
        code: "FORBIDDEN",
      },
    });
  });

  it("deletes the caller's own agent", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const writeDb = store.set(writeDb$);
    await expect(
      writeDb
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, agentId)),
    ).resolves.toStrictEqual([]);
    await expect(
      writeDb
        .select({ id: agentComposes.id })
        .from(agentComposes)
        .where(eq(agentComposes.id, agentId)),
    ).resolves.toStrictEqual([]);
  });

  it("allows an org admin to delete another user's public agent", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const writeDb = store.set(writeDb$);
    await expect(
      writeDb
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, agentId)),
    ).resolves.toStrictEqual([]);
  });

  it("returns 409 and preserves rows when a pending run references the agent", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    const writeDb = store.set(writeDb$);
    const versionId = `v_${randomUUID().slice(0, 16)}`;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId: agentId,
      content: {},
      createdBy: fixture.userId,
    });
    await writeDb.insert(agentSessions).values({
      id: sessionId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: agentId,
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
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
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
    await expect(
      writeDb
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, agentId)),
    ).resolves.toStrictEqual([{ id: agentId }]);
    await expect(
      writeDb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).resolves.toStrictEqual([{ id: runId }]);

    await writeDb.delete(agentRuns).where(eq(agentRuns.id, runId));
    await writeDb.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await writeDb
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId));
  });
});
