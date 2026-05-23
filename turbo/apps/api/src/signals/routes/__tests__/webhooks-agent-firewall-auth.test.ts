import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import {
  CONNECTOR_TYPES,
  type ConnectorOAuthClientConfig,
} from "@vm0/connectors/connectors";
import { CONNECTOR_OAUTH_PROVIDERS } from "@vm0/connectors/oauth-providers";
import { connectors } from "@vm0/db/schema/connector";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  decryptSecretValue,
  encryptSecretValue,
  encryptSecretsMap,
} from "../../services/crypto.utils";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const ORG_SENTINEL_USER_ID = "__org__";

interface FirewallFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    runId: fixture.runId,
    userId: fixture.userId,
    orgId: fixture.orgId,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function authHeaders(fixture: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}): { readonly authorization: string } {
  return { authorization: `Bearer ${sandboxToken(fixture)}` };
}

function encryptedSecrets(values: Record<string, string>): string {
  const encrypted = encryptSecretsMap(values);
  if (!encrypted) {
    throw new Error("encryptSecretsMap returned null for non-empty secrets");
  }
  return encrypted;
}

function secretTemplate(name: string): string {
  return `\${{ secrets.${name} }}`;
}

function varTemplate(name: string): string {
  return `\${{ vars.${name} }}`;
}

function basicTemplate(first: string, second: string): string {
  return `\${{ basic(${first}, ${second}) }}`;
}

function firewallClient() {
  return setupApp({ context })(webhookFirewallAuthContract);
}

async function seedFixture(): Promise<FirewallFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: base.orgId, userId: base.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      status: "running",
    },
    context.signal,
  );
  return { ...base, composeId, runId };
}

const track = createFixtureTracker<FirewallFixture>(async (fixture) => {
  const db = store.set(writeDb$);
  await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await db
    .delete(modelProviders)
    .where(eq(modelProviders.orgId, fixture.orgId));
  await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await db
    .delete(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, fixture.orgId));
  await db
    .delete(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, fixture.orgId));
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

async function seedSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly value: string;
  readonly type: "connector" | "model-provider";
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(secrets).values({
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    encryptedValue: encryptSecretValue(args.value),
    type: args.type,
  });
}

async function seedCreditState(
  fixture: FirewallFixture,
  args: {
    readonly credits: number;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgMetadata).values({
    orgId: fixture.orgId,
    credits: args.credits,
  });
  await db.insert(orgMembersMetadata).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
  });
}

async function seedOrgCredits(
  fixture: FirewallFixture,
  args: {
    readonly credits: number;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgMetadata).values({
    orgId: fixture.orgId,
    credits: args.credits,
  });
}

async function readSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: "connector" | "model-provider";
}): Promise<string | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.type, args.type),
      ),
    )
    .limit(1);
  return row ? decryptSecretValue(row.encryptedValue) : null;
}

async function seedNotionConnector(
  fixture: FirewallFixture,
  args: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly tokenExpiresAt: Date | null;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "notion",
    authMethod: "oauth",
    externalId: "notion-user",
    externalUsername: "notion-user",
    externalEmail: "notion@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: args.tokenExpiresAt,
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "NOTION_ACCESS_TOKEN",
    value: args.accessToken,
    type: "connector",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "NOTION_REFRESH_TOKEN",
    value: args.refreshToken,
    type: "connector",
  });
}

async function seedExpiredNotionConnector(
  fixture: FirewallFixture,
): Promise<void> {
  await seedNotionConnector(fixture, {
    accessToken: "stale-notion-token",
    refreshToken: "notion-refresh-token",
    tokenExpiresAt: new Date(now() - 60_000),
  });
}

