// Remnant legacy file, kept per api.bdd.md "Unreachable Code Candidates"
// (production-reachable concurrency races): the advisory-lock refresh
// machinery (locked refresh divergence, skipped-token re-resolution, and
// mid-request row deletion) needs pg locks held across requests; the
// inconsistent-state cases need connector/secret/org-metadata rows deleted
// out from under a current token; the null-expiry and omitted-output refresh
// arms need rows and provider results no public write path produces.
// API-reachable firewall auth coverage lives in
// webhooks-agent-firewall-auth.bdd.test.ts (FW-1..10).

import { createStore } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import type { ConnectorAuthClientConfig } from "@vm0/connectors/connectors";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";
import { testOauthApiProvider } from "@vm0/connectors/auth-providers/connectors/test-oauth/provider";
import { connectors } from "@vm0/db/schema/connector";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
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

async function holdConnectorStateLock(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorType: string;
  readonly release: Promise<void>;
  readonly onAcquired: () => void;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('connector_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.connectorType}))`,
    );
    args.onAcquired();
    await args.release;
  });
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

async function holdModelProviderStateLock(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly providerType: string;
  readonly release: Promise<void>;
  readonly onAcquired: () => void;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.providerType}))`,
    );
    args.onAcquired();
    await args.release;
  });
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
  await db.delete(variables).where(eq(variables.orgId, fixture.orgId));
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

async function seedVariable(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly value: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(variables).values({
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    value: args.value,
    type: "connector",
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

async function seedExpiredTestOAuthApiConnector(
  fixture: FirewallFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "test-oauth",
    authMethod: "api",
    externalId: "test-oauth-api-user",
    externalUsername: "test-oauth-api-user",
    externalEmail: "test-oauth-api@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: new Date(now() - 60_000),
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "TEST_OAUTH_API_ACCESS_TOKEN",
    value: "stale-test-oauth-api-token",
    type: "connector",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "TEST_OAUTH_API_REFRESH_TOKEN",
    value: "test-oauth-api-refresh-token",
    type: "connector",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "TEST_OAUTH_API_SECONDARY_TOKEN",
    value: "old-test-oauth-api-secondary-token",
    type: "connector",
  });
  await seedVariable({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "TEST_OAUTH_API_TENANT_ID",
    value: "tenant-123",
  });
}

async function seedStripeStaticConnector(
  fixture: FirewallFixture,
  args: {
    readonly authMethod?: "api-token" | "cli";
    readonly token?: string;
    readonly tokenExpiresAt?: Date | null;
    readonly needsReconnect?: boolean;
  } = {},
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "stripe",
    authMethod: args.authMethod ?? "api-token",
    externalId: "stripe-account",
    externalUsername: "stripe-account",
    externalEmail: "stripe@example.com",
    oauthScopes: JSON.stringify([]),
    tokenExpiresAt: args.tokenExpiresAt ?? null,
    needsReconnect: args.needsReconnect ?? false,
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

const dynamicPublicClient = {
  clientRegistration: "dynamic",
  clientType: "public",
} as const satisfies ConnectorAuthClientConfig;

type CapturedOAuthRefresh = {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly refreshToken: string;
  readonly tenantId?: string;
};

function useMalformedTestOAuthApiRefresh(args: {
  readonly outputs: Readonly<Record<string, string | undefined>>;
}): {
  readonly refreshes: readonly CapturedOAuthRefresh[];
  readonly restore: () => void;
} {
  const refreshes: CapturedOAuthRefresh[] = [];
  return {
    refreshes,
    restore: configureMalformedTestOAuthApiRefresh(refreshes, args.outputs),
  };
}

function configureMalformedTestOAuthApiRefresh(
  refreshes: CapturedOAuthRefresh[],
  outputs: Readonly<Record<string, string | undefined>>,
): () => void {
  const method = getConnectorAuthMethod("test-oauth", "api");
  const originalClient = method.client;
  const access = testOauthApiProvider.access;
  const originalRefresh = access.refresh;

  Object.assign(method, { client: dynamicPublicClient });
  const malformedRefresh = (
    args: Parameters<typeof originalRefresh>[0],
  ): Promise<unknown> => {
    refreshes.push({
      clientId:
        args.authClient.clientRegistration === "static"
          ? args.authClient.clientId
          : undefined,
      clientSecret:
        args.authClient.clientRegistration === "static" &&
        args.authClient.clientType === "confidential"
          ? args.authClient.clientSecret
          : undefined,
      refreshToken: args.inputs.apiRefreshToken,
      tenantId: args.inputs.tenantId,
    });
    return Promise.resolve({
      outputs,
      expiresIn: 3600,
    });
  };
  // Deliberately bypass provider-specific output typing to exercise the
  // runtime guard for malformed third-party/provider responses.
  access.refresh = malformedRefresh as typeof originalRefresh;

  return () => {
    Object.assign(method, { client: originalClient });
    access.refresh = originalRefresh;
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
    readonly sourceUserId?: string;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  const sourceUserId = args.sourceUserId ?? ORG_SENTINEL_USER_ID;
  await db.insert(modelProviders).values({
    orgId: fixture.orgId,
    userId: sourceUserId,
    type: "codex-oauth-token",
    authMethod: "auth_json",
    tokenExpiresAt: args.tokenExpiresAt,
    needsReconnect: args.needsReconnect,
    lastRefreshErrorCode: args.lastRefreshErrorCode,
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: sourceUserId,
    name: "CHATGPT_ACCESS_TOKEN",
    value: args.accessToken,
    type: "model-provider",
  });
  await seedSecret({
    orgId: fixture.orgId,
    userId: sourceUserId,
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

async function codexProviderState(
  fixture: FirewallFixture,
  sourceUserId = ORG_SENTINEL_USER_ID,
): Promise<{
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
        eq(modelProviders.userId, sourceUserId),
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
    mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "cloudflare-client");
    mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_SECRET", "cloudflare-secret");
    mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client");
    mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-secret");
  });

  afterEach(() => {
    restoreDynamicTestOAuthRefresh?.();
    restoreDynamicTestOAuthRefresh = undefined;
    restoreFirewallAuthRefreshTimeout?.();
    restoreFirewallAuthRefreshTimeout = undefined;
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

  it("returns refresh failure when provider output omits the runtime token", async () => {
    const dynamicOAuth = useMalformedTestOAuthApiRefresh({
      outputs: {
        secondaryToken: "fresh-secondary-only-token",
      },
    });
    restoreDynamicTestOAuthRefresh = dynamicOAuth.restore;
    const fixture = await track(seedFixture());
    await seedExpiredTestOAuthApiConnector(fixture);

    const response = await accept(
      firewallClient().resolve({
        body: {
          encryptedSecrets: encryptedSecrets({
            TEST_OAUTH_TOKEN: "stale-test-oauth-api-token",
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
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "TOKEN_REFRESH_FAILED",
      connectors: ["test-oauth"],
      failureReason: "upstream_provider",
    });
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "TEST_OAUTH_API_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("stale-test-oauth-api-token");
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "TEST_OAUTH_API_SECONDARY_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("old-test-oauth-api-secondary-token");
    const db = store.set(writeDb$);
    const [connector] = await db
      .select({ needsReconnect: connectors.needsReconnect })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, fixture.orgId),
          eq(connectors.userId, fixture.userId),
          eq(connectors.type, "test-oauth"),
        ),
      );
    expect(connector?.needsReconnect).toBeFalsy();
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

  it("returns missing configuration when a connector row disappears before locked refresh", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    let refreshCallCount = 0;
    server.use(
      http.post("https://api.notion.com/v1/oauth/token", () => {
        refreshCallCount += 1;
        return HttpResponse.json({
          access_token: "unexpected-notion-token",
          refresh_token: "unexpected-notion-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    const lockAcquired = deferred();
    const releaseLock = deferred();
    const lockPromise = holdConnectorStateLock({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
      release: releaseLock.promise,
      onAcquired: lockAcquired.resolve,
    });
    await lockAcquired.promise;

    const responsePromise = accept(
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
    const response = await waitForConnectorStateLockWaiter({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "notion",
    })
      .then(async () => {
        const db = store.set(writeDb$);
        await db
          .delete(connectors)
          .where(
            and(
              eq(connectors.orgId, fixture.orgId),
              eq(connectors.userId, fixture.userId),
              eq(connectors.type, "notion"),
            ),
          );
        releaseLock.resolve();

        return responsePromise;
      })
      .finally(async () => {
        releaseLock.resolve();
        await Promise.allSettled([lockPromise, responsePromise]);
      });

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
    expect(refreshCallCount).toBe(0);
  });

  it("rejects stale encrypted static connector access when current storage is missing", async () => {
    const fixture = await track(seedFixture());
    await seedStripeStaticConnector(fixture);

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

  it("serializes concurrent model-provider access refreshes for rotated refresh tokens", async () => {
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

  it("returns missing configuration when a model-provider row disappears before locked refresh", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredCodexModelProvider(fixture);
    let refreshCallCount = 0;
    server.use(
      http.post("https://auth.openai.com/oauth/token", () => {
        refreshCallCount += 1;
        return HttpResponse.json({
          access_token: "unexpected-chatgpt-token",
          refresh_token: "unexpected-chatgpt-refresh",
          expires_in: 3600,
        });
      }),
    );

    const lockAcquired = deferred();
    const releaseLock = deferred();
    const lockPromise = holdModelProviderStateLock({
      orgId: fixture.orgId,
      userId: ORG_SENTINEL_USER_ID,
      providerType: "codex-oauth-token",
      release: releaseLock.promise,
      onAcquired: lockAcquired.resolve,
    });
    await lockAcquired.promise;

    const responsePromise = accept(
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
      [424],
    );
    const response = await waitForModelProviderStateLockWaiter({
      orgId: fixture.orgId,
      userId: ORG_SENTINEL_USER_ID,
      providerType: "codex-oauth-token",
    })
      .then(async () => {
        const db = store.set(writeDb$);
        await db
          .delete(modelProviders)
          .where(
            and(
              eq(modelProviders.orgId, fixture.orgId),
              eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
              eq(modelProviders.type, "codex-oauth-token"),
            ),
          );
        releaseLock.resolve();

        return responsePromise;
      })
      .finally(async () => {
        releaseLock.resolve();
        await Promise.allSettled([lockPromise, responsePromise]);
      });

    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
    expect(refreshCallCount).toBe(0);
  });

  it("preserves model-provider reauth that races with runtime access refresh", async () => {
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

  it("returns missing configuration when a skipped model-provider row disappears during another refresh", async () => {
    const fixture = await track(seedFixture());
    await seedExpiredNotionConnector(fixture);
    await seedCodexModelProvider(fixture, {
      accessToken: "current-deleted-chatgpt-token",
      refreshToken: "deleted-chatgpt-refresh-token",
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
          .delete(modelProviders)
          .where(
            and(
              eq(modelProviders.orgId, fixture.orgId),
              eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
              eq(modelProviders.type, "codex-oauth-token"),
            ),
          );
        return HttpResponse.json({
          access_token: "fresh-deleted-notion-token",
          refresh_token: "rotated-deleted-notion-refresh-token",
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
      [424],
    );

    expect(notionRefreshCallCount).toBe(1);
    expect(response.body).toStrictEqual({
      error: {
        message: "Connector not configured",
        code: "CONNECTOR_NOT_CONFIGURED",
      },
    });
    await expect(
      readSecret({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "NOTION_ACCESS_TOKEN",
        type: "connector",
      }),
    ).resolves.toBe("fresh-deleted-notion-token");
  });
});
