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
import { afterEach } from "vitest";

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

const context = testContext();
const mocks = createZeroRouteMocks(context);
const store = createStore();

async function enableLocalBrowser(
  orgId: string,
  userId: string,
): Promise<void> {
  await enableFeatureSwitches(orgId, userId, {
    [FeatureSwitchKey.LocalBrowserUse]: true,
  });
}

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

describe("GET /api/zero/connectors/search", () => {
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

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns connectors array with correct shape", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors).toBeInstanceOf(Array);
    expect(response.body.connectors.length).toBeGreaterThan(0);
    for (const connector of response.body.connectors) {
      expect(connector).toHaveProperty("id");
      expect(connector).toHaveProperty("label");
      expect(connector).toHaveProperty("description");
      expect(connector).toHaveProperty("authMethods");
      expect(typeof connector.id).toBe("string");
      expect(typeof connector.label).toBe("string");
      expect(typeof connector.description).toBe("string");
      expect(connector.authMethods).toBeInstanceOf(Array);
    }
  });

  it("filters connectors by keyword matching label", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "GitHub" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThan(0);
    for (const connector of response.body.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("github");
      const matchesDescription = connector.description
        .toLowerCase()
        .includes("github");
      expect(matchesLabel || matchesDescription).toBeTruthy();
    }
  });

  it("filters connectors by keyword matching description", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "slack" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThan(0);
    for (const connector of response.body.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("slack");
      const matchesDescription = connector.description
        .toLowerCase()
        .includes("slack");
      expect(matchesLabel || matchesDescription).toBeTruthy();
    }
  });

  it("returns empty array for non-matching keyword", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "zzz_no_match_zzz" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
  });

  it("performs case-insensitive keyword search", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);

    const lower = await accept(
      client.search({
        query: { keyword: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const upper = await accept(
      client.search({
        query: { keyword: "GITHUB" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(lower.body.connectors).toHaveLength(upper.body.connectors.length);
  });

  it("hides feature-flagged connectors without api-token for non-enabled users", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const localAgent = response.body.connectors.find((c) => {
      return c.id === "local-agent";
    });
    expect(localAgent).toBeUndefined();
  });

  it("hides the test OAuth device connector when the test OAuth feature is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "test oauth device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connector = response.body.connectors.find((c) => {
      return c.id === "test-oauth-device";
    });
    expect(connector).toBeUndefined();
  });

  it("shows the test OAuth device connector when the test OAuth feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "test oauth device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connector = response.body.connectors.find((c) => {
      return c.id === "test-oauth-device";
    });
    expect(connector).toBeDefined();
    expect(connector?.authMethods).toStrictEqual(["oauth"]);
  });

  it("shows Base44 as an OAuth connector without a feature switch", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "base44" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connector = response.body.connectors.find((c) => {
      return c.id === "base44";
    });
    expect(connector).toBeDefined();
    expect(connector?.authMethods).toStrictEqual(["oauth"]);
  });

  it("shows Slock as an OAuth connector without a feature switch", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "slock" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const connector = response.body.connectors.find((c) => {
      return c.id === "slock";
    });
    expect(connector).toBeDefined();
    expect(connector?.authMethods).toStrictEqual(["oauth"]);
  });

  it("hides local-browser when the feature is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const localBrowser = response.body.connectors.find((c) => {
      return c.id === "local-browser";
    });
    expect(localBrowser).toBeUndefined();
  });

  it("shows local-browser as an api connector when the feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId, userId });
    await enableLocalBrowser(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const localBrowser = response.body.connectors.find((c) => {
      return c.id === "local-browser";
    });
    expect(localBrowser).toBeDefined();
    expect(localBrowser?.authMethods).toStrictEqual(["api"]);
  });

  it("shows Stripe CLI auth when the feature switch is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.CliAuthStripe]: true,
      [FeatureSwitchKey.StripeConnector]: false,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const stripe = response.body.connectors.find((c) => {
      return c.id === "stripe";
    });
    expect(stripe).toBeDefined();
    expect(stripe?.authMethods).toStrictEqual(["api-token", "cli-auth"]);
  });

  it("shows ungated api-token while hiding feature-gated oauth", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const neon = response.body.connectors.find((c) => {
      return c.id === "neon";
    });
    expect(neon).toBeDefined();
    expect(neon?.authMethods).toContain("api-token");
    expect(neon?.authMethods).not.toContain("oauth");
  });

  it("hides feature-flagged connector when feature is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const localAgent = response.body.connectors.find((c) => {
      return c.id === "local-agent";
    });
    expect(localAgent).toBeUndefined();
  });

  it("includes connectors with at least one ungated auth method", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const unflaggedTypes = CONNECTOR_TYPE_KEYS.filter((type) => {
      return Object.values(CONNECTOR_TYPES[type].authMethods).some((method) => {
        return !method.featureFlag;
      });
    });
    expect(unflaggedTypes.length).toBeGreaterThan(0);

    for (const type of unflaggedTypes) {
      const found = response.body.connectors.find((c) => {
        return c.id === type;
      });
      expect(found).toBeDefined();
    }
  });

  it("exposes openai as api-token only", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const openai = response.body.connectors.find((c) => {
      return c.id === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai?.authMethods).toStrictEqual(["api-token"]);
  });

  it("hides zapier when its api-token auth method is feature-gated", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const zapier = response.body.connectors.find((c) => {
      return c.id === "zapier";
    });
    expect(zapier).toBeUndefined();
  });

  it("accepts a ZERO_TOKEN carrying the connector:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.connectors).toBeInstanceOf(Array);
    expect(response.body.connectors.length).toBeGreaterThan(0);
  });

  it("rejects a ZERO_TOKEN missing the connector:read capability with 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