async function seedExpiredTestOAuthConnector(
  fixture: FirewallFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "test-oauth",
    authMethod: "oauth",
    externalId: "test-oauth-user",
    externalUsername: "test-oauth-user",
    externalEmail: "test-oauth@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: new Date(now() - 60_000),
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "TEST_OAUTH_ACCESS_TOKEN",
    value: "stale-test-oauth-token",
    type: "connector",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "TEST_OAUTH_REFRESH_TOKEN",
    value: "test-oauth-refresh-token",
    type: "connector",
  });
}

const dynamicPublicClient = {
  clientRegistration: "dynamic",
  clientType: "public",
  tokenEndpointAuthMethod: "none",
} as const satisfies ConnectorOAuthClientConfig;

type CapturedOAuthRefresh = {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly refreshToken: string;
};

function useDynamicTestOAuthRefresh(): {
  readonly refreshes: readonly CapturedOAuthRefresh[];
  readonly restore: () => void;
} {
  const refreshes: CapturedOAuthRefresh[] = [];
  return {
    refreshes,
    restore: configureDynamicTestOAuthRefresh(refreshes),
  };
}

function configureDynamicTestOAuthRefresh(
  refreshes: CapturedOAuthRefresh[],
): () => void {
  const oauth = CONNECTOR_TYPES["test-oauth"].oauth;
  if (!oauth) {
    throw new Error("test-oauth OAuth config is missing");
  }

  const mutableOAuth = oauth as { client: ConnectorOAuthClientConfig };
  const originalClient = oauth.client;
  const provider = CONNECTOR_OAUTH_PROVIDERS["test-oauth"];
  const originalRefreshToken = provider.refreshToken;

  mutableOAuth.client = dynamicPublicClient;
  provider.refreshToken = (args) => {
    refreshes.push({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      refreshToken: args.refreshToken,
    });
    return Promise.resolve({
      accessToken: "fresh-test-oauth-token",
      refreshToken: "new-test-oauth-refresh-token",
      expiresIn: 3600,
    });
  };

  return () => {
    mutableOAuth.client = originalClient;
    if (originalRefreshToken) {
      provider.refreshToken = originalRefreshToken;
    } else {
      delete provider.refreshToken;
    }
  };
}

async function seedExpiredCodexModelProvider(
  fixture: FirewallFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(modelProviders).values({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    type: "codex-oauth-token",
    authMethod: "auth_json",
    tokenExpiresAt: new Date(now() - 60_000),
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    name: "CHATGPT_ACCESS_TOKEN",
    value: "stale-chatgpt-token",
    type: "model-provider",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    name: "CHATGPT_REFRESH_TOKEN",
    value: "chatgpt-refresh-token",
    type: "model-provider",
  });
}

async function notionConnectorState(fixture: FirewallFixture): Promise<{
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      needsReconnect: connectors.needsReconnect,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
        eq(connectors.type, "notion"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("notion connector state not found");
  }
  return row;
}

async function codexProviderState(fixture: FirewallFixture): Promise<{
  readonly needsReconnect: boolean;
  readonly lastRefreshErrorCode: string | null;
  readonly tokenExpiresAt: Date | null;
}> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      needsReconnect: modelProviders.needsReconnect,
      lastRefreshErrorCode: modelProviders.lastRefreshErrorCode,
      tokenExpiresAt: modelProviders.tokenExpiresAt,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, fixture.orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.type, "codex-oauth-token"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("codex provider state not found");
  }
  return row;
}

