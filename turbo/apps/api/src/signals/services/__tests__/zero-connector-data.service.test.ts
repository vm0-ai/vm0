import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  zeroConnectorByType,
  zeroConnectorList,
  zeroConnectorSearch,
} from "../zero-connector-data.service";

const store = createStore();
const writeDb = store.set(writeDb$);

describe("zeroConnectorList", () => {
  it("assigns fixed sentinel timestamps to derived api-token connectors", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    // Seed OPENAI_TOKEN so openai is derived as a connected api-token connector
    await writeDb.insert(secrets).values({
      orgId,
      userId,
      name: "OPENAI_TOKEN",
      encryptedValue: "encrypted_openai_token",
      type: "user",
    });

    const list = await store.get(zeroConnectorList({ orgId, userId }));
    const openai = list.connectors.find((c) => {
      return c.type === "openai";
    });

    expect(openai).toBeDefined();
    if (openai) {
      expect(openai.createdAt).toBe("1970-01-01T00:00:00.000Z");
      expect(openai.updatedAt).toBe("1970-01-01T00:00:00.000Z");
    }
  });

  it("returns configuredTypes in sorted order", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    const list = await store.get(zeroConnectorList({ orgId, userId }));

    const sorted = [...list.configuredTypes].sort();
    expect(list.configuredTypes).toStrictEqual(sorted);
  });

  it("returns configuredTypes from OAuth runtime env", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockOptionalEnv("AIRTABLE_OAUTH_CLIENT_ID", "airtable-client-id");
    mockOptionalEnv("AIRTABLE_OAUTH_CLIENT_SECRET", "airtable-client-secret");

    const list = await store.get(zeroConnectorList({ orgId, userId }));

    expect(list.configuredTypes).toContain("airtable");
    expect(list.configuredTypes).toContain("amplitude");
  });

  it("keeps a stored oauth connector visible when another auth method is ungated", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(connectors).values({
      orgId,
      userId,
      type: "neon",
      authMethod: "oauth",
    });
    await writeDb.insert(secrets).values({
      orgId,
      userId,
      name: "NEON_TOKEN",
      encryptedValue: "encrypted_neon_token",
      type: "user",
    });

    const connector = await store.get(
      zeroConnectorByType({ orgId, userId, type: "neon" }),
    );

    expect(connector?.authMethod).toBe("oauth");
    expect(connector?.id).not.toBeNull();
  });

  it("hides a stored connector when all auth methods are feature-gated", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(connectors).values({
      orgId,
      userId,
      type: "lark",
      authMethod: "api-token",
    });

    const connector = await store.get(
      zeroConnectorByType({ orgId, userId, type: "lark" }),
    );

    expect(connector).toBeNull();
  });
});

describe("zeroConnectorSearch", () => {
  async function stripeSearchAuthMethods(
    switches: Partial<Record<FeatureSwitchKey, boolean>>,
  ) {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    if (Object.keys(switches).length > 0) {
      await writeDb.insert(userFeatureSwitches).values({
        orgId,
        userId,
        switches,
      });
    }

    const connectors = await store.get(
      zeroConnectorSearch({ orgId, userId, keyword: "stripe" }),
    );

    const stripe = connectors.find((connector) => {
      return connector.id === "stripe";
    });
    expect(stripe).toBeDefined();
    return stripe?.authMethods ?? [];
  }

  it("hides feature-flagged api-token connectors when the flag is disabled", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    const connectors = await store.get(
      zeroConnectorSearch({ orgId, userId, keyword: "zapier" }),
    );

    const zapier = connectors.find((connector) => {
      return connector.id === "zapier";
    });
    expect(zapier).toBeUndefined();
  });

  it("shows feature-flagged api-token connectors when an override enables the flag", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.ZapierConnector]: true },
    });

    const connectors = await store.get(
      zeroConnectorSearch({ orgId, userId, keyword: "zapier" }),
    );

    const zapier = connectors.find((connector) => {
      return connector.id === "zapier";
    });
    expect(zapier?.authMethods).toStrictEqual(["api-token"]);
  });

  it.each([
    ["no Stripe CLI auth switch", {}, false],
    [
      "Stripe CLI auth without StripeConnector",
      {
        [FeatureSwitchKey.CliAuthStripe]: true,
        [FeatureSwitchKey.StripeConnector]: false,
      },
      true,
    ],
  ] as const)(
    "sets Stripe API search CLI auth availability for %s",
    async (_name, switches, expectedCliAuth) => {
      const authMethods = await stripeSearchAuthMethods(switches);

      expect(authMethods).toContain("api-token");
      expect(authMethods.includes("cli-auth")).toBe(expectedCliAuth);
    },
  );
});
