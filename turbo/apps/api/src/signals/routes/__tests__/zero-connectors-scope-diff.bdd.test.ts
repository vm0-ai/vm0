import { randomUUID } from "node:crypto";

import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-connectors-scope-diff.test.ts`.
// The 8 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// + capability + 404 chain (401 unauth → 401 no-org → 403
// sandbox token without connector:read → 404 no connector
// configured for the type), (2) 200 empty diff chain (stored
// scopes match current scopes → api-token stripe has empty
// current/stored), (3) 200 diff chain (added scopes when
// missing required → removed scopes when stale extras).
//
// Service-Level Exception: connector rows are seeded directly
// via `writeDb$` because no public route creates a `connectors`
// row. Post-`it` cleanup deletes connector rows by orgId.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

// Mirrors `github.ts` connector OAuth scopes; deterministic so
// the `toStrictEqual` assertions catch any silent payload drift
// if the canonical scope list changes upstream.
const GITHUB_CURRENT_SCOPES = ["repo", "project", "workflow"] as const;

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function seedGithubConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly storedScopes: readonly string[];
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: "github",
    authMethod: "oauth",
    oauthScopes: JSON.stringify([...args.storedScopes]),
  });
}

async function seedStripeApiTokenConnector(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: "stripe",
    authMethod: "api-token",
    oauthScopes: null,
  });
}

async function deleteConnectorsByOrg(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
}

function client() {
  return setupApp({ context })(zeroConnectorScopeDiffContract);
}

function authHeaders(token = "clerk-session") {
  return { authorization: `Bearer ${token}` };
}

describe("BDD GET /api/zero/connectors/:type/scope-diff — auth + 404 chain", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnectorsByOrg(fixture.orgId);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 401 unauth → 401 no-org → 403 sandbox token without connector:read → 404 no connector configured for the type", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.getScopeDiff({ params: { type: "github" }, headers: {} }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // Given: a sandbox token without the connector:read
    // capability.
    const capUserId = `user_${randomUUID()}`;
    const capOrgId = `org_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: capUserId,
      orgId: capOrgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 403 — missing capability.
    const missingCap = await accept(
      c.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(missingCap.body.error.message).toBe(
      "Missing required capability: connector:read",
    );

    // Given: a Clerk session for a user with no connector
    // configured.
    const noConnectorUserId = `user_${randomUUID()}`;
    const noConnectorOrgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: noConnectorOrgId, userId: noConnectorUserId },
        context.signal,
      ),
    );
    mocks.clerk.session(noConnectorUserId, noConnectorOrgId);

    // When + Then: 404 — no connector configured for github.
    const notFound = await accept(
      c.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });
});

describe("BDD GET /api/zero/connectors/:type/scope-diff — 200 empty diff chain", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnectorsByOrg(fixture.orgId);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: stored scopes match current scopes → api-token stripe has empty current/stored", async () => {
    const c = client();

    // Given: an org with a github connector whose stored
    // scopes match the canonical scopes.
    const matchUserId = `user_${randomUUID()}`;
    const matchOrgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: matchOrgId, userId: matchUserId },
        context.signal,
      ),
    );
    await seedGithubConnector({
      orgId: matchOrgId,
      userId: matchUserId,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });
    mocks.clerk.session(matchUserId, matchOrgId);

    // When + Then: 200 with an empty diff.
    const match = await accept(
      c.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(match.body).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });

    // Given: a stripe connector with api-token auth (no
    // scopes).
    const stripeUserId = `user_${randomUUID()}`;
    const stripeOrgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: stripeOrgId, userId: stripeUserId },
        context.signal,
      ),
    );
    await seedStripeApiTokenConnector({
      orgId: stripeOrgId,
      userId: stripeUserId,
    });
    mocks.clerk.session(stripeUserId, stripeOrgId);

    // When + Then: 200 with an empty diff (no scopes for
    // api-token auth).
    const stripe = await accept(
      c.getScopeDiff({
        params: { type: "stripe" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(stripe.body).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  });
});

describe("BDD GET /api/zero/connectors/:type/scope-diff — 200 diff chain", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnectorsByOrg(fixture.orgId);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: added scopes when the connector is missing required → removed scopes when the connector has stale extras", async () => {
    const c = client();

    // Given: a github connector with only `repo` stored.
    const missingUserId = `user_${randomUUID()}`;
    const missingOrgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: missingOrgId, userId: missingUserId },
        context.signal,
      ),
    );
    await seedGithubConnector({
      orgId: missingOrgId,
      userId: missingUserId,
      storedScopes: ["repo"],
    });
    mocks.clerk.session(missingUserId, missingOrgId);

    // When + Then: 200 with the missing scopes in addedScopes.
    const missing = await accept(
      c.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(missing.body).toStrictEqual({
      addedScopes: ["project", "workflow"],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: ["repo"],
    });

    // Given: a github connector with an extra stale scope.
    const staleUserId = `user_${randomUUID()}`;
    const staleOrgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(
        seedOrgMembership$,
        { orgId: staleOrgId, userId: staleUserId },
        context.signal,
      ),
    );
    const stored = [...GITHUB_CURRENT_SCOPES, "delete_repo"];
    await seedGithubConnector({
      orgId: staleOrgId,
      userId: staleUserId,
      storedScopes: stored,
    });
    mocks.clerk.session(staleUserId, staleOrgId);

    // When + Then: 200 with the extra scope in removedScopes.
    const stale = await accept(
      c.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(stale.body).toStrictEqual({
      addedScopes: [],
      removedScopes: ["delete_repo"],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: stored,
    });
  });
});