describe("POST /api/webhooks/agent/firewall/auth", () => {
  let restoreDynamicTestOAuthRefresh: (() => void) | undefined;

  beforeEach(() => {
    mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client");
    mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-secret");
  });

  afterEach(() => {
    restoreDynamicTestOAuthRefresh?.();
    restoreDynamicTestOAuthRefresh = undefined;
  });

  it("rejects missing sandbox auth before parsing the body", async () => {
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Missing authorization", code: "UNAUTHORIZED" },
    });
  });

  it("rejects invalid sandbox tokens", async () => {
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: { authorization: "Bearer invalid-token" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid token", code: "UNAUTHORIZED" },
    });
  });

  it("rejects invalid JSON bodies", async () => {
    const fixture = await track(seedFixture());
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/webhooks/agent/firewall/auth", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sandboxToken(fixture)}`,
        "content-type": "application/json",
      },
      body: "{",
    });

    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Invalid JSON body", code: "BAD_REQUEST" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects invalid bodies and decrypt failures", async () => {
    const fixture = await track(seedFixture());

    const invalidBody = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: "",
          authHeaders: {},
        },
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(invalidBody.body).toStrictEqual({
      error: {
        message: "encryptedSecrets and authHeaders are required",
        code: "BAD_REQUEST",
      },
    });

    const decryptFailure = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: "not-encrypted",
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: authHeaders(fixture),
      }),
      [400],
    );
    expect(decryptFailure.body).toStrictEqual({
      error: { message: "Failed to decrypt secrets", code: "BAD_REQUEST" },
    });
  });

  it("returns connector-not-configured for missing referenced secrets or vars", async () => {
    const fixture = await track(seedFixture());

    const missingSecret = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );
    expect(missingSecret.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });

    const missingVar = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: { "X-Workspace": varTemplate("WORKSPACE_ID") },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );
    expect(missingVar.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
  });

  it("resolves simple and basic auth templates", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            API_TOKEN: "secret-token",
            BASIC_PASSWORD: "secret-password",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
            "X-Basic": basicTemplate(
              "vars.BASIC_USER",
              "secrets.BASIC_PASSWORD",
            ),
          },
          authBase: `https://${varTemplate("SUBDOMAIN")}.example.com`,
          authQuery: {
            workspace: varTemplate("WORKSPACE_ID"),
            token: secretTemplate("API_TOKEN"),
          },
          vars: {
            BASIC_USER: "user",
            SUBDOMAIN: "api",
            WORKSPACE_ID: "workspace-1",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      headers: {
        Authorization: "Bearer secret-token",
        "X-Basic": `Basic ${Buffer.from("user:secret-password").toString(
          "base64",
        )}`,
      },
      base: "https://api.example.com",
      query: {
        workspace: "workspace-1",
        token: "secret-token",
      },
      expiresAt: null,
      resolvedSecrets: ["API_TOKEN", "BASIC_PASSWORD"],
      refreshedConnectors: [],
      refreshedSecrets: [],
    });
  });

  it("resolves query, vars, pass-through, and omitted query template cases", async () => {
    const fixture = await track(seedFixture());

    const combined = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            API_TOKEN: "secret-token",
            CLIENT_SECRET: "client-secret",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
            "X-Client": secretTemplate("CLIENT_SECRET"),
            "X-Workspace": varTemplate("WORKSPACE_ID"),
            "X-Static": "static-value",
          },
          authQuery: {
            token: secretTemplate("API_TOKEN"),
            workspace: varTemplate("WORKSPACE_ID"),
          },
          vars: {
            WORKSPACE_ID: "workspace-1",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    expect(combined.body).toStrictEqual({
      headers: {
        Authorization: "Bearer secret-token",
        "X-Client": "client-secret",
        "X-Workspace": "workspace-1",
        "X-Static": "static-value",
      },
      query: {
        token: "secret-token",
        workspace: "workspace-1",
      },
      expiresAt: null,
      resolvedSecrets: ["API_TOKEN", "CLIENT_SECRET"],
      refreshedConnectors: [],
      refreshedSecrets: [],
    });

    const withoutQuery = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    expect(withoutQuery.body.query).toBeUndefined();
    expect(withoutQuery.body.headers.Authorization).toBe("Bearer secret-token");

    const passThrough = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: "Bearer static-token",
            "X-Static": "no-template",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    expect(passThrough.body).toStrictEqual({
      headers: {
        Authorization: "Bearer static-token",
        "X-Static": "no-template",
      },
      expiresAt: null,
      resolvedSecrets: [],
      refreshedConnectors: [],
      refreshedSecrets: [],
    });
  });

  it("resolves basic auth template edge cases", async () => {
    const fixture = await track(seedFixture());
    const encode = (value: string): string => {
      return `Basic ${Buffer.from(value).toString("base64")}`;
    };
    const literalSecretTemplate = `\${{ secrets.USER }}`;
    const malformedBasicTemplate = `\${{ basic("oops"quoted", secrets.X) }}`;
    type BasicAuthCase = {
      readonly template: string;
      readonly secrets: Record<string, string>;
      readonly vars: Record<string, string>;
      readonly expectedHeader: string;
      readonly expectedSecrets: readonly string[];
    };
    const cases: readonly BasicAuthCase[] = [
      {
        template: basicTemplate("secrets.USER", "secrets.PASS"),
        secrets: { USER: "user", PASS: "pass" },
        vars: {},
        expectedHeader: encode("user:pass"),
        expectedSecrets: ["PASS", "USER"],
      },
      {
        template: basicTemplate("secrets.USER", ""),
        secrets: { USER: "user" },
        vars: {},
        expectedHeader: encode("user:"),
        expectedSecrets: ["USER"],
      },
      {
        template: basicTemplate("", "secrets.PASS"),
        secrets: { PASS: "pass" },
        vars: {},
        expectedHeader: encode(":pass"),
        expectedSecrets: ["PASS"],
      },
      {
        template: basicTemplate("vars.USER", "secrets.PASS"),
        secrets: { PASS: "pass" },
        vars: { USER: "user" },
        expectedHeader: encode("user:pass"),
        expectedSecrets: ["PASS"],
      },
      {
        template: basicTemplate("", ""),
        secrets: {},
        vars: {},
        expectedHeader: encode(":"),
        expectedSecrets: [],
      },
      {
        template: basicTemplate("vars.USER", "vars.PASS"),
        secrets: {},
        vars: { USER: "user", PASS: "pass" },
        expectedHeader: encode("user:pass"),
        expectedSecrets: [],
      },
      {
        template: basicTemplate('"literal"', "secrets.PASS"),
        secrets: { PASS: "pass" },
        vars: {},
        expectedHeader: encode("literal:pass"),
        expectedSecrets: ["PASS"],
      },
      {
        template: basicTemplate("secrets.USER", '"literal"'),
        secrets: { USER: "user" },
        vars: {},
        expectedHeader: encode("user:literal"),
        expectedSecrets: ["USER"],
      },
      {
        template: basicTemplate('"user"', '"pass"'),
        secrets: {},
        vars: {},
        expectedHeader: encode("user:pass"),
        expectedSecrets: [],
      },
      {
        template: basicTemplate('""', '""'),
        secrets: {},
        vars: {},
        expectedHeader: encode(":"),
        expectedSecrets: [],
      },
      {
        template: basicTemplate("vars.USER", '"literal"'),
        secrets: {},
        vars: { USER: "user" },
        expectedHeader: encode("user:literal"),
        expectedSecrets: [],
      },
      {
        template: basicTemplate(`"${literalSecretTemplate}"`, "secrets.PASS"),
        secrets: { PASS: "pass", USER: "must-not-use" },
        vars: {},
        expectedHeader: encode(`${literalSecretTemplate}:pass`),
        expectedSecrets: ["PASS"],
      },
      {
        template: basicTemplate('"secrets.USER"', "secrets.PASS"),
        secrets: { PASS: "pass" },
        vars: {},
        expectedHeader: encode("secrets.USER:pass"),
        expectedSecrets: ["PASS"],
      },
      {
        template: malformedBasicTemplate,
        secrets: { X: "x" },
        vars: {},
        expectedHeader: malformedBasicTemplate,
        expectedSecrets: [],
      },
      {
        template: basicTemplate('"user:name"', '"p@ss,word"'),
        secrets: {},
        vars: {},
        expectedHeader: encode("user:name:p@ss,word"),
        expectedSecrets: [],
      },
    ];

    for (const testCase of cases) {
      const response = await accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets(testCase.secrets),
            authHeaders: {
              Authorization: testCase.template,
            },
            vars: testCase.vars,
          },
          headers: authHeaders(fixture),
        }),
        [200],
      );

      expect(response.body.headers.Authorization).toBe(testCase.expectedHeader);
      expect(response.body.resolvedSecrets).toStrictEqual(
        testCase.expectedSecrets,
      );
    }
  });

  it("skips token refresh for an empty secret connector map", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ OPENAI_TOKEN: "sk-fake" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
          },
          secretConnectorMap: {},
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      headers: {
        Authorization: "Bearer sk-fake",
      },
      expiresAt: null,
      resolvedSecrets: ["OPENAI_TOKEN"],
      refreshedConnectors: [],
      refreshedSecrets: [],
    });
  });

  it("returns a bounded expiry for billable firewall auth", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000 });

    const before = currentSecond();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    const after = currentSecond();
    expect(response.body.headers.Authorization).toBe("Bearer secret-token");
    expect(response.body.expiresAt).toBeGreaterThan(before);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 30);
  });

  it("allows billable firewall auth when member credit metadata is absent", async () => {
    const fixture = await track(seedFixture());
    await seedOrgCredits(fixture, { credits: 10_000 });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe("Bearer secret-token");
    expect(response.body.expiresAt).toBeTypeOf("number");
  });

  it("denies billable firewall auth when expired credits have not been settled", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 100 });

    const db = store.set(writeDb$);
    await db.insert(creditExpiresRecord).values({
      orgId: fixture.orgId,
      source: "starter_grant",
      amount: 100,
      remaining: 100,
      expiresAt: new Date(now() - 60_000),
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("denies billable firewall auth when credits are exhausted", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 0 });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Insufficient credits. Add credits or configure your own API key to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
  });

  it("denies billable firewall auth when credit state is missing", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "secret-token" }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("API_TOKEN")}`,
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [402],
    );

    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("refreshes expired connector OAuth tokens", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-notion-token",
          refresh_token: "new-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["notion"]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "NOTION_ACCESS_TOKEN",
    ]);
    expect(response.body.expiresAt).toBeGreaterThan(currentSecond());
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-notion-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("new-notion-refresh-token");
    const connector = await notionConnectorState(fixture);
    expect(connector.needsReconnect).toBeFalsy();
    expect(connector.tokenExpiresAt?.getTime()).toBeGreaterThan(now());
  });

  it("refreshes dynamic public connector OAuth tokens without env client credentials", async () => {
    const dynamicOAuth = useDynamicTestOAuthRefresh();
    restoreDynamicTestOAuthRefresh = dynamicOAuth.restore;
    const { refreshes } = dynamicOAuth;
    const fixture = await track(seedFixture());
    await seedExpiredTestOAuthConnector(fixture);

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            TEST_OAUTH_ACCESS_TOKEN: "stale-test-oauth-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("TEST_OAUTH_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            TEST_OAUTH_ACCESS_TOKEN: "test-oauth",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(refreshes).toStrictEqual([
      {
        clientId: undefined,
        clientSecret: undefined,
        refreshToken: "test-oauth-refresh-token",
      },
    ]);
    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-test-oauth-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "TEST_OAUTH_ACCESS_TOKEN",
    ]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "TEST_OAUTH_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-test-oauth-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "TEST_OAUTH_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("new-test-oauth-refresh-token");
  });

  it("uses OAuth token expiry when it is earlier than billable credit lease", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000 });
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "short-lived-notion-token",
          expires_in: 10,
        });
      }),
    );

    const before = currentSecond();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const after = currentSecond();

    expect(response.body.headers.Authorization).toBe(
      "Bearer short-lived-notion-token",
    );
    expect(response.body.expiresAt).toBeGreaterThan(before);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 10);
  });

  it("uses billable credit lease when it is earlier than OAuth token expiry", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, { credits: 10_000 });
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "long-lived-notion-token",
          expires_in: 3600,
        });
      }),
    );

    const before = currentSecond();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const after = currentSecond();

    expect(response.body.headers.Authorization).toBe(
      "Bearer long-lived-notion-token",
    );
    expect(response.body.expiresAt).toBeGreaterThan(before);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 30);
  });

  it("returns token-refresh-failed and marks connector reconnect when refresh fails", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "revoked" },
          { status: 400 },
        );
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
    });
  });

  it("proactively refreshes connector tokens inside the refresh buffer", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "stale-buffered-notion-token",
      refreshToken: "buffered-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 30_000),
    });
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-buffered-notion-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-buffered-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-buffered-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["notion"]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "NOTION_ACCESS_TOKEN",
    ]);
  });

  it("uses the current DB token when connector expiry is still valid", async () => {
    const fixture = await track(seedFixture());
    const futureExpiry = currentSecond() + 3600;
    await seedNotionConnector(fixture, {
      accessToken: "current-db-notion-token",
      refreshToken: "notion-refresh-token",
      tokenExpiresAt: new Date(futureExpiry * 1000),
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-snapshot-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer current-db-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([]);
    expect(response.body.refreshedSecrets).toStrictEqual([]);
    expect(response.body.expiresAt).toBe(futureExpiry);
  });

  it("refreshes connector tokens with null expiry and forced refresh", async () => {
    const nullExpiryFixture = await track(seedFixture());
    await seedNotionConnector(nullExpiryFixture, {
      accessToken: "stale-null-expiry-notion-token",
      refreshToken: "null-expiry-refresh-token",
      tokenExpiresAt: null,
    });
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-null-expiry-notion-token",
          expires_in: 3600,
        });
      }),
    );

    const nullExpiryResponse = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-null-expiry-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
        },
        headers: authHeaders(nullExpiryFixture),
      }),
      [200],
    );
    expect(nullExpiryResponse.body.headers.Authorization).toBe(
      "Bearer fresh-null-expiry-notion-token",
    );
    expect(nullExpiryResponse.body.refreshedConnectors).toStrictEqual([
      "notion",
    ]);

    const forcedFixture = await track(seedFixture());
    await seedNotionConnector(forcedFixture, {
      accessToken: "stale-force-notion-token",
      refreshToken: "force-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
    });
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-force-notion-token",
          expires_in: 3600,
        });
      }),
    );

    const forcedResponse = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_ACCESS_TOKEN: "stale-force-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_ACCESS_TOKEN: "notion",
          },
          forceRefresh: true,
        },
        headers: authHeaders(forcedFixture),
      }),
      [200],
    );
    expect(forcedResponse.body.headers.Authorization).toBe(
      "Bearer fresh-force-notion-token",
    );
    expect(forcedResponse.body.refreshedConnectors).toStrictEqual(["notion"]);
  });

  it("refreshes expired codex model-provider OAuth tokens", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-chatgpt-token",
          refresh_token: "rotated-chatgpt-refresh",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
          },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: ORG_SENTINEL_USER_ID,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([
      "codex-oauth-token",
    ]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "CHATGPT_ACCESS_TOKEN",
    ]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("fresh-chatgpt-token");
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("rejects model-provider refresh metadata for another user before billable credit auth", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
          },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: `user_${randomUUID()}`,
              metadataKey: "codex-oauth-token",
            },
          },
          firewallBillable: true,
        },
        headers: authHeaders(fixture),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid model-provider secret owner",
        code: "FORBIDDEN",
      },
    });
  });

  it("preserves ChatGPT refresh error codes on model-provider refresh failure", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "expired refresh token",
            },
          },
          { status: 401 },
        );
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
          },
          secretConnectorMetadataMap: {
            CHATGPT_ACCESS_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: ORG_SENTINEL_USER_ID,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["codex-oauth-token"],
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
  });
});
