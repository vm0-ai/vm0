import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { variables } from "@vm0/db/schema/variable";
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
  it("does not derive api-token connectors from user-owned secrets", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

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

    expect(openai).toBeUndefined();
  });

  it("returns connector-provided bindings only for stored connector credentials", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(connectors).values({
      orgId,
      userId,
      type: "gitlab",
      authMethod: "api-token",
    });
    await writeDb.insert(secrets).values({
      orgId,
      userId,
      name: "GITLAB_TOKEN",
      encryptedValue: "encrypted_gitlab_token",
      type: "connector",
    });

    const list = await store.get(zeroConnectorList({ orgId, userId }));

    expect(list.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining([
        {
          connectorType: "gitlab",
          authMethod: "api-token",
          namespace: "secrets",
          name: "GITLAB_TOKEN",
          required: true,
          source: {
            kind: "connector-secret",
            name: "GITLAB_TOKEN",
          },
        },
        {
          connectorType: "gitlab",
          authMethod: "api-token",
          namespace: "vars",
          name: "GITLAB_HOST",
          required: false,
          source: {
            kind: "connector-variable",
            name: "GITLAB_HOST",
          },
        },
      ]),
    );
  });

  it("returns connector token env names from selected auth method metadata", async () => {
    const orgId = `org_${randomUUID()}`;
    const userWithoutSecret = `user_${randomUUID()}`;
    const userWithSecret = `user_${randomUUID()}`;

    await writeDb.insert(connectors).values([
      {
        orgId,
        userId: userWithoutSecret,
        type: "github",
        authMethod: "oauth",
      },
      {
        orgId,
        userId: userWithSecret,
        type: "github",
        authMethod: "oauth",
      },
    ]);
    await writeDb.insert(secrets).values({
      orgId,
      userId: userWithSecret,
      name: "GITHUB_ACCESS_TOKEN",
      encryptedValue: "encrypted_github_access_token",
      type: "connector",
    });

    const withoutSecret = await store.get(
      zeroConnectorList({ orgId, userId: userWithoutSecret }),
    );
    const withSecret = await store.get(
      zeroConnectorList({ orgId, userId: userWithSecret }),
    );

    const githubTokenBindings = [
      {
        connectorType: "github",
        authMethod: "oauth",
        namespace: "secrets",
        name: "GH_TOKEN",
        required: true,
        source: {
          kind: "connector-secret",
          name: "GITHUB_ACCESS_TOKEN",
        },
      },
      {
        connectorType: "github",
        authMethod: "oauth",
        namespace: "secrets",
        name: "GITHUB_TOKEN",
        required: true,
        source: {
          kind: "connector-secret",
          name: "GITHUB_ACCESS_TOKEN",
        },
      },
    ];
    expect(withoutSecret.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining(githubTokenBindings),
    );
    expect(withSecret.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining(githubTokenBindings),
    );
  });

  it("does not report platform-backed connector env names from dirty connector secrets", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(connectors).values({
      orgId,
      userId,
      type: "google-ads",
      authMethod: "oauth",
    });
    await writeDb.insert(secrets).values([
      {
        orgId,
        userId,
        name: "GOOGLE_ADS_ACCESS_TOKEN",
        encryptedValue: "encrypted_google_ads_access_token",
        type: "connector",
      },
      {
        orgId,
        userId,
        name: "GOOGLE_ADS_DEVELOPER_TOKEN",
        encryptedValue: "encrypted_google_ads_developer_token",
        type: "connector",
      },
    ]);

    const list = await store.get(zeroConnectorList({ orgId, userId }));

    expect(list.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining([
        {
          connectorType: "google-ads",
          authMethod: "oauth",
          namespace: "secrets",
          name: "GOOGLE_ADS_TOKEN",
          required: true,
          source: {
            kind: "connector-secret",
            name: "GOOGLE_ADS_ACCESS_TOKEN",
          },
        },
      ]),
    );
    expect(list.connectorProvidedBindings).not.toContainEqual(
      expect.objectContaining({
        name: "GOOGLE_ADS_DEVELOPER_TOKEN",
      }),
    );
  });

  it("reports variable-backed connector env names as structured provided bindings", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await writeDb.insert(connectors).values({
      orgId,
      userId,
      type: "gitlab",
      authMethod: "api-token",
    });
    await writeDb.insert(secrets).values({
      orgId,
      userId,
      name: "GITLAB_TOKEN",
      encryptedValue: "encrypted_gitlab_token",
      type: "connector",
    });
    await writeDb.insert(variables).values({
      orgId,
      userId,
      name: "GITLAB_HOST",
      value: "gitlab.example.com",
      type: "connector",
    });

    const list = await store.get(zeroConnectorList({ orgId, userId }));

    expect(list.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining([
        {
          connectorType: "gitlab",
          authMethod: "api-token",
          namespace: "vars",
          name: "GITLAB_HOST",
          required: false,
          source: {
            kind: "connector-variable",
            name: "GITLAB_HOST",
          },
        },
      ]),
    );
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

  it("keeps a stored connector auth-provider connection visible when another auth method is ungated", async () => {
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

  it("returns Stripe API-token search auth without CLI auth", async () => {
    const authMethods = await stripeSearchAuthMethods({});

    expect(authMethods).toStrictEqual(["api-token"]);
  });
});
