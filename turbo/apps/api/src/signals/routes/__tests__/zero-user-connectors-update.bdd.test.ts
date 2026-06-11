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

// BDD migration of the legacy
// `zero-user-connectors-update.test.ts`. The 13 legacy
// `it()`s collapse into 3 BDD `it()`s:
// (1) auth + happy-path + persistence chain (401
// unauthenticated → 401 no org → 200 sets permissions
// + read-after-write → 400 invalid connector type → 200
// replaces existing atomically → 200 dedupes duplicates →
// 200 clears with empty array → 200 accepts CLI token),
// (2) validation + not-found chain (404 non-existent
// agent → 400 invalid connector type → 200 recomposes
// when head version is stale → 200 skips recomposition
// when current),
// (3) zero-token capability chain (403 sandbox without
// agent:read capability).

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

const track = createFixtureTracker<SkillsFixture>((fixture) => {
  return store.set(deleteSkillsForFixture$, fixture, context.signal);
});

describe("BDD PUT /api/zero/agents/:id/user-connectors — auth + happy-path + persistence chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 no org → 200 sets permissions + read-after-write → 400 invalid connector type → 200 replaces existing atomically → 200 dedupes duplicates → 200 clears with empty array → 200 accepts CLI token", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: { enabledTypes: ["github"] },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().update({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture + a seeded agent + a session for
    // the owner.

    // When + Then: 200 — enabledTypes reflects the
    // request + the DB persists the row.
    const setFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: setAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: setFixture.orgId, userId: setFixture.userId },
      context.signal,
    );
    mocks.clerk.session(setFixture.userId, setFixture.orgId);
    const setResponse = await accept(
      apiClient().update({
        params: { id: setAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github", "slack"] },
      }),
      [200],
    );
    expect(new Set(setResponse.body.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );
    await expect(
      getEnabledTypes(setFixture.orgId, setFixture.userId, setAgentId),
    ).resolves.toStrictEqual(expect.arrayContaining(["github", "slack"]));

    // Given: a fixture + a seeded agent + a session for
    // the owner + an enabledTypes containing a disabled
    // connector type.

    // When + Then: 400 — VALIDATION_ERROR + nothing is
    // persisted.
    const invalidFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: invalidAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: invalidFixture.orgId, userId: invalidFixture.userId },
      context.signal,
    );
    mocks.clerk.session(invalidFixture.userId, invalidFixture.orgId);
    const invalidResponse = await accept(
      apiClient().update({
        params: { id: invalidAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["bentoml"] },
      }),
      [400],
    );
    expect(invalidResponse.body.error.code).toBe("VALIDATION_ERROR");
    expect(invalidResponse.body.error.message).toContain(
      "Connector types are not available: bentoml",
    );
    await expect(
      getEnabledTypes(
        invalidFixture.orgId,
        invalidFixture.userId,
        invalidAgentId,
      ),
    ).resolves.toStrictEqual([]);

    // Given: a fixture + a seeded agent + an existing
    // permission row + a session for the owner.

    // When + Then: 200 — the second update atomically
    // replaces the prior set + only the new type is
    // persisted.
    const replaceFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: replaceAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: replaceFixture.orgId, userId: replaceFixture.userId },
      context.signal,
    );
    mocks.clerk.session(replaceFixture.userId, replaceFixture.orgId);
    await accept(
      apiClient().update({
        params: { id: replaceAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github", "slack"] },
      }),
      [200],
    );
    const replaceResponse = await accept(
      apiClient().update({
        params: { id: replaceAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["linear"] },
      }),
      [200],
    );
    expect(replaceResponse.body.enabledTypes).toStrictEqual(["linear"]);
    await expect(
      getEnabledTypes(
        replaceFixture.orgId,
        replaceFixture.userId,
        replaceAgentId,
      ),
    ).resolves.toStrictEqual(["linear"]);

    // Given: a fixture + a seeded agent + a session for
    // the owner + duplicate entries in enabledTypes.

    // When + Then: 200 — duplicates are removed + only
    // 2 distinct rows are persisted.
    const dedupeFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: dedupeAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: dedupeFixture.orgId, userId: dedupeFixture.userId },
      context.signal,
    );
    mocks.clerk.session(dedupeFixture.userId, dedupeFixture.orgId);
    const dedupeResponse = await accept(
      apiClient().update({
        params: { id: dedupeAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["slack", "github", "slack"] },
      }),
      [200],
    );
    expect(new Set(dedupeResponse.body.enabledTypes)).toStrictEqual(
      new Set(["slack", "github"]),
    );
    expect(dedupeResponse.body.enabledTypes).toHaveLength(2);
    await expect(
      getEnabledTypes(dedupeFixture.orgId, dedupeFixture.userId, dedupeAgentId),
    ).resolves.toHaveLength(2);

    // Given: a fixture + a seeded agent + a pre-existing
    // permission row + a session for the owner + an
    // empty enabledTypes array.

    // When + Then: 200 — all permissions are cleared +
    // no rows remain.
    const clearFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: clearAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: clearFixture.orgId, userId: clearFixture.userId },
      context.signal,
    );
    await store.set(
      seedUserConnector$,
      {
        orgId: clearFixture.orgId,
        userId: clearFixture.userId,
        agentId: clearAgentId,
        connectorType: "github",
      },
      context.signal,
    );
    mocks.clerk.session(clearFixture.userId, clearFixture.orgId);
    const clearResponse = await accept(
      apiClient().update({
        params: { id: clearAgentId },
        headers: authHeaders(),
        body: { enabledTypes: [] },
      }),
      [200],
    );
    expect(clearResponse.body.enabledTypes).toStrictEqual([]);
    await expect(
      getEnabledTypes(clearFixture.orgId, clearFixture.userId, clearAgentId),
    ).resolves.toStrictEqual([]);

    // Given: a fixture + a seeded agent + a CLI auth
    // header for the owner.

    // When + Then: 200 — CLI tokens are accepted +
    // enabledTypes is persisted.
    const cliFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: cliAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: cliFixture.orgId, userId: cliFixture.userId },
      context.signal,
    );
    const cliResponse = await accept(
      apiClient().update({
        params: { id: cliAgentId },
        headers: await cliAuthHeaders(cliFixture),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );
    expect(cliResponse.body.enabledTypes).toStrictEqual(["github"]);
    await expect(
      getEnabledTypes(cliFixture.orgId, cliFixture.userId, cliAgentId),
    ).resolves.toStrictEqual(["github"]);
  });
});

