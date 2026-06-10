import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroConnectorsSearchContract,
  type ConnectorSearchItem,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  CONNECTOR_TYPE_KEYS,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    userId: `user_${prefix}_${suffix}`,
    orgId: `org_${prefix}_${suffix}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function searchClient() {
  return setupApp({ context })(zeroConnectorsSearchContract);
}

function featureSwitchesClient() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

function mockClerkMembership(member: Actor): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: member.orgId }, role: "org:admin" }],
  });
}

function zeroToken(args: {
  readonly actor: Actor;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.actor.userId,
    orgId: args.actor.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function expectConnectorsToMatchKeyword(
  connectors: readonly ConnectorSearchItem[],
  keyword: string,
): void {
  const normalized = keyword.toLowerCase();
  expect(connectors.length).toBeGreaterThan(0);
  for (const connector of connectors) {
    const matchesLabel = connector.label.toLowerCase().includes(normalized);
    const matchesDescription = connector.description
      .toLowerCase()
      .includes(normalized);
    expect(matchesLabel || matchesDescription).toBeTruthy();
  }
}

function findConnector(
  connectors: readonly ConnectorSearchItem[],
  id: string,
): ConnectorSearchItem | undefined {
  return connectors.find((connector) => {
    return connector.id === id;
  });
}

async function enableFeatureSwitches(
  member: Actor,
  switches: Record<string, boolean>,
): Promise<void> {
  mocks.clerk.session(member.userId, member.orgId);
  await accept(
    featureSwitchesClient().update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
  await trackFeatureSwitchActor(Promise.resolve(member));
}

async function deleteFeatureSwitches(member: Actor): Promise<void> {
  mocks.clerk.session(member.userId, member.orgId);
  await accept(
    featureSwitchesClient().delete({
      headers: authHeaders(),
    }),
    [200],
  );
}

const trackFeatureSwitchActor = createFixtureTracker<Actor>(
  deleteFeatureSwitches,
);

describe("/api/zero/connectors/search BDD", () => {
  it("requires authentication, an active organization, and sandbox connector:read capability", async () => {
    const client = searchClient();

    const unauthenticated = await accept(
      client.search({ query: {}, headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.search({
        query: {},
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    const member = actor("connectors_auth");
    const token = zeroToken({ actor: member, capabilities: [] });
    const missingCapability = await accept(
      client.search({
        query: {},
        headers: bearerHeaders(token),
      }),
      [403],
    );

    expect(missingCapability.body.error.code).toBe("FORBIDDEN");
  });

  it("lists searchable connectors and filters keywords case-insensitively", async () => {
    const member = actor("connectors_search");
    mocks.clerk.session(member.userId, member.orgId);
    const client = searchClient();

    const allConnectors = await accept(
      client.search({
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );

    expect(allConnectors.body.connectors.length).toBeGreaterThan(0);
    for (const connector of allConnectors.body.connectors) {
      expect(typeof connector.id).toBe("string");
      expect(typeof connector.label).toBe("string");
      expect(typeof connector.description).toBe("string");
      expect(connector.authMethods).toBeInstanceOf(Array);
    }

    const github = await accept(
      client.search({
        query: { keyword: "GitHub" },
        headers: authHeaders(),
      }),
      [200],
    );

    expectConnectorsToMatchKeyword(github.body.connectors, "github");

    const slack = await accept(
      client.search({
        query: { keyword: "slack" },
        headers: authHeaders(),
      }),
      [200],
    );

    expectConnectorsToMatchKeyword(slack.body.connectors, "slack");

    const noMatch = await accept(
      client.search({
        query: { keyword: "zzz_no_match_zzz" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(noMatch.body.connectors).toStrictEqual([]);

    const lower = await accept(
      client.search({
        query: { keyword: "github" },
        headers: authHeaders(),
      }),
      [200],
    );
    const upper = await accept(
      client.search({
        query: { keyword: "GITHUB" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(lower.body.connectors).toHaveLength(upper.body.connectors.length);
  });

  it("applies connector feature gates while retaining ungated auth methods", async () => {
    const member = actor("connectors_gates");
    mocks.clerk.session(member.userId, member.orgId);
    const client = searchClient();

    const disabledTestOAuth = await accept(
      client.search({
        query: { keyword: "test oauth device" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(
      findConnector(disabledTestOAuth.body.connectors, "test-oauth-device"),
    ).toBeUndefined();

    const base44 = await accept(
      client.search({
        query: { keyword: "base44" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      findConnector(base44.body.connectors, "base44")?.authMethods,
    ).toStrictEqual(["oauth"]);

    const slock = await accept(
      client.search({
        query: { keyword: "slock" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      findConnector(slock.body.connectors, "slock")?.authMethods,
    ).toStrictEqual(["oauth"]);

    const allConnectors = await accept(
      client.search({
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const neon = findConnector(allConnectors.body.connectors, "neon");
    expect(neon).toBeDefined();
    expect(neon?.authMethods).toContain("api-token");
    expect(neon?.authMethods).not.toContain("oauth");

    expect(
      findConnector(allConnectors.body.connectors, "openai")?.authMethods,
    ).toStrictEqual(["api-token"]);
    expect(
      findConnector(allConnectors.body.connectors, "zapier"),
    ).toBeUndefined();

    const unflaggedTypes = CONNECTOR_TYPE_KEYS.filter((type) => {
      return Object.values(CONNECTOR_TYPES[type].authMethods).some((method) => {
        return !method.featureFlag;
      });
    });
    expect(unflaggedTypes.length).toBeGreaterThan(0);

    for (const type of unflaggedTypes) {
      expect(findConnector(allConnectors.body.connectors, type)).toBeDefined();
    }

    await enableFeatureSwitches(member, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const enabledTestOAuth = await accept(
      client.search({
        query: { keyword: "test oauth device" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(
      findConnector(enabledTestOAuth.body.connectors, "test-oauth-device")
        ?.authMethods,
    ).toStrictEqual(["oauth", "api"]);
  });

  it("accepts zero tokens carrying the connector:read capability", async () => {
    const member = actor("connectors_zero");
    mockClerkMembership(member);
    const token = zeroToken({
      actor: member,
      capabilities: ["connector:read"],
    });

    const response = await accept(
      searchClient().search({
        query: {},
        headers: bearerHeaders(token),
      }),
      [200],
    );

    expect(response.body.connectors).toBeInstanceOf(Array);
    expect(response.body.connectors.length).toBeGreaterThan(0);
  });
});
