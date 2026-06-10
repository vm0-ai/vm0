import { randomUUID } from "node:crypto";

import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken, signSandboxJwtForTests } from "../../auth/tokens";
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

// BDD migration of the legacy `zero-agents-by-id.test.ts`. The legacy
// direct DB SELECTs that verified row presence / absence are replaced
// by re-GET through the public contract (deleted agents return 404,
// cross-org callers never see the row). Storage cleanup is verified
// by re-GET returning 404 too. The 20 legacy `it()`s collapse into 3
// BDD `it()`s (auth + GET chain + DELETE chain).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function getClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

async function cliAuthHeaders(
  fixture: { readonly userId: string; readonly orgId: string },
  role: "admin" | "member" = "admin",
): Promise<{ readonly authorization: string }> {
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
  await writeDb.insert(orgMembersCache).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    role,
    cachedAt: new Date(now()),
  });
  return { authorization: `Bearer ${token}` };
}

describe("BDD /api/zero/agents/:id — auth boundary", () => {
  it("returns 401 for unauthenticated GET and DELETE", async () => {
    const c = getClient();
    // When + Then: no auth header on GET → 401.
    const get = await accept(
      c.get({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(get.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    // When + Then: no auth header on DELETE → 401.
    const del = await accept(
      c.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(del.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD GET /api/zero/agents/:id — read chain", () => {
  it("gwt-wt-wt: 401 no org → 200 owner → 200 CLI token (private) → 404 cross-user (private) → 404 unknown → 404 cross-org → 403 zero-token w/o capability → 200 zero-token w/ capability", async () => {
    const c = getClient();

    // Given: a fresh user/org with no composes.
    const emptyFixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, null);

    // When + Then: org-less session → 401.
    const noOrg = await accept(
      c.get({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a public agent owned by the user.
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
    const agentId = fixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the owner gets a fully-populated agent.
    const owner = await accept(
      c.get({ params: { id: agentId }, headers: authHeaders() }),
      [200],
    );
    expect(owner.body).toStrictEqual({
      agentId,
      ownerId: fixture.userId,
      displayName: "Test Agent",
      description: "Test description",
      sound: "friendly",
      avatarUrl: null,
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });

    // Given: a private agent (visible to owner + CLI token, hidden from
    // other members).
    const privateFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "CLI Private", visibility: "private" }] },
        context.signal,
      ),
    );
    const privateAgentId = privateFixture.composeIds[0]!;

    // When + Then: the owner CLI token can read the private agent.
    const cliOwner = await accept(
      c.get({
        params: { id: privateAgentId },
        headers: await cliAuthHeaders(privateFixture, "member"),
      }),
      [200],
    );
    expect(cliOwner.body).toMatchObject({
      agentId: privateAgentId,
      ownerId: privateFixture.userId,
      displayName: "CLI Private",
      visibility: "private",
    });

    // Given: a different user in the same org.
    mocks.clerk.session(
      `user_${randomUUID()}`,
      privateFixture.orgId,
      "org:member",
    );

    // When + Then: same-org non-owner gets 404 (no existence leak for
    // private agents).
    const crossUser = await accept(
      c.get({
        params: { id: privateAgentId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Given: the original owner session.
    mocks.clerk.session(privateFixture.userId, privateFixture.orgId);

    // When + Then: 404 for an unknown agent id.
    const unknown = await accept(
      c.get({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Given: another org owns an agent; the caller is on a different org.
    const otherOrgFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other Org Agent" }] },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: cross-org lookup returns 404 (no existence leak).
    const crossOrg = await accept(
      c.get({
        params: { id: otherOrgFixture.composeIds[0]! },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Given: a zero token without the agent:read capability.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const noCapToken = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: zero token without agent:read gets 403.
    const forbidden = await accept(
      c.get({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${noCapToken}` },
      }),
      [403],
    );
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });

    // Given: a zero token WITH the agent:read capability for an
    // existing public agent.
    const zeroFixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Zero Token Agent",
              description: "Read by zero token",
            },
          ],
        },
        context.signal,
      ),
    );
    const zeroAgentId = zeroFixture.composeIds[0]!;
    const seconds2 = currentSecond();
    const capToken = signSandboxJwtForTests({
      scope: "zero",
      userId: zeroFixture.userId,
      orgId: zeroFixture.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:read"],
      iat: seconds2,
      exp: seconds2 + 60,
    });
    // The route reads orgMembersCache for the user — seed the admin role.
    const writeDb = store.set(writeDb$);
    await writeDb
      .insert(orgMembersCache)
      .values({
        orgId: zeroFixture.orgId,
        userId: zeroFixture.userId,
        role: "admin",
        cachedAt: new Date(now()),
      })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: { role: "admin", cachedAt: new Date(now()) },
      });

    // When + Then: the zero token reads the agent.
    const zeroRead = await accept(
      c.get({
        params: { id: zeroAgentId },
        headers: { authorization: `Bearer ${capToken}` },
      }),
      [200],
    );
    expect(zeroRead.body).toMatchObject({
      agentId: zeroAgentId,
      ownerId: zeroFixture.userId,
      displayName: "Zero Token Agent",
      description: "Read by zero token",
    });
  });
});

describe("BDD DELETE /api/zero/agents/:id — delete chain", () => {
  it("gwt-wt-wt: 403 sandbox w/o agent:delete → 404 unknown → 404 cross-org (verified by re-GET) → 403 non-owner → 204 own (verified by re-GET)", async () => {
    const c = getClient();

    // Given: a zero token without the agent:delete capability.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const noCapToken = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 403.
    const forbidden = await accept(
      c.delete({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${noCapToken}` },
      }),
      [403],
    );
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:delete",
        code: "FORBIDDEN",
      },
    });

    // Given: a fresh user/org with one compose.
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 for an unknown agent.
    const unknown = await accept(
      c.delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Given: another org owns an agent; the caller is on a different
    // org.
    const otherOrgFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Other Org Agent" }] },
        context.signal,
      ),
    );
    const otherAgentId = otherOrgFixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: cross-org delete is 404 (no existence leak).
    const crossOrg = await accept(
      c.delete({
        params: { id: otherAgentId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({ error: { code: "NOT_FOUND" } });

    // Given: a non-owner member tries to delete the fixture's agent.
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId, "org:member");

    // When + Then: 403 (only the agent owner or org admin can delete).
    const nonOwner = await accept(
      c.delete({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [403],
    );
    expect(nonOwner.body).toMatchObject({ error: { code: "FORBIDDEN" } });

    // Given: the original owner session is restored.
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When: the owner deletes their own agent.
    const deleted = await accept(
      c.delete({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    // Then: re-GET returns 404 (the agent is gone — the public surface
    // also covers the cascade of the underlying compose row).
    const afterGet = await accept(
      c.get({
        params: { id: agentId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(afterGet.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
