import { randomUUID } from "node:crypto";

import { zeroConnectorsSearchContract } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/connectors/search", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns connectors array with correct shape", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const computer = response.body.connectors.find((c) => {
      return c.id === "computer";
    });
    expect(computer).toBeUndefined();
  });

  it("shows feature-flagged connector with api-token even when flag is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

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

    const computer = response.body.connectors.find((c) => {
      return c.id === "computer";
    });
    expect(computer).toBeUndefined();
  });

  it("includes connectors without feature flags", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsSearchContract);
    const response = await accept(
      client.search({
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const unflaggedTypes = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).filter((type) => {
      return !CONNECTOR_TYPES[type].featureFlag;
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
    mocks.clerk.session(`user_${randomUUID()}`, null);

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

  it("shows zapier with api-token even when ZapierConnector flag is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

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
    expect(zapier).toBeDefined();
    expect(zapier?.authMethods).toContain("api-token");
  });
});
