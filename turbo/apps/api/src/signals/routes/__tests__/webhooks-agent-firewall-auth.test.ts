import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import type { ConnectorAuthClientConfig } from "@vm0/connectors/connectors";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";
import { testOauthProvider } from "@vm0/connectors/auth-providers/oauth/providers/test-oauth-provider";
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
import { setFirewallAuthRefreshTimeoutMsForTests } from "../../services/agent-webhook-firewall-auth.service";
import { upsertOrgMultiAuthModelProvider$ } from "../../services/zero-model-provider.service";
import {
  decryptSecretForTests,
  encryptSecretForTests,
} from "./helpers/encrypt-secret";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

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
  return encryptSecretForTests(JSON.stringify(values));
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Failed to create deferred promise");
  }
  return { promise, resolve: resolvePromise };
}

function requestAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Provider refresh aborted");
  error.name = "AbortError";
  return error;
}

function rejectWhenRequestAborts(
  request: Request,
  onAbort: () => void,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => {
      onAbort();
      reject(requestAbortError(request.signal));
    };
    if (request.signal.aborted) {
      rejectAbort();
      return;
    }
    request.signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

async function hasWaitingAdvisoryLock(lockKey: string): Promise<boolean> {
  const db = store.set(writeDb$);
  const result = await db.execute<{ waiting: boolean }>(
    sql`
      WITH key AS (
        SELECT hashtext(${lockKey}) AS value
      )
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks, key
        WHERE locktype = 'advisory'
          AND mode = 'ExclusiveLock'
          AND granted = false
          AND objsubid = 1
          AND (
            (key.value >= 0 AND classid::bigint = 0 AND objid::bigint = key.value::bigint)
            OR
            (key.value < 0 AND classid::bigint = 4294967295 AND objid::bigint = key.value::bigint + 4294967296)
          )
      ) AS waiting
    `,
  );
  return result.rows[0]?.waiting ?? false;
}

async function waitForAdvisoryLockWaiter(lockKey: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await hasWaitingAdvisoryLock(lockKey)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`Timed out waiting for advisory lock waiter: ${lockKey}`);
}

async function waitForConnectorStateLockWaiter(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorType: string;
}): Promise<void> {
  await waitForAdvisoryLockWaiter(
    `connector_state:${args.orgId}:${args.userId}:${args.connectorType}`,
  );
}

async function waitForModelProviderStateLockWaiter(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly providerType: string;
}): Promise<void> {
  await waitForAdvisoryLockWaiter(
    `model_provider_state:${args.orgId}:${args.userId}:${args.providerType}`,
  );
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
    encryptedValue: encryptSecretForTests(args.value),
    type: args.type,
  });
}

async function seedCreditState(
  fixture: FirewallFixture,
  args: {
    readonly credits: number;
    readonly tier?: OrgTier;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(orgMetadata)
    .values({
      orgId: fixture.orgId,
      tier: args.tier ?? "free",
      credits: args.credits,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { tier: args.tier ?? "free", credits: args.credits },
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
    readonly tier?: OrgTier;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(orgMetadata)
    .values({
      orgId: fixture.orgId,
      tier: args.tier ?? "free",
      credits: args.credits,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { tier: args.tier ?? "free", credits: args.credits },
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
  return row ? decryptSecretForTests(row.encryptedValue) : null;
}

async function seedNotionConnector(
  fixture: FirewallFixture,
  args: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly tokenExpiresAt: Date | null;
    readonly needsReconnect?: boolean;
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
    needsReconnect: args.needsReconnect ?? false,
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

async function seedStripeApiTokenConnector(
  fixture: FirewallFixture,
  args: { readonly token?: string } = {},
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "stripe",
    authMethod: "api-token",
    externalId: "stripe-account",
    externalUsername: "stripe-account",
    externalEmail: "stripe@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: null,
  });

  if (args.token !== undefined) {
    await seedSecret({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "STRIPE_TOKEN",
      value: args.token,
      type: "connector",
    });
  }
}

async function seedGithubOAuthStaticAccessConnector(
  fixture: FirewallFixture,
  args: { readonly accessToken?: string } = {},
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "github",
    authMethod: "oauth",
    externalId: "github-user",
    externalUsername: "github-user",
    externalEmail: "github@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: null,
  });

  if (args.accessToken !== undefined) {
    await seedSecret({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "GITHUB_ACCESS_TOKEN",
      value: args.accessToken,
      type: "connector",
    });
  }
}

const dynamicPublicClient = {
  clientRegistration: "dynamic",
  clientType: "public",
} as const satisfies ConnectorAuthClientConfig;

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
  const method = getConnectorAuthMethod("test-oauth", "oauth");
  if (method?.grant.kind !== "auth-code") {
    throw new Error("test-oauth OAuth config is missing");
  }

  const mutableMethod = method as { client: ConnectorAuthClientConfig };
  const originalClient = mutableMethod.client;
  const access = testOauthProvider.access;
  if (access.kind !== "refresh-token") {
    throw new Error("test-oauth provider should support refresh");
  }
  const originalRefreshToken = access.refreshToken;

  mutableMethod.client = dynamicPublicClient;
  access.refreshToken = (args) => {
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
    mutableMethod.client = originalClient;
    access.refreshToken = originalRefreshToken;
  };
}

async function seedExpiredCodexModelProvider(
  fixture: FirewallFixture,
): Promise<void> {
  await seedCodexModelProvider(fixture, {
    accessToken: "stale-chatgpt-token",
    refreshToken: "chatgpt-refresh-token",
    tokenExpiresAt: new Date(now() - 60_000),
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
  });
}

async function seedCodexModelProvider(
  fixture: FirewallFixture,
  args: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly tokenExpiresAt: Date;
    readonly needsReconnect: boolean;
    readonly lastRefreshErrorCode: string | null;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(modelProviders).values({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    type: "codex-oauth-token",
    authMethod: "auth_json",
    tokenExpiresAt: args.tokenExpiresAt,
    needsReconnect: args.needsReconnect,
    lastRefreshErrorCode: args.lastRefreshErrorCode,
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    name: "CHATGPT_ACCESS_TOKEN",
    value: args.accessToken,
    type: "model-provider",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: ORG_SENTINEL_USER_ID,
    name: "CHATGPT_REFRESH_TOKEN",
    value: args.refreshToken,
    type: "model-provider",
  });
}

async function connectorState(
  fixture: FirewallFixture,
  connectorType: string,
): Promise<{
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
        eq(connectors.type, connectorType),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(`${connectorType} connector state not found`);
  }
  return row;
}

