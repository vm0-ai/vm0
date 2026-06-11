import { randomUUID } from "node:crypto";

import { zeroConnectorsSearchContract } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, it } from "vitest";

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

// BDD migration of the legacy `zero-connectors-search.test.ts`.
// The 16 legacy `it()`s collapse into 4 BDD `it()`s:
// (1) auth + shape + keyword filter chain (401
// unauthenticated → 200 returns shape → 200 filter by
// label → 200 filter by description → 200 no match →
// 200 case-insensitive search),
// (2) feature switch chain (200 hides test OAuth device
// when disabled → 200 shows test OAuth device when
// enabled → 200 shows Base44 without switch → 200
// shows Slock without switch),
// (3) auth method gating chain (200 ungated api-token
// exposed → 200 openai is api-token only → 200 zapier
// hidden when gated → 200 ungated auth methods are
// present),
// (4) zero token capability chain (200 with
// connector:read capability → 403 without capability).

const context = testContext();
const mocks = createZeroRouteMocks(context);
const store = createStore();

async function enableFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches,
  });
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function apiClient() {
  return setupApp({ context })(zeroConnectorsSearchContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD GET /api/zero/connectors/search — auth + shape + keyword filter chain", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await writeDb
          .delete(userFeatureSwitches)
          .where(
            and(
              eq(userFeatureSwitches.orgId, fixture.orgId),
              eq(userFeatureSwitches.userId, fixture.userId),
            ),
          );
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 401 unauthenticated → 200 returns shape → 200 filter by label → 200 filter by description → 200 no match → 200 case-insensitive search", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().search({ query: {}, headers: {} }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a fresh Clerk session.

    // When + Then: 200 — response.connectors is a
    // non-empty array and every connector has the
    // expected shape.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const shapeResponse = await accept(
      apiClient().search({ query: {}, headers: sessionHeaders() }),
      [200],
    );
    expect(shapeResponse.body.connectors).toBeInstanceOf(Array);
    expect(shapeResponse.body.connectors.length).toBeGreaterThan(0);
    for (const connector of shapeResponse.body.connectors) {
      expect(connector).toHaveProperty("id");
      expect(connector).toHaveProperty("label");
      expect(connector).toHaveProperty("description");
      expect(connector).toHaveProperty("authMethods");
      expect(typeof connector.id).toBe("string");
      expect(typeof connector.label).toBe("string");
      expect(typeof connector.description).toBe("string");
      expect(connector.authMethods).toBeInstanceOf(Array);
    }

    // Given: a fresh Clerk session.

    // When + Then: 200 — keyword=GitHub returns only
    // connectors whose label or description contains
    // `github` (case-insensitive).
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const labelResponse = await accept(
      apiClient().search({
        query: { keyword: "GitHub" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(labelResponse.body.connectors.length).toBeGreaterThan(0);
    for (const connector of labelResponse.body.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("github");
      const matchesDescription = connector.description
        .toLowerCase()
        .includes("github");
      expect(matchesLabel || matchesDescription).toBeTruthy();
    }

    // Given: a fresh Clerk session.

    // When + Then: 200 — keyword=slack returns only
    // connectors whose label or description contains
    // `slack`.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const descriptionResponse = await accept(
      apiClient().search({
        query: { keyword: "slack" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(descriptionResponse.body.connectors.length).toBeGreaterThan(0);
    for (const connector of descriptionResponse.body.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("slack");
      const matchesDescription = connector.description
        .toLowerCase()
        .includes("slack");
      expect(matchesLabel || matchesDescription).toBeTruthy();
    }

    // Given: a fresh Clerk session + a keyword that
    // matches nothing.

    // When + Then: 200 — empty array.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const emptyResponse = await accept(
      apiClient().search({
        query: { keyword: "zzz_no_match_zzz" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(emptyResponse.body.connectors).toStrictEqual([]);

    // Given: a fresh Clerk session.

    // When + Then: 200 — keyword=github and
    // keyword=GITHUB return the same number of
    // connectors (case-insensitive).
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const lowerResponse = await accept(
      apiClient().search({
        query: { keyword: "github" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    const upperResponse = await accept(
      apiClient().search({
        query: { keyword: "GITHUB" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    expect(lowerResponse.body.connectors).toHaveLength(
      upperResponse.body.connectors.length,
    );
  });
});

describe("BDD GET /api/zero/connectors/search — feature switch chain", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await writeDb
          .delete(userFeatureSwitches)
          .where(
            and(
              eq(userFeatureSwitches.orgId, fixture.orgId),
              eq(userFeatureSwitches.userId, fixture.userId),
            ),
          );
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 hides test OAuth device when disabled → 200 shows test OAuth device when enabled → 200 shows Base44 without switch → 200 shows Slock without switch", async () => {
    // Given: a fresh Clerk session + no feature switch
    // for the test OAuth device connector.

    // When + Then: 200 — test-oauth-device is hidden
    // from the results.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const disabledResponse = await accept(
      apiClient().search({
        query: { keyword: "test oauth device" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    const disabledConnector = disabledResponse.body.connectors.find((c) => {
      return c.id === "test-oauth-device";
    });
    expect(disabledConnector).toBeUndefined();

    // Given: a Clerk session + the test OAuth device
    // feature switch enabled.

    // When + Then: 200 — test-oauth-device is present
    // and exposes both oauth and api auth methods.
    const enabledUserId = `user_${randomUUID()}`;
    const enabledOrgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId: enabledOrgId, userId: enabledUserId });
    await enableFeatureSwitches(enabledOrgId, enabledUserId, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mocks.clerk.session(enabledUserId, enabledOrgId);
    const enabledResponse = await accept(
      apiClient().search({
        query: { keyword: "test oauth device" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    const enabledConnector = enabledResponse.body.connectors.find((c) => {
      return c.id === "test-oauth-device";
    });
    expect(enabledConnector).toBeDefined();
    expect(enabledConnector?.authMethods).toStrictEqual(["oauth", "api"]);

    // Given: a fresh Clerk session + no feature switch
    // for Base44.

    // When + Then: 200 — Base44 is present with the
    // oauth auth method.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const base44Response = await accept(
      apiClient().search({
        query: { keyword: "base44" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    const base44Connector = base44Response.body.connectors.find((c) => {
      return c.id === "base44";
    });
    expect(base44Connector).toBeDefined();
    expect(base44Connector?.authMethods).toStrictEqual(["oauth"]);

    // Given: a fresh Clerk session + no feature switch
    // for Slock.

    // When + Then: 200 — Slock is present with the
    // oauth auth method.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const slockResponse = await accept(
      apiClient().search({
        query: { keyword: "slock" },
        headers: sessionHeaders(),
      }),
      [200],
    );
    const slockConnector = slockResponse.body.connectors.find((c) => {
      return c.id === "slock";
    });
    expect(slockConnector).toBeDefined();
    expect(slockConnector?.authMethods).toStrictEqual(["oauth"]);
  });
});

describe("BDD GET /api/zero/connectors/search — auth method gating chain", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await writeDb
          .delete(userFeatureSwitches)
          .where(
            and(
              eq(userFeatureSwitches.orgId, fixture.orgId),
              eq(userFeatureSwitches.userId, fixture.userId),
            ),
          );
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 ungated api-token exposed → 200 openai is api-token only → 200 zapier hidden when gated → 200 ungated auth methods are present", async () => {
    // Given: a fresh Clerk session.

    // When + Then: 200 — Neon is present with
    // api-token but not oauth.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const ungatedResponse = await accept(
      apiClient().search({ query: {}, headers: sessionHeaders() }),
      [200],
    );
    const neon = ungatedResponse.body.connectors.find((c) => {
      return c.id === "neon";
    });
    expect(neon).toBeDefined();
    expect(neon?.authMethods).toContain("api-token");
    expect(neon?.authMethods).not.toContain("oauth");

    // Given: a fresh Clerk session.

    // When + Then: 200 — openai is present and only
    // exposes the api-token auth method.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const openaiResponse = await accept(
      apiClient().search({ query: {}, headers: sessionHeaders() }),
      [200],
    );
    const openai = openaiResponse.body.connectors.find((c) => {
      return c.id === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai?.authMethods).toStrictEqual(["api-token"]);

    // Given: a fresh Clerk session.

    // When + Then: 200 — Zapier is hidden because
    // every one of its auth methods is feature-gated.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const zapierResponse = await accept(
      apiClient().search({ query: {}, headers: sessionHeaders() }),
      [200],
    );
    const zapier = zapierResponse.body.connectors.find((c) => {
      return c.id === "zapier";
    });
    expect(zapier).toBeUndefined();

    // Given: a fresh Clerk session.

    // When + Then: 200 — every connector type with at
    // least one ungated auth method is present.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const ungatedTypesResponse = await accept(
      apiClient().search({ query: {}, headers: sessionHeaders() }),
      [200],
    );
    const unflaggedTypes = CONNECTOR_TYPE_KEYS.filter((type) => {
      return Object.values(CONNECTOR_TYPES[type].authMethods).some((method) => {
        return !method.featureFlag;
      });
    });
    expect(unflaggedTypes.length).toBeGreaterThan(0);
    for (const type of unflaggedTypes) {
      const found = ungatedTypesResponse.body.connectors.find((c) => {
        return c.id === type;
      });
      expect(found).toBeDefined();
    }
  });
});

describe("BDD GET /api/zero/connectors/search — zero token capability chain", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await writeDb
          .delete(userFeatureSwitches)
          .where(
            and(
              eq(userFeatureSwitches.orgId, fixture.orgId),
              eq(userFeatureSwitches.userId, fixture.userId),
            ),
          );
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 with connector:read capability → 403 without capability", async () => {
    // Given: a seeded org membership + a zero token
    // with the connector:read capability.

    // When + Then: 200 — the connector list is
    // returned as a non-empty array.
    const allowUserId = `user_${randomUUID()}`;
    const allowOrgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId: allowOrgId, userId: allowUserId, role: "admin" },
        context.signal,
      ),
    );
    const allowSeconds = currentSecond();
    const allowToken = signSandboxJwtForTests({
      scope: "zero",
      userId: allowUserId,
      orgId: allowOrgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: allowSeconds,
      exp: allowSeconds + 600,
    });
    const allowedResponse = await accept(
      apiClient().search({
        query: {},
        headers: { authorization: `Bearer ${allowToken}` },
      }),
      [200],
    );
    expect(allowedResponse.body.connectors).toBeInstanceOf(Array);
    expect(allowedResponse.body.connectors.length).toBeGreaterThan(0);

    // Given: a seeded org membership + a zero token
    // with no capabilities.

    // When + Then: 403 — FORBIDDEN.
    const denyUserId = `user_${randomUUID()}`;
    const denyOrgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId: denyOrgId, userId: denyUserId, role: "admin" },
        context.signal,
      ),
    );
    const denySeconds = currentSecond();
    const denyToken = signSandboxJwtForTests({
      scope: "zero",
      userId: denyUserId,
      orgId: denyOrgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: denySeconds,
      exp: denySeconds + 600,
    });
    const deniedResponse = await accept(
      apiClient().search({
        query: {},
        headers: { authorization: `Bearer ${denyToken}` },
      }),
      [403],
    );
    expect(deniedResponse.body.error.code).toBe("FORBIDDEN");
  });
});
