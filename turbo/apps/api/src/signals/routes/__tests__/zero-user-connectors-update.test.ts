import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { userConnectors } from "@vm0/db/schema/user-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken, signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteSkillsForFixture$,
  seedAgentForInstructions$,
  seedSkillsFixture$,
  seedUserConnector$,
  type SkillsFixture,
} from "./helpers/zero-skills";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUserConnectorsContract);
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function cliAuthHeaders(fixture: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<{ readonly authorization: string }> {
  const tokenId = randomUUID();
  const token = generateCliToken(fixture.userId, fixture.orgId, tokenId);
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: fixture.userId,
    name: "test token",
    expiresAt: new Date(now() + 60 * 60 * 1000),
  });
  await writeDb
    .insert(orgMembersCache)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
      cachedAt: new Date(now()),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role: "admin", cachedAt: new Date(now()) },
    });

  return { authorization: `Bearer ${token}` };
}

describe("PUT /api/zero/agents/:id/user-connectors", () => {
  const track = createFixtureTracker<SkillsFixture>((fixture) => {
    return store.set(deleteSkillsForFixture$, fixture, context.signal);
  });

  async function getEnabledTypes(
    orgId: string,
    userId: string,
    agentId: string,
  ): Promise<string[]> {
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ connectorType: userConnectors.connectorType })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, orgId),
          eq(userConnectors.userId, userId),
          eq(userConnectors.agentId, agentId),
        ),
      );
    return rows.map((r) => {
      return r.connectorType;
    });
  }

  async function getAgentHeadVersion(
    agentId: string,
  ): Promise<string | null | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, agentId));
    return row?.headVersionId;
  }

  it("sets connector permissions and persists them (read-after-write)", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github", "slack"] },
      }),
      [200],
    );

    expect(new Set(response.body.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );

    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual(expect.arrayContaining(["github", "slack"]));
  });

  it("rejects connector permissions for disabled connector types", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["bentoml"] },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.message).toContain(
      "Connector types are not available: bentoml",
    );
    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual([]);
  });

  it("accepts a CLI token when updating connector permissions", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: await cliAuthHeaders(fixture),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );

    expect(response.body.enabledTypes).toStrictEqual(["github"]);
    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual(["github"]);
  });

  it("replaces existing permissions atomically", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github", "slack"] },
      }),
      [200],
    );

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["linear"] },
      }),
      [200],
    );
    expect(response.body.enabledTypes).toStrictEqual(["linear"]);

    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual(["linear"]);
  });

  it("dedupes duplicate entries in enabledTypes", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["slack", "github", "slack"] },
      }),
      [200],
    );

    expect(new Set(response.body.enabledTypes)).toStrictEqual(
      new Set(["slack", "github"]),
    );
    expect(response.body.enabledTypes).toHaveLength(2);

    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toHaveLength(2);
  });

  it("clears all permissions with an empty array", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: [] },
      }),
      [200],
    );

    expect(response.body.enabledTypes).toStrictEqual([]);
    await expect(
      getEnabledTypes(fixture.orgId, fixture.userId, agentId),
    ).resolves.toStrictEqual([]);
  });

  it("returns 404 for a non-existent agent", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const fakeId = randomUUID();

    const response = await accept(
      apiClient().update({
        params: { id: fakeId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${fakeId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 400 for invalid connector types", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github", "not-a-connector"] },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid connector types: not-a-connector",
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: { enabledTypes: ["github"] },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("recomposes the agent when its compose head version is stale", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const STALE_VERSION = "f".repeat(64);
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(agentComposes)
      .set({ headVersionId: STALE_VERSION })
      .where(eq(agentComposes.id, agentId));
    await expect(getAgentHeadVersion(agentId)).resolves.toBe(STALE_VERSION);

    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );

    const after = await getAgentHeadVersion(agentId);
    expect(after).not.toBe(STALE_VERSION);
    expect(after).toMatch(/^[a-f0-9]{64}$/);

    const [versionRow] = await writeDb
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, after!));
    expect(versionRow?.id).toBe(after);
  });

  it("skips recomposition when the compose head version is current", async () => {
    const fixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const createResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: {},
      }),
      [201],
    );
    const agentId = createResponse.body.agentId;
    const before = await getAgentHeadVersion(agentId);
    if (!before) {
      throw new Error("Expected created agent to have a compose head version");
    }

    await accept(
      apiClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );

    await expect(getAgentHeadVersion(agentId)).resolves.toBe(before);
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await accept(
      apiClient().update({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
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

    const response = await accept(
      apiClient().update({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
        body: { enabledTypes: ["github"] },
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