function notionConnectorState(fixture: FirewallFixture): Promise<{
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}> {
  return connectorState(fixture, "notion");
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
  let restoreFirewallAuthRefreshTimeout: (() => void) | undefined;

  beforeEach(() => {
    mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client");
    mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-secret");
  });

  afterEach(() => {
    restoreDynamicTestOAuthRefresh?.();
    restoreDynamicTestOAuthRefresh = undefined;
    restoreFirewallAuthRefreshTimeout?.();
    restoreFirewallAuthRefreshTimeout = undefined;
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

    const inheritedSecretName = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("constructor")}`,
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );
    expect(inheritedSecretName.body.error.code).toBe(
      "CONNECTOR_NOT_CONFIGURED",
    );

    const inheritedVarName = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_TOKEN: "token" }),
          authHeaders: { "X-Workspace": varTemplate("constructor") },
          vars: {},
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );
    expect(inheritedVarName.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
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

  it("resolves same-name secrets and vars by namespace", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({ API_KEY: "secret-value" }),
          authHeaders: {
            "X-Secret": secretTemplate("API_KEY"),
            "X-Var": varTemplate("API_KEY"),
          },
          authBase: `https://${varTemplate("API_KEY")}.example.com/${secretTemplate("API_KEY")}`,
          authQuery: {
            secret: secretTemplate("API_KEY"),
            variable: varTemplate("API_KEY"),
          },
          vars: {
            API_KEY: "var-value",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      headers: {
        "X-Secret": "secret-value",
        "X-Var": "var-value",
      },
      base: "https://var-value.example.com/secret-value",
      query: {
        secret: "secret-value",
        variable: "var-value",
      },
      expiresAt: null,
      resolvedSecrets: ["API_KEY"],
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

  it("reports secrets resolved only from auth base and query templates", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            BASE_TOKEN: "base-token",
            QUERY_TOKEN: "query-token",
          }),
          authHeaders: {},
          authBase: `https://api.example.com/${secretTemplate("BASE_TOKEN")}`,
          authQuery: {
            api_key: secretTemplate("QUERY_TOKEN"),
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

    expect(response.body).toStrictEqual({
      headers: {},
      base: "https://api.example.com/base-token",
      query: {
        api_key: "query-token",
        workspace: "workspace-1",
      },
      expiresAt: null,
      resolvedSecrets: ["BASE_TOKEN", "QUERY_TOKEN"],
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
    const literalVarTemplate = `\${{ vars.USER }}`;
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
        secrets: { PASS: "pass" },
        vars: {},
        expectedHeader: encode(`${literalSecretTemplate}:pass`),
        expectedSecrets: ["PASS"],
      },
      {
        template: basicTemplate(`"${literalVarTemplate}"`, "secrets.PASS"),
        secrets: { PASS: "pass" },
        vars: {},
        expectedHeader: encode(`${literalVarTemplate}:pass`),
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

  it("denies billable firewall auth for pro-suspend orgs", async () => {
    const fixture = await track(seedFixture());
    await seedCreditState(fixture, {
      credits: 10_000,
      tier: "pro-suspend",
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

  it("denies billable firewall auth when credit state is missing", async () => {
    const fixture = await track(seedFixture());
    const db = store.set(writeDb$);
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));

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
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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
    expect(response.body.refreshedSecrets).toStrictEqual(["NOTION_TOKEN"]);
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

  it("serializes concurrent connector OAuth refreshes for rotated refresh tokens", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        if (refreshCallCount === 1) {
          firstRefreshStarted.resolve();
          await firstRefreshRelease.promise;
        }
        return HttpResponse.json({
          access_token: "fresh-concurrent-notion-token",
          refresh_token: "rotated-concurrent-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "stale-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
          },
          headers: authHeaders(fixture),
        }),
        [200],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.headers.Authorization).toBe(
        "Bearer fresh-concurrent-notion-token",
      );
      expect(response.body.expiresAt).toBeGreaterThan(currentSecond());
    }
    expect(
      responses.map((response) => {
        return response.body.refreshedConnectors;
      }),
    ).toStrictEqual([["notion"], []]);
    expect(
      responses.map((response) => {
        return response.body.refreshedSecrets;
      }),
    ).toStrictEqual([["NOTION_TOKEN"], []]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-concurrent-notion-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("rotated-concurrent-notion-refresh-token");
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it("does not treat concurrent short-lived connector refresh success as upstream failure", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        const call = refreshCallCount;
        if (call === 1) {
          firstRefreshStarted.resolve();
          await firstRefreshRelease.promise;
        }
        return HttpResponse.json({
          access_token: `short-lived-notion-token-${call}`,
          refresh_token: `short-lived-notion-refresh-token-${call}`,
          expires_in: 30,
        });
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "stale-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
          },
          headers: authHeaders(fixture),
        }),
        [200],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(2);
    expect(
      responses.map((response) => {
        return response.body.headers.Authorization;
      }),
    ).toStrictEqual([
      "Bearer short-lived-notion-token-1",
      "Bearer short-lived-notion-token-2",
    ]);
    expect(
      responses.map((response) => {
        return response.body.refreshedConnectors;
      }),
    ).toStrictEqual([["notion"], ["notion"]]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("short-lived-notion-token-2");
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it("does not treat an already-observed short-lived connector refresh state as upstream failure", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "short-lived-observed-notion-token",
      refreshToken: "short-lived-observed-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 30_000),
    });
    const db = store.set(writeDb$);
    await db
      .update(connectors)
      .set({ updatedAt: sql`clock_timestamp() + interval '5 seconds'` })
      .where(
        and(
          eq(connectors.orgId, fixture.orgId),
          eq(connectors.userId, fixture.userId),
          eq(connectors.type, "notion"),
        ),
      );

    let refreshCallCount = 0;
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        refreshCallCount += 1;
        return HttpResponse.json({
          access_token: "fresh-observed-notion-token",
          refresh_token: "fresh-observed-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "short-lived-observed-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(refreshCallCount).toBe(1);
    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-observed-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["notion"]);
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it("serializes concurrent forced connector OAuth refreshes", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-force-concurrent-notion-token",
      refreshToken: "force-concurrent-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
    });

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        if (refreshCallCount === 1) {
          firstRefreshStarted.resolve();
          await firstRefreshRelease.promise;
        }
        return HttpResponse.json({
          access_token: "fresh-force-concurrent-notion-token",
          refresh_token: "rotated-force-concurrent-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "current-force-concurrent-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
            forceRefresh: true,
          },
          headers: authHeaders(fixture),
        }),
        [200],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.headers.Authorization).toBe(
        "Bearer fresh-force-concurrent-notion-token",
      );
    }
    expect(
      responses.map((response) => {
        return response.body.refreshedConnectors;
      }),
    ).toStrictEqual([["notion"], []]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("rotated-force-concurrent-notion-refresh-token");
  });

  it("serializes concurrent forced connector OAuth refreshes without access snapshots", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-force-missing-snapshot-notion-token",
      refreshToken: "force-missing-snapshot-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
    });

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        if (refreshCallCount === 1) {
          firstRefreshStarted.resolve();
          await firstRefreshRelease.promise;
        }
        return HttpResponse.json({
          access_token: "fresh-force-missing-snapshot-notion-token",
          refresh_token: "rotated-force-missing-snapshot-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({}),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
            forceRefresh: true,
          },
          headers: authHeaders(fixture),
        }),
        [200],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.headers.Authorization).toBe(
        "Bearer fresh-force-missing-snapshot-notion-token",
      );
    }
    expect(
      responses.map((response) => {
        return response.body.refreshedConnectors;
      }),
    ).toStrictEqual([["notion"], []]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("rotated-force-missing-snapshot-notion-refresh-token");
  });

  it("does not fall back to stale access after a concurrent forced refresh failure", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "stale-after-force-failure-notion-token",
      refreshToken: "force-failure-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
    });

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        firstRefreshStarted.resolve();
        await firstRefreshRelease.promise;
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "revoked" },
          { status: 400 },
        );
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({}),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
            forceRefresh: true,
          },
          headers: authHeaders(fixture),
        }),
        [502],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        connectors: ["notion"],
      });
    }
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
    });
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
            TEST_OAUTH_TOKEN: "stale-test-oauth-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
          },
          secretConnectorMap: {
            TEST_OAUTH_TOKEN: "test-oauth",
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
    expect(response.body.refreshedSecrets).toStrictEqual(["TEST_OAUTH_TOKEN"]);
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

  it("resolves a missing selected connector access secret through refresh metadata", async () => {
    const dynamicOAuth = useDynamicTestOAuthRefresh();
    restoreDynamicTestOAuthRefresh = dynamicOAuth.restore;
    const fixture = await track(seedFixture());
    await seedExpiredTestOAuthConnector(fixture);

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
          },
          secretConnectorMap: {
            TEST_OAUTH_TOKEN: "test-oauth",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-test-oauth-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["test-oauth"]);
    expect(response.body.refreshedSecrets).toStrictEqual(["TEST_OAUTH_TOKEN"]);
  });

  it("loads a missing selected connector access secret when the stored token is current", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-notion-token",
      refreshToken: "current-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer current-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([]);
    expect(response.body.refreshedSecrets).toStrictEqual([]);
    expect(response.body.expiresAt).toBeGreaterThan(currentSecond());
  });

  it("returns an access resolution failure when current selected connector access storage is missing", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-notion-token",
      refreshToken: "current-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
    });
    const db = store.set(writeDb$);
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "NOTION_ACCESS_TOKEN"),
          eq(secrets.type, "connector"),
        ),
      );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_ACCESS_RESOLUTION_FAILED",
      connectors: ["notion"],
    });
  });

  it("does not use stale encrypted connector access when current selected access storage is missing", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-notion-token",
      refreshToken: "current-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
    });
    const db = store.set(writeDb$);
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "NOTION_ACCESS_TOKEN"),
          eq(secrets.type, "connector"),
        ),
      );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_ACCESS_RESOLUTION_FAILED",
      connectors: ["notion"],
    });
  });

  it("does not bypass missing selected connector access when the connector row is absent", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("does not use stale encrypted connector access when the connector row is absent", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("returns a refresh failure when selected connector refresh tokens are missing", async () => {
    const dynamicOAuth = useDynamicTestOAuthRefresh();
    restoreDynamicTestOAuthRefresh = dynamicOAuth.restore;
    const fixture = await track(seedFixture());
    await seedExpiredTestOAuthConnector(fixture);
    const db = store.set(writeDb$);
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "TEST_OAUTH_REFRESH_TOKEN"),
          eq(secrets.type, "connector"),
        ),
      );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
          },
          secretConnectorMap: {
            TEST_OAUTH_TOKEN: "test-oauth",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["test-oauth"],
      failureReason: "reconnect_required",
    });
    expect(dynamicOAuth.refreshes).toStrictEqual([]);
    await expect(connectorState(fixture, "test-oauth")).resolves.toMatchObject({
      needsReconnect: true,
    });
  });

  it("keeps missing static connector access secrets as missing configuration", async () => {
    const fixture = await track(seedFixture());
    await seedStripeApiTokenConnector(fixture);

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("STRIPE_TOKEN")}`,
          },
          secretConnectorMap: {
            STRIPE_TOKEN: "stripe",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("loads current static connector access instead of stale encrypted access", async () => {
    const fixture = await track(seedFixture());
    await seedStripeApiTokenConnector(fixture, {
      token: "current-stripe-token",
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            STRIPE_TOKEN: "stale-stripe-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("STRIPE_TOKEN")}`,
          },
          secretConnectorMap: {
            STRIPE_TOKEN: "stripe",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer current-stripe-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([]);
    expect(response.body.refreshedSecrets).toStrictEqual([]);
  });

  it("loads current static connector env aliases", async () => {
    const fixture = await track(seedFixture());
    await seedGithubOAuthStaticAccessConnector(fixture, {
      accessToken: "current-github-token",
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            GITHUB_TOKEN: "stale-github-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("GITHUB_TOKEN")}`,
          },
          secretConnectorMap: {
            GITHUB_TOKEN: "github",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer current-github-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([]);
    expect(response.body.refreshedSecrets).toStrictEqual([]);
  });

  it("rejects static connector raw access secret names", async () => {
    const fixture = await track(seedFixture());
    await seedGithubOAuthStaticAccessConnector(fixture, {
      accessToken: "current-github-token",
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            GITHUB_ACCESS_TOKEN: "stale-github-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("GITHUB_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            GITHUB_ACCESS_TOKEN: "github",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("rejects stale encrypted static connector access when current storage is missing", async () => {
    const fixture = await track(seedFixture());
    await seedStripeApiTokenConnector(fixture);

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            STRIPE_TOKEN: "stale-stripe-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("STRIPE_TOKEN")}`,
          },
          secretConnectorMap: {
            STRIPE_TOKEN: "stripe",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("rejects encrypted static connector secrets after the connector is removed", async () => {
    const fixture = await track(seedFixture());

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            STRIPE_TOKEN: "stale-stripe-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("STRIPE_TOKEN")}`,
          },
          secretConnectorMap: {
            STRIPE_TOKEN: "stripe",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("rejects encrypted connector secrets outside the selected access method", async () => {
    const fixture = await track(seedFixture());
    await seedStripeApiTokenConnector(fixture);

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            STRIPE_ACCESS_TOKEN: "stale-oauth-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("STRIPE_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: {
            STRIPE_ACCESS_TOKEN: "stripe",
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("uses access-token expiry when it is earlier than billable credit lease", async () => {
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
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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

  it("uses the default 15-minute access-token expiry when refresh omits expires_in", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "default-expiry-notion-token",
          refresh_token: "default-expiry-refresh-token",
        });
      }),
    );

    const before = currentSecond();
    const beforeMs = now();
    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );
    const afterMs = now();
    const after = currentSecond();

    expect(response.body.headers.Authorization).toBe(
      "Bearer default-expiry-notion-token",
    );
    expect(response.body.expiresAt).toBeGreaterThanOrEqual(before + 15 * 60);
    expect(response.body.expiresAt).toBeLessThanOrEqual(after + 15 * 60);

    const connector = await notionConnectorState(fixture);
    expect(connector.tokenExpiresAt?.getTime()).toBeGreaterThanOrEqual(
      beforeMs + 15 * 60 * 1000,
    );
    expect(connector.tokenExpiresAt?.getTime()).toBeLessThanOrEqual(
      afterMs + 15 * 60 * 1000,
    );
  });

  it("uses billable credit lease when it is earlier than access-token expiry", async () => {
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
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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

  it("classifies connector invalid_grant refresh failures as reconnect required", async () => {
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
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
      failureReason: "reconnect_required",
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
    });
  });

  it("refreshes reconnect-required connector tokens even when expiry is still valid", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-reconnect-required-notion-token",
      refreshToken: "reconnect-required-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
      needsReconnect: true,
    });

    let refreshCallCount = 0;
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        refreshCallCount += 1;
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
            NOTION_TOKEN: "stale-snapshot-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(refreshCallCount).toBe(1);
    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
      failureReason: "reconnect_required",
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
    });
  });

  it("recovers reconnect-required connector tokens when refresh succeeds", async () => {
    const fixture = await track(seedFixture());
    await seedNotionConnector(fixture, {
      accessToken: "current-recoverable-notion-token",
      refreshToken: "recoverable-notion-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
      needsReconnect: true,
    });

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-recovered-notion-token",
          refresh_token: "rotated-recovered-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-snapshot-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-recovered-notion-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual(["notion"]);
    expect(response.body.refreshedSecrets).toStrictEqual(["NOTION_TOKEN"]);
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-recovered-notion-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_REFRESH_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("rotated-recovered-notion-refresh-token");
  });

  it("classifies upstream connector refresh failures without marking reconnect", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status: 502 },
        );
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
      message:
        "Access token refresh failed for: notion. The upstream provider may be temporarily unavailable.",
      failureReason: "upstream_provider",
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it("classifies connector network refresh failures as upstream", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
      failureReason: "upstream_provider",
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it("classifies connector refresh timeouts as upstream without marking reconnect", async () => {
    restoreFirewallAuthRefreshTimeout =
      setFirewallAuthRefreshTimeoutMsForTests(25);
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    const providerAbortObserved = deferred();
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", ({ request }) => {
        return rejectWhenRequestAborts(request, providerAbortObserved.resolve);
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
          },
        },
        headers: authHeaders(fixture),
      }),
      [502],
    );

    await providerAbortObserved.promise;
    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
      failureReason: "upstream_provider",
    });
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it.each(["temporarily_unavailable", "server_error"] as const)(
    "classifies standard OAuth %s refresh failures as upstream",
    async (oauthError) => {
      const fixture = await track(seedFixture());
      await seedExpiredNotionConnector(fixture);
      server.use(
        http.post("https://api.notion.com/v1/oauth/token", () => {
          return HttpResponse.json({ error: oauthError }, { status: 400 });
        }),
      );

      const response = await accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "stale-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
          },
          headers: authHeaders(fixture),
        }),
        [502],
      );

      expect(response.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        connectors: ["notion"],
        failureReason: "upstream_provider",
      });
      await expect(notionConnectorState(fixture)).resolves.toMatchObject({
        needsReconnect: false,
      });
    },
  );

  it("serializes concurrent upstream connector refresh failures", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        firstRefreshStarted.resolve();
        await firstRefreshRelease.promise;
        return HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status: 502 },
        );
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "stale-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
          },
          headers: authHeaders(fixture),
        }),
        [502],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        connectors: ["notion"],
        failureReason: "upstream_provider",
      });
    }
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
    });
  });

  it("serializes concurrent connector invalid_grant refresh failures", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        firstRefreshStarted.resolve();
        await firstRefreshRelease.promise;
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "revoked" },
          { status: 400 },
        );
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "stale-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
          },
          headers: authHeaders(fixture),
        }),
        [502],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    expect(responses[0].body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
      failureReason: "reconnect_required",
    });
    expect(responses[1].body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["notion"],
    });
    expect(responses[1].body.error).not.toHaveProperty("failureReason");
    await expect(notionConnectorState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
    });
  });

  it("does not invent failureReason for concurrent unknown connector refresh failures", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        refreshCallCount += 1;
        firstRefreshStarted.resolve();
        await firstRefreshRelease.promise;
        return HttpResponse.json(
          { error: "invalid_request", error_description: "bad request" },
          { status: 400 },
        );
      }),
    );

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({
              NOTION_TOKEN: "stale-notion-token",
            }),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
            },
            secretConnectorMap: {
              NOTION_TOKEN: "notion",
            },
          },
          headers: authHeaders(fixture),
        }),
        [502],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        connectors: ["notion"],
      });
      expect(response.body.error).not.toHaveProperty("failureReason");
    }
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
            NOTION_TOKEN: "stale-buffered-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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
    expect(response.body.refreshedSecrets).toStrictEqual(["NOTION_TOKEN"]);
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
            NOTION_TOKEN: "stale-snapshot-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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
            NOTION_TOKEN: "stale-null-expiry-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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
            NOTION_TOKEN: "stale-force-notion-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("NOTION_TOKEN")}`,
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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

  it("serializes concurrent model-provider OAuth refreshes for rotated refresh tokens", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://auth.openai.com/oauth/token", async () => {
        refreshCallCount += 1;
        if (refreshCallCount === 1) {
          firstRefreshStarted.resolve();
          await firstRefreshRelease.promise;
        }
        return HttpResponse.json({
          access_token: "fresh-concurrent-chatgpt-token",
          refresh_token: "rotated-concurrent-chatgpt-refresh",
          expires_in: 3600,
        });
      }),
    );

    const refreshRequest = () => {
      return accept(
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
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForModelProviderStateLockWaiter({
      orgId: fixture.orgId,
      userId: ORG_SENTINEL_USER_ID,
      providerType: "codex-oauth-token",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.headers.Authorization).toBe(
        "Bearer fresh-concurrent-chatgpt-token",
      );
      expect(response.body.expiresAt).toBeGreaterThan(currentSecond());
    }
    expect(
      responses.map((response) => {
        return response.body.refreshedConnectors;
      }),
    ).toStrictEqual([["codex-oauth-token"], []]);
    expect(
      responses.map((response) => {
        return response.body.refreshedSecrets;
      }),
    ).toStrictEqual([["CHATGPT_ACCESS_TOKEN"], []]);
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("fresh-concurrent-chatgpt-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("rotated-concurrent-chatgpt-refresh");
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("does not fall back to stale model-provider access after a concurrent forced refresh failure", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "current-force-failure-chatgpt-token",
      refreshToken: "force-failure-chatgpt-refresh",
      tokenExpiresAt: new Date(now() + 3_600_000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://auth.openai.com/oauth/token", async () => {
        refreshCallCount += 1;
        firstRefreshStarted.resolve();
        await firstRefreshRelease.promise;
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

    const refreshRequest = () => {
      return accept(
        firewallClient().resolve({
          body: {
            encryptedSecrets: encryptedSecrets({}),
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
            forceRefresh: true,
          },
          headers: authHeaders(fixture),
        }),
        [502],
      );
    };

    const firstResponsePromise = refreshRequest();
    await firstRefreshStarted.promise;
    const secondResponsePromise = refreshRequest();
    await waitForModelProviderStateLockWaiter({
      orgId: fixture.orgId,
      userId: ORG_SENTINEL_USER_ID,
      providerType: "codex-oauth-token",
    });
    firstRefreshRelease.resolve();

    const responses = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(refreshCallCount).toBe(1);
    for (const response of responses) {
      expect(response.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        connectors: ["codex-oauth-token"],
        failureReason: "reconnect_required",
      });
    }
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
  });

  it("preserves model-provider reauth that races with runtime OAuth refresh", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);

    let refreshCallCount = 0;
    const firstRefreshStarted = deferred();
    const firstRefreshRelease = deferred();

    server.use(
      http.post("https://auth.openai.com/oauth/token", async () => {
        refreshCallCount += 1;
        firstRefreshStarted.resolve();
        await firstRefreshRelease.promise;
        return HttpResponse.json({
          access_token: "runtime-refreshed-chatgpt-token",
          refresh_token: "runtime-rotated-chatgpt-refresh",
          expires_in: 3600,
        });
      }),
    );

    const refreshResponsePromise = accept(
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

    await firstRefreshStarted.promise;
    const reauthPromise = store.set(
      upsertOrgMultiAuthModelProvider$,
      {
        orgId: fixture.orgId,
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secretValues: {
          CHATGPT_ACCESS_TOKEN: "reauth-chatgpt-token",
          CHATGPT_REFRESH_TOKEN: "reauth-chatgpt-refresh",
          CHATGPT_ACCOUNT_ID: "reauth-chatgpt-account",
          CHATGPT_ID_TOKEN: "reauth-chatgpt-id-token",
        },
        metadata: {
          tokenExpiresAt: new Date(now() + 3_600_000),
          workspaceName: "Reauth workspace",
          planType: "plus",
        },
      },
      context.signal,
    );
    firstRefreshRelease.resolve();

    const [refreshResponse, reauthResult] = await Promise.all([
      refreshResponsePromise,
      reauthPromise,
    ]);

    if (!("provider" in reauthResult)) {
      throw new Error("Expected model provider reauth to succeed");
    }

    expect(refreshCallCount).toBe(1);
    expect(refreshResponse.body.headers.Authorization).toBe(
      "Bearer runtime-refreshed-chatgpt-token",
    );
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("reauth-chatgpt-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("reauth-chatgpt-refresh");
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("derives model-provider source from registered OAuth provider keys", async () => {
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
        },
        headers: authHeaders(fixture),
      }),
      [200],
    );

    expect(response.body.headers.Authorization).toBe(
      "Bearer fresh-chatgpt-token",
    );
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("fresh-chatgpt-token");
  });

  it("loads a missing model-provider access secret when the stored token is current", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "current-chatgpt-token",
      refreshToken: "current-chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
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
      "Bearer current-chatgpt-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([]);
    expect(response.body.refreshedSecrets).toStrictEqual([]);
  });

  it("rejects missing model-provider access secrets outside env bindings", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "current-chatgpt-token",
      refreshToken: "current-chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({}),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("UNBOUND_TOKEN")}`,
          },
          secretConnectorMap: {
            UNBOUND_TOKEN: "codex-oauth-token",
          },
          secretConnectorMetadataMap: {
            UNBOUND_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: ORG_SENTINEL_USER_ID,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
  });

  it("rejects encrypted model-provider access secrets outside env bindings", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "current-chatgpt-token",
      refreshToken: "current-chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() + 60 * 60 * 1000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            UNBOUND_TOKEN: "stale-unbound-token",
          }),
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("UNBOUND_TOKEN")}`,
          },
          secretConnectorMap: {
            UNBOUND_TOKEN: "codex-oauth-token",
          },
          secretConnectorMetadataMap: {
            UNBOUND_TOKEN: {
              sourceType: "model-provider",
              sourceUserId: ORG_SENTINEL_USER_ID,
              metadataKey: "codex-oauth-token",
            },
          },
        },
        headers: authHeaders(fixture),
      }),
      [424],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
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
      failureReason: "reconnect_required",
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
  });

  it("refreshes reconnect-required model-provider tokens even when expiry is still valid", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "current-reconnect-required-chatgpt-token",
      refreshToken: "reconnect-required-chatgpt-refresh",
      tokenExpiresAt: new Date(now() + 3_600_000),
      needsReconnect: true,
      lastRefreshErrorCode: null,
    });

    let refreshCallCount = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCallCount += 1;
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
            CHATGPT_ACCESS_TOKEN: "stale-snapshot-chatgpt-token",
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

    expect(refreshCallCount).toBe(1);
    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["codex-oauth-token"],
      failureReason: "reconnect_required",
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
  });

  it("recovers reconnect-required model-provider tokens when refresh succeeds", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "current-recoverable-chatgpt-token",
      refreshToken: "recoverable-chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });

    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json({
          access_token: "fresh-recovered-chatgpt-token",
          refresh_token: "rotated-recovered-chatgpt-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            CHATGPT_ACCESS_TOKEN: "stale-snapshot-chatgpt-token",
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
      "Bearer fresh-recovered-chatgpt-token",
    );
    expect(response.body.refreshedConnectors).toStrictEqual([
      "codex-oauth-token",
    ]);
    expect(response.body.refreshedSecrets).toStrictEqual([
      "CHATGPT_ACCESS_TOKEN",
    ]);
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_ACCESS_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("fresh-recovered-chatgpt-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
        type: "model-provider",
      }),
    ).resolves.toBe("rotated-recovered-chatgpt-refresh-token");
  });

  it("rejects skipped model-provider tokens that become reconnect-required during another refresh", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    await seedCodexModelProvider(fixture, {
      accessToken: "current-racing-chatgpt-token",
      refreshToken: "racing-chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() + 3_600_000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });

    let notionRefreshCallCount = 0;
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", async () => {
        notionRefreshCallCount += 1;
        const db = store.set(writeDb$);
        await db
          .update(modelProviders)
          .set({
            needsReconnect: true,
            lastRefreshErrorCode: "refresh_token_expired",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(modelProviders.orgId, fixture.orgId),
              eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
              eq(modelProviders.type, "codex-oauth-token"),
            ),
          );
        return HttpResponse.json({
          access_token: "fresh-racing-notion-token",
          refresh_token: "rotated-racing-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
            CHATGPT_ACCESS_TOKEN: "stale-snapshot-chatgpt-token",
          }),
          authHeaders: {
            Authorization: [
              `Bearer ${secretTemplate("NOTION_TOKEN")}`,
              secretTemplate("CHATGPT_ACCESS_TOKEN"),
            ].join(" "),
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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

    expect(notionRefreshCallCount).toBe(1);
    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["codex-oauth-token"],
      failureReason: "reconnect_required",
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "refresh_token_expired",
    });
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-racing-notion-token");
  });

  it("preserves standard OAuth reconnect error codes on model-provider refresh failure", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
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
      failureReason: "reconnect_required",
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: true,
      lastRefreshErrorCode: "invalid_grant",
    });
  });

  it("classifies upstream ChatGPT refresh failures without marking reconnect", async () => {
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() - 60_000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status: 502 },
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
      failureReason: "upstream_provider",
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("classifies model-provider refresh timeouts as upstream without marking reconnect", async () => {
    restoreFirewallAuthRefreshTimeout =
      setFirewallAuthRefreshTimeoutMsForTests(25);
    const fixture = await track(seedFixture());
    await seedCodexModelProvider(fixture, {
      accessToken: "stale-chatgpt-token",
      refreshToken: "chatgpt-refresh-token",
      tokenExpiresAt: new Date(now() - 60_000),
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
    const providerAbortObserved = deferred();
    server.use(
      http.post("https://auth.openai.com/oauth/token", ({ request }) => {
        return rejectWhenRequestAborts(request, providerAbortObserved.resolve);
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

    await providerAbortObserved.promise;
    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["codex-oauth-token"],
      failureReason: "upstream_provider",
    });
    await expect(codexProviderState(fixture)).resolves.toMatchObject({
      needsReconnect: false,
      lastRefreshErrorCode: null,
    });
  });

  it("omits failureReason when failed connectors have mixed known and unknown reasons", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    await seedExpiredCodexModelProvider(fixture);
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        return HttpResponse.json(
          { error: "invalid_request", error_description: "bad request" },
          { status: 400 },
        );
      }),
      http.post("https://auth.openai.com/oauth/token", () => {
        return HttpResponse.json(
          { error: "temporarily_unavailable" },
          { status: 502 },
        );
      }),
    );

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            NOTION_TOKEN: "stale-notion-token",
            CHATGPT_ACCESS_TOKEN: "stale-chatgpt-token",
          }),
          authHeaders: {
            Authorization: [
              `Bearer ${secretTemplate("NOTION_TOKEN")}`,
              secretTemplate("CHATGPT_ACCESS_TOKEN"),
            ].join(" "),
          },
          secretConnectorMap: {
            NOTION_TOKEN: "notion",
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
      connectors: ["notion", "codex-oauth-token"],
    });
    expect(response.body.error).not.toHaveProperty("failureReason");
  });
});
