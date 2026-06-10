import { randomUUID } from "node:crypto";

import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-connectors-by-type-get.test.ts`. The 6 legacy `it()`s
// collapse into 3 BDD `it()`s: (1) auth boundary chain (401
// unauth → 401 no-org → 404 no connector), (2) 200 success
// chain (200 returns the connector with that type → 404 for
// legacy user-owned secret without a connector row), (3) 200
// sandbox token chain (sandbox JWT with `connector:read` is
// accepted).
//
// Service-Level Exception: connector rows are seeded directly
// via `writeDb$` because no public route creates a connector
// (connectors are provisioned by the OAuth callback flow, not
// the public API).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

async function seedConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly authMethod?: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: args.type,
    authMethod: args.authMethod ?? "oauth",
  });
}

const track = createFixtureTracker<OrgMembershipFixture>((fixture) => {
  return store.set(deleteOrgMembership$, fixture, context.signal);
});

async function trackFixture(
  orgId: string,
  userId: string,
): Promise<OrgMembershipFixture> {
  const fixture = await store.set(
    seedOrgMembership$,
    { orgId, userId },
    context.signal,
  );
  return track(Promise.resolve(fixture));
}

describe("BDD GET /api/zero/connectors/:type — auth boundary", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 404 no connector", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client().get({ params: { type: "github" }, headers: {} }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session that resolves to a user without an org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      client().get({ params: { type: "github" }, headers: authHeaders() }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // Given: an authenticated session with an org but no
    // connector of the requested type.
    const fixture = await trackFixture(
      `org_${randomUUID()}`,
      `user_${randomUUID()}`,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404.
    const noConnector = await accept(
      client().get({ params: { type: "github" }, headers: authHeaders() }),
      [404],
    );
    expect(noConnector.body.error.code).toBe("NOT_FOUND");
  });
});

describe("BDD GET /api/zero/connectors/:type — 200 success + 404 legacy chain", () => {
  it("gwt-wt-wt: 200 returns the connector with the requested type → 404 for legacy user-owned secret without a connector row", async () => {
    // Given: an org membership + a github connector row.
    const fixture = await trackFixture(
      `org_${randomUUID()}`,
      `user_${randomUUID()}`,
    );
    await seedConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "github",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 200 with the connector.
    const ok = await accept(
      client().get({ params: { type: "github" }, headers: authHeaders() }),
      [200],
    );
    expect(ok.body.type).toBe("github");

    // Given: a fresh org with a legacy user-owned secret but
    // no connector row.
    const legacyFixture = await trackFixture(
      `org_${randomUUID()}`,
      `user_${randomUUID()}`,
    );
    const writeDb = store.set(writeDb$);
    await writeDb.insert(secrets).values({
      orgId: legacyFixture.orgId,
      userId: legacyFixture.userId,
      name: "OPENAI_TOKEN",
      encryptedValue: "encrypted_openai_token",
      type: "user",
    });
    mocks.clerk.session(legacyFixture.userId, legacyFixture.orgId);

    // When + Then: 404 — legacy secrets without a connector
    // row are not enough.
    const legacy = await accept(
      client().get({ params: { type: "openai" }, headers: authHeaders() }),
      [404],
    );
    expect(legacy.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/zero/connectors/:type — sandbox token", () => {
  it("gwt-wt-wt: 200 sandbox token with connector:read capability is accepted", async () => {
    // Given: an org membership + a github connector row.
    const fixture = await trackFixture(
      `org_${randomUUID()}`,
      `user_${randomUUID()}`,
    );
    await seedConnector({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "github",
    });
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 200.
    const sandbox = await accept(
      client().get({
        params: { type: "github" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(sandbox.body.type).toBe("github");
  });
});