describe("BDD PUT /api/zero/agents/:id/user-connectors — validation + not-found + recompose chain", () => {
  it("gwt-wt-wt: 404 non-existent agent → 400 invalid connector type → 200 recomposes when head version is stale → 200 skips recomposition when current", async () => {
    // Given: a fixture + a session for the owner + a
    // random non-existent agent id.

    // When + Then: 404 — agent not found.
    const notFoundFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(notFoundFixture.userId, notFoundFixture.orgId);
    const fakeId = randomUUID();
    const notFoundResponse = await accept(
      apiClient().update({
        params: { id: fakeId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [404],
    );
    expect(notFoundResponse.body).toStrictEqual({
      error: { message: `Agent not found: ${fakeId}`, code: "NOT_FOUND" },
    });

    // Given: a fixture + a seeded agent + a session for
    // the owner + an enabledTypes containing an invalid
    // type.

    // When + Then: 400 — VALIDATION_ERROR.
    const invalidFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: invalidAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: invalidFixture.orgId, userId: invalidFixture.userId },
      context.signal,
    );
    mocks.clerk.session(invalidFixture.userId, invalidFixture.orgId);
    const invalidResponse = await accept(
      apiClient().update({
        params: { id: invalidAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github", "not-a-connector"] },
      }),
      [400],
    );
    expect(invalidResponse.body).toStrictEqual({
      error: {
        message: "Invalid connector types: not-a-connector",
        code: "VALIDATION_ERROR",
      },
    });

    // Given: a fixture + a seeded agent + a stale head
    // version + a session for the owner.

    // When + Then: 200 — a new compose version is
    // created + the head version is replaced.
    const staleFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    const { agentId: staleAgentId } = await store.set(
      seedAgentForInstructions$,
      { orgId: staleFixture.orgId, userId: staleFixture.userId },
      context.signal,
    );
    const STALE_VERSION = "f".repeat(64);
    const writeDb = store.set(writeDb$);
    await writeDb
      .update(agentComposes)
      .set({ headVersionId: STALE_VERSION })
      .where(eq(agentComposes.id, staleAgentId));
    await expect(getAgentHeadVersion(staleAgentId)).resolves.toBe(
      STALE_VERSION,
    );
    mocks.clerk.session(staleFixture.userId, staleFixture.orgId);
    await accept(
      apiClient().update({
        params: { id: staleAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );
    const staleAfter = await getAgentHeadVersion(staleAgentId);
    expect(staleAfter).not.toBe(STALE_VERSION);
    expect(staleAfter).toMatch(/^[a-f0-9]{64}$/);
    const [versionRow] = await writeDb
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, staleAfter!));
    expect(versionRow?.id).toBe(staleAfter);

    // Given: a fixture + a freshly created agent with a
    // current head version + a session for the owner.

    // When + Then: 200 — the head version is unchanged
    // after the update.
    const currentFixture = await track(
      store.set(seedSkillsFixture$, undefined, context.signal),
    );
    mocks.clerk.session(currentFixture.userId, currentFixture.orgId);
    const createResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: {},
      }),
      [201],
    );
    const currentAgentId = createResponse.body.agentId;
    const before = await getAgentHeadVersion(currentAgentId);
    if (!before) {
      throw new Error("Expected created agent to have a compose head version");
    }
    await accept(
      apiClient().update({
        params: { id: currentAgentId },
        headers: authHeaders(),
        body: { enabledTypes: ["github"] },
      }),
      [200],
    );
    await expect(getAgentHeadVersion(currentAgentId)).resolves.toBe(before);
  });
});

describe("BDD PUT /api/zero/agents/:id/user-connectors — zero-token capability chain", () => {
  it("gwt-wt-wt: 403 sandbox without agent:read capability", async () => {
    // Given: a zero token with the wrong capability.

    // When + Then: 403 — FORBIDDEN.
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
