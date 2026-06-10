import { randomUUID } from "node:crypto";

import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

// BDD migration of the legacy `zero-connectors-list.test.ts`. The
// legacy direct DB SELECTs that verified row presence / absence are
// replaced by assertions on the contract's `connectors` array. The
// "does not infer from legacy secrets" check is preserved by seeding
// a user-owned OPENAI_TOKEN secret and asserting the response has no
// `openai` connector. The 6 legacy `it()`s collapse into 2 BDD
// `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroConnectorsMainContract);
}

describe("BDD GET /api/zero/connectors — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(c.list({ headers: {} }), [401]);
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(c.list({ headers: authHeaders() }), [401]);
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");
  });
});

const track = createFixtureTracker<OrgMembershipFixture>((fixture) => {
  return store.set(deleteOrgMembership$, fixture, context.signal);
});

async function seedConnectorRow(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: args.type,
    authMethod: "oauth",
  });
}

describe("BDD GET /api/zero/connectors — list chain", () => {
  it("gwt-wt-wt: empty → with connector (github shown) → orphan removed (skipped by contract) → no inference from legacy secrets", async () => {
    const c = client();

    // Given: a fresh user/org with no connectors.
    const fixture = await track(
      store.set(
        seedOrgMembership$,
        {
          orgId: `org_${randomUUID()}`,
          userId: `user_${randomUUID()}`,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: the list is empty (with empty configured/bindings
    // arrays for shape).
    const empty = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(empty.body.connectors).toStrictEqual([]);
    expect(Array.isArray(empty.body.configuredTypes)).toBeTruthy();
    expect(Array.isArray(empty.body.connectorProvidedBindings)).toBeTruthy();

    // Given: a `github` connector is seeded for the org.
    await seedConnectorRow({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "github",
    });

    // When + Then: the list now contains the github connector.
    const withConnector = await accept(
      c.list({ headers: authHeaders() }),
      [200],
    );
    expect(
      withConnector.body.connectors.some((row) => {
        return row.type === "github";
      }),
    ).toBeTruthy();

    // Given: a connector whose type no longer exists in the contract.
    await seedConnectorRow({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "__removed_connector__",
    });

    // When + Then: the list skips the orphan (it's filtered by the
    // contract's type registry).
    const withOrphan = await accept(c.list({ headers: authHeaders() }), [200]);
    const orphan = withOrphan.body.connectors.find((row) => {
      return (row.type as string) === "__removed_connector__";
    });
    expect(orphan).toBeUndefined();

    // Given: a user-owned legacy OPENAI_TOKEN secret.
    const writeDb = store.set(writeDb$);
    await writeDb.insert(secrets).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "OPENAI_TOKEN",
      encryptedValue: "encrypted_openai_token",
      type: "user",
    });

    // When + Then: the list does not infer an `openai` connector from
    // the legacy user-owned secret.
    const afterSecret = await accept(c.list({ headers: authHeaders() }), [200]);
    const openai = afterSecret.body.connectors.find((row) => {
      return row.type === "openai";
    });
    expect(openai).toBeUndefined();
  });
});
