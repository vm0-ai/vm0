import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteCustomConnectorOrg$,
  seedCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";

// BDD migration of the legacy `zero-custom-connectors-create.test.ts`.
// The 9 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// boundary (401 unauth → 401 no-org → 403 non-admin), (2) 201
// success chain (admin creates connector + DB read-after-write
// confirms row → list endpoint echoes the new connector → admin
// creates a host-wildcard prefix connector → admin creates with a
// non-trailing slash prefix which gets normalised), (3) 400
// validation chain (rejects missing {{secret}} placeholder →
// rejects non-https prefix → rejects host collision with a
// built-in connector).
//
// Service-Level Exception: post-create verification uses direct
// DB reads against `org_custom_connectors` because no follow-up
// GET endpoint for a single custom connector is available. The
// list endpoint is the canonical read-after-write check.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function validBody() {
  return {
    displayName: "Example",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
  return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
});

function tracked(
  orgId: string,
  userId: string,
  connectorId: string,
): Promise<CustomConnectorFixture> {
  return track(Promise.resolve({ orgId, userId, connectorId }));
}

describe("BDD POST /api/zero/custom-connectors — auth + 403 chain", () => {
  it("gwt-wt-wt: 401 unauth → 401 no-org → 403 non-admin", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.create({ body: validBody(), headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    const noOrgFx = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(noOrgFx.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.create({ body: validBody(), headers: authHeaders() }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a non-admin org member.
    const memberFx = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(memberFx.userId, memberFx.orgId, "org:member");

    // When + Then: 403 — non-admin cannot create.
    const nonAdmin = await accept(
      c.create({ body: validBody(), headers: authHeaders() }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can create custom connectors",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("BDD POST /api/zero/custom-connectors — 201 success chain", () => {
  it("gwt-wt-wt: admin creates a connector + DB read-after-write + list echoes it → admin creates a host-wildcard prefix connector → admin creates with a non-trailing slash prefix that gets normalised", async () => {
    const c = client();

    // Given: an org + admin user.
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    // When: admin creates a connector.
    const created = await accept(
      c.create({ body: validBody(), headers: authHeaders() }),
      [201],
    );

    // Then: 201 with the expected body shape.
    expect(created.body.slug).toMatch(/^api-example-com-/);
    expect(created.body.displayName).toBe("Example");
    expect(created.body.prefixes).toStrictEqual(["https://api.example.com/"]);
    expect(created.body.hasSecret).toBeFalsy();

    // Then: DB read-after-write confirms the row.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, created.body.id));
    expect(row?.orgId).toBe(orgId);
    expect(row?.createdBy).toBe(userId);
    await tracked(orgId, userId, created.body.id);

    // When + Then: the list endpoint echoes the new connector.
    const list = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(list.body.connectors).toStrictEqual([created.body]);

    // Given: an admin in a fresh org creates a connector
    // with a host-wildcard prefix.
    const wildcardOrgId = `org_${randomUUID()}`;
    const wildcardUserId = `user_${randomUUID()}`;
    mocks.clerk.session(wildcardUserId, wildcardOrgId, "org:admin");
    const wildcard = await accept(
      c.create({
        body: {
          ...validBody(),
          prefixes: ["https://*.example.com/v1"],
        },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(wildcard.body.slug).toMatch(/^example-com-/);
    expect(wildcard.body.prefixes).toStrictEqual(["https://*.example.com/v1/"]);
    await tracked(wildcardOrgId, wildcardUserId, wildcard.body.id);

    // Given: an admin in another fresh org creates a
    // connector with a non-trailing slash prefix.
    const normOrgId = `org_${randomUUID()}`;
    const normUserId = `user_${randomUUID()}`;
    mocks.clerk.session(normUserId, normOrgId, "org:admin");
    const normalised = await accept(
      c.create({
        body: {
          ...validBody(),
          prefixes: ["https://api.example.com/v1"],
        },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(normalised.body.prefixes).toStrictEqual([
      "https://api.example.com/v1/",
    ]);
    await tracked(normOrgId, normUserId, normalised.body.id);
  });
});

describe("BDD POST /api/zero/custom-connectors — 400 validation chain", () => {
  it("gwt-wt-wt: 400 missing {{secret}} placeholder → 400 non-https prefix → 400 host collision with built-in connector", async () => {
    const c = client();

    // Given: an admin user.
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");

    // When + Then: 400 — missing {{secret}} placeholder.
    const badTemplate = await accept(
      c.create({
        body: { ...validBody(), headerTemplate: "Bearer static-token" },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(badTemplate.body.error.code).toBe("BAD_REQUEST");
    expect(badTemplate.body.error.message).toContain("{{secret}}");

    // When + Then: 400 — non-https prefix.
    const badPrefix = await accept(
      c.create({
        body: { ...validBody(), prefixes: ["http://api.example.com/"] },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(badPrefix.body.error.code).toBe("BAD_REQUEST");
    expect(badPrefix.body.error.message).toContain("https");

    // When + Then: 400 — host collides with a built-in
    // connector.
    const hostCollision = await accept(
      c.create({
        body: {
          ...validBody(),
          displayName: "Fake GitHub",
          prefixes: ["https://api.github.com/v3/"],
        },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(hostCollision.body.error.code).toBe("BAD_REQUEST");
    expect(hostCollision.body.error.message).toContain("api.github.com");
    expect(hostCollision.body.error.message).toContain("GitHub");
  });
});
