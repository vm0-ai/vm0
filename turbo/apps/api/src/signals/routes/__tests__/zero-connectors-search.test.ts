import { randomUUID } from "node:crypto";

import { zeroConnectorsSearchContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const store = createStore();

function featureSwitchesClient() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function enableFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  await accept(
    featureSwitchesClient().update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  await accept(
    featureSwitchesClient().delete({ headers: authHeaders() }),
    [200],
  );
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/connectors/search", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];

  afterEach(async () => {
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await deleteFeatureSwitches(fixture.orgId, fixture.userId);
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
      expect(connector.slug).toBe(connector.id);
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
        query: { keyword: "permission behavior" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.connectors.map((connector) => {
        return connector.id;
      }),
    ).toStrictEqual(["slack"]);
  });

  it("filters connectors by keyword matching tags", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "llm" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      response.body.connectors.map((connector) => {
        return connector.id;
      }),
    ).toStrictEqual(["openai"]);
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
    expect(connector?.authMethods).toStrictEqual(["oauth", "api"]);
  });

  it("applies accepted auth method visibility to connector search", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, {});
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: { keyword: "cloudflare" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const cloudflare = response.body.connectors.find((connector) => {
      return connector.id === "cloudflare";
    });
    expect(cloudflare?.authMethods).toStrictEqual(["oauth"]);
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

  it("accepts a ZERO_TOKEN carrying the connector:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
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
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
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
