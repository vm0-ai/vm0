import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroBankingContract } from "@vm0/api-contracts/contracts/zero-banking";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  bankingAccessAuditEvents,
  bankingAccounts,
  bankingAgentEnablements,
  bankingConnections,
  type BankingConnectionStatus,
  type BankingOperationScope,
} from "@vm0/db/schema/banking";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now, nowDate } from "../../external/time";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-banking.test.ts`.
// The 8 legacy `it()`s collapse into 3 BDD `it()`s:
// (1) authorization chain (403 feature switch disabled +
// 403 wrong capability + 403 scheduled runs not allowed +
// 403 revoked connection — all before any provider call),
// (2) accounts + balances chain (200 lists only enabled
// accounts + writes accounts.read audit + 403 denies
// disabled account balances + 200 reads balances with
// sanitized fields + writes balances.read audit),
// (3) transactions chain (200 reads transactions with
// sanitized fields + writes transactions.read audit +
// query params map to fromDate/toDate/limit).

const context = testContext();
const store = createStore();

const FINICITY_BASE_URL = "https://api.finicity.com";
const FINICITY_AUTH_URL = `${FINICITY_BASE_URL}/aggregation/v2/partners/authentication`;

interface BankingFixture extends UsageInsightFixture {
  readonly runId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly providerCustomerId: string;
  readonly enabledAccountId: string;
  readonly disabledAccountId: string;
}

interface SeedBankingFixtureArgs {
  readonly triggerSource?: string;
  readonly operationScopes?: readonly BankingOperationScope[];
  readonly allowScheduledRuns?: boolean;
  readonly connectionStatus?: BankingConnectionStatus;
  readonly accountProviderIds?: readonly string[];
  readonly featureSwitchEnabled?: boolean;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(
  fixture: BankingFixture,
  capabilities: readonly ZeroCapability[] = ["banking:read"],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: fixture.runId,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function randomProviderId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function seedBankingFixture(
  args: SeedBankingFixtureArgs = {},
): Promise<BankingFixture> {
  const fixture = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  await store.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );
  const compose = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const run = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: compose.composeId,
      status: "running",
      triggerSource: args.triggerSource,
    },
    context.signal,
  );

  const providerCustomerId = randomProviderId("customer");
  const enabledAccountId = randomProviderId("acct-enabled");
  const disabledAccountId = randomProviderId("acct-disabled");
  const db = store.set(writeDb$);
  if (args.featureSwitchEnabled ?? true) {
    await db.insert(userFeatureSwitches).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.Banking]: true },
      updatedAt: nowDate(),
    });
  }

  const [connection] = await db
    .insert(bankingConnections)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      providerCustomerId,
      status: args.connectionStatus ?? "active",
      revokedAt:
        args.connectionStatus === "revoked" ? new Date("2026-01-01") : null,
    })
    .returning({ id: bankingConnections.id });
  if (!connection) {
    throw new Error("seedBankingFixture: connection insert returned no row");
  }

  await db.insert(bankingAccounts).values([
    {
      connectionId: connection.id,
      orgId: fixture.orgId,
      userId: fixture.userId,
      providerAccountId: enabledAccountId,
      displayName: "Everyday Checking",
      institutionName: "Example Bank",
      accountType: "checking",
      accountNumberLast4: "6789",
      enabled: true,
    },
    {
      connectionId: connection.id,
      orgId: fixture.orgId,
      userId: fixture.userId,
      providerAccountId: disabledAccountId,
      displayName: "Old Savings",
      institutionName: "Example Bank",
      accountType: "savings",
      accountNumberLast4: "4321",
      enabled: false,
    },
  ]);

  await db.insert(bankingAgentEnablements).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    agentId: compose.agentId,
    connectionId: connection.id,
    accountProviderIds: [...(args.accountProviderIds ?? [enabledAccountId])],
    operationScopes: [
      ...(args.operationScopes ?? [
        "accounts.read",
        "balances.read",
        "transactions.read",
      ]),
    ],
    allowScheduledRuns: args.allowScheduledRuns ?? false,
  });

  return {
    ...fixture,
    runId: run.runId,
    agentId: compose.agentId,
    connectionId: connection.id,
    providerCustomerId,
    enabledAccountId,
    disabledAccountId,
  };
}

async function deleteBankingFixture(fixture: BankingFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(bankingAccessAuditEvents)
    .where(
      and(
        eq(bankingAccessAuditEvents.orgId, fixture.orgId),
        eq(bankingAccessAuditEvents.userId, fixture.userId),
      ),
    );
  await db
    .delete(bankingAgentEnablements)
    .where(
      and(
        eq(bankingAgentEnablements.orgId, fixture.orgId),
        eq(bankingAgentEnablements.userId, fixture.userId),
      ),
    );
  await db
    .delete(bankingAccounts)
    .where(
      and(
        eq(bankingAccounts.orgId, fixture.orgId),
        eq(bankingAccounts.userId, fixture.userId),
      ),
    );
  await db
    .delete(bankingConnections)
    .where(
      and(
        eq(bankingConnections.orgId, fixture.orgId),
        eq(bankingConnections.userId, fixture.userId),
      ),
    );
  await store.set(deleteOrgMembership$, fixture, context.signal);
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function bankingAuditEvents(fixture: BankingFixture) {
  return await store
    .set(writeDb$)
    .select({
      action: bankingAccessAuditEvents.action,
      status: bankingAccessAuditEvents.status,
      failureCode: bankingAccessAuditEvents.failureCode,
      providerAccountId: bankingAccessAuditEvents.providerAccountId,
    })
    .from(bankingAccessAuditEvents)
    .where(
      and(
        eq(bankingAccessAuditEvents.orgId, fixture.orgId),
        eq(bankingAccessAuditEvents.userId, fixture.userId),
      ),
    );
}

const track = createFixtureTracker(deleteBankingFixture);

function client() {
  return setupApp({ context })(zeroBankingContract);
}

describe("BDD POST /api/zero/banking/* — authorization chain", () => {
  beforeEach(() => {
    mockEnv("FINICITY_APP_KEY", "test-app-key");
    mockEnv("FINICITY_APP_SECRET", "test-secret");
    mockEnv("FINICITY_PARTNER_ID", "test-partner");
  });

  afterEach(() => {
    clearMockedEnv();
  });

  it("gwt-wt-wt: 403 feature switch disabled → 403 wrong capability → 403 scheduled runs not allowed → 403 revoked connection", async () => {
    // Given: a fixture with the banking feature switch
    // disabled.

    // When + Then: 403 — Zero Banking is not enabled
    // + no Finicity auth call is made.
    const disabledFixture = await track(
      seedBankingFixture({ featureSwitchEnabled: false }),
    );
    let authRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );
    const disabledResponse = await accept(
      client().accounts({
        headers: { authorization: `Bearer ${zeroToken(disabledFixture)}` },
        body: {},
      }),
      [403],
    );
    expect(disabledResponse.body).toStrictEqual({
      error: {
        message: "Zero Banking is not enabled",
        code: "FORBIDDEN",
      },
    });
    expect(authRequestCount).toBe(0);

    // Given: a fixture + a zero token without
    // banking:read.

    // When + Then: 403 — Missing required capability +
    // no Finicity auth call.
    const wrongCapFixture = await track(seedBankingFixture());
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );
    const wrongCapResponse = await accept(
      client().accounts({
        headers: {
          authorization: `Bearer ${zeroToken(wrongCapFixture, ["file:read"])}`,
        },
        body: {},
      }),
      [403],
    );
    expect(wrongCapResponse.body).toStrictEqual({
      error: {
        message: "Missing required capability: banking:read",
        code: "FORBIDDEN",
      },
    });
    expect(authRequestCount).toBe(0);

    // Given: a fixture with a schedule-triggered run +
    // a grant that disallows scheduled runs.

    // When + Then: 403 — Banking is not enabled for
    // scheduled runs + a denied audit event with
    // SCHEDULE_NOT_ALLOWED is written.
    const scheduleFixture = await track(
      seedBankingFixture({ triggerSource: "schedule" }),
    );
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );
    const scheduleResponse = await accept(
      client().accounts({
        headers: { authorization: `Bearer ${zeroToken(scheduleFixture)}` },
        body: {},
      }),
      [403],
    );
    expect(scheduleResponse.body.error.message).toBe(
      "Banking is not enabled for scheduled runs",
    );
    expect(authRequestCount).toBe(0);
    await expect(bankingAuditEvents(scheduleFixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "denied",
        failureCode: "SCHEDULE_NOT_ALLOWED",
      },
    ]);

    // Given: a fixture with a revoked connection.

    // When + Then: 403 — Banking is not enabled for
    // this agent + a denied audit event with
    // NO_ACTIVE_GRANT is written.
    const revokedFixture = await track(
      seedBankingFixture({ connectionStatus: "revoked" }),
    );
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );
    const revokedResponse = await accept(
      client().accounts({
        headers: { authorization: `Bearer ${zeroToken(revokedFixture)}` },
        body: {},
      }),
      [403],
    );
    expect(revokedResponse.body.error.message).toBe(
      "Banking is not enabled for this agent",
    );
    expect(authRequestCount).toBe(0);
    await expect(bankingAuditEvents(revokedFixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "denied",
        failureCode: "NO_ACTIVE_GRANT",
      },
    ]);
  });
});

describe("BDD POST /api/zero/banking/* — accounts + balances chain", () => {
  beforeEach(() => {
    mockEnv("FINICITY_APP_KEY", "test-app-key");
    mockEnv("FINICITY_APP_SECRET", "test-secret");
    mockEnv("FINICITY_PARTNER_ID", "test-partner");
  });

  afterEach(() => {
    clearMockedEnv();
  });

  it("gwt-wt-wt: 200 lists only enabled accounts → 403 denies disabled account balances → 200 reads balances with sanitized fields", async () => {
    // Given: a fixture with a Finicity accounts
    // endpoint returning both enabled + disabled
    // accounts.

    // When + Then: 200 — the response contains only
    // the enabled account + an accounts.read allowed
    // audit event is written + the Finicity app
    // key/token headers are forwarded.
    const accountsFixture = await track(seedBankingFixture());
    let accountsRequestHeaders: Headers | undefined;
    server.use(
      http.post(FINICITY_AUTH_URL, async ({ request }) => {
        expect(request.headers.get("Finicity-App-Key")).toBe("test-app-key");
        return HttpResponse.json({ token: "test-app-token" });
      }),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${accountsFixture.providerCustomerId}/accounts`,
        ({ request }) => {
          accountsRequestHeaders = request.headers;
          return HttpResponse.json({
            accounts: [
              {
                id: accountsFixture.enabledAccountId,
                name: "Provider Checking",
                type: "checking",
                realAccountNumberLast4: "6789",
                status: "active",
                currency: "USD",
              },
              {
                id: accountsFixture.disabledAccountId,
                name: "Disabled Savings",
                type: "savings",
                realAccountNumberLast4: "4321",
                status: "active",
                currency: "USD",
              },
            ],
          });
        },
      ),
    );
    const accountsResponse = await accept(
      client().accounts({
        headers: { authorization: `Bearer ${zeroToken(accountsFixture)}` },
        body: {},
      }),
      [200],
    );
    expect(accountsRequestHeaders?.get("Finicity-App-Key")).toBe(
      "test-app-key",
    );
    expect(accountsRequestHeaders?.get("Finicity-App-Token")).toBe(
      "test-app-token",
    );
    expect(accountsResponse.body).toStrictEqual({
      operation: "accounts",
      provider: "finicity",
      accounts: [
        {
          id: accountsFixture.enabledAccountId,
          name: "Provider Checking",
          institutionName: "Example Bank",
          type: "checking",
          last4: "6789",
          status: "active",
          currency: "USD",
        },
      ],
    });
    await expect(bankingAuditEvents(accountsFixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: null,
      },
    ]);

    // Given: a fixture with no Finicity accounts
    // endpoint (returns []).

    // When + Then: 403 — BANKING_ACCESS_DENIED for the
    // disabled account + no accounts endpoint is hit +
    // a denied audit event with ACCOUNT_NOT_ALLOWED is
    // written.
    const deniedFixture = await track(seedBankingFixture());
    let accountsRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, async () => {
        return HttpResponse.json({ token: "test-app-token" });
      }),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${deniedFixture.providerCustomerId}/accounts`,
        () => {
          accountsRequestCount += 1;
          return HttpResponse.json({ accounts: [] });
        },
      ),
    );
    const deniedResponse = await accept(
      client().balances({
        headers: { authorization: `Bearer ${zeroToken(deniedFixture)}` },
        body: { accountId: deniedFixture.disabledAccountId },
      }),
      [403],
    );
    expect(deniedResponse.body.error.code).toBe("BANKING_ACCESS_DENIED");
    expect(accountsRequestCount).toBe(0);
    await expect(bankingAuditEvents(deniedFixture)).resolves.toMatchObject([
      {
        action: "balances.read",
        status: "denied",
        failureCode: "ACCOUNT_NOT_ALLOWED",
        providerAccountId: deniedFixture.disabledAccountId,
      },
    ]);

    // Given: a fixture + a Finicity accounts endpoint
    // returning one account with extra rawProviderField.

    // When + Then: 200 — the balance response contains
    // only sanitized fields + a balances.read allowed
    // audit event is written.
    const balancesFixture = await track(seedBankingFixture());
    server.use(
      http.post(FINICITY_AUTH_URL, async () => {
        return HttpResponse.json({ token: "test-app-token" });
      }),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${balancesFixture.providerCustomerId}/accounts`,
        () => {
          return HttpResponse.json({
            accounts: [
              {
                id: balancesFixture.enabledAccountId,
                name: "Provider Checking",
                type: "checking",
                balance: 1234.56,
                availableBalance: 1200.34,
                currency: "USD",
                balanceDate: 1_767_225_600,
                rawProviderField: "not returned",
              },
            ],
          });
        },
      ),
    );
    const balancesResponse = await accept(
      client().balances({
        headers: { authorization: `Bearer ${zeroToken(balancesFixture)}` },
        body: { accountId: balancesFixture.enabledAccountId },
      }),
      [200],
    );
    expect(balancesResponse.body).toStrictEqual({
      operation: "balances",
      provider: "finicity",
      balance: {
        accountId: balancesFixture.enabledAccountId,
        name: "Provider Checking",
        type: "checking",
        balance: 1234.56,
        availableBalance: 1200.34,
        currency: "USD",
        balanceDate: 1_767_225_600,
      },
    });
    await expect(bankingAuditEvents(balancesFixture)).resolves.toMatchObject([
      {
        action: "balances.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: balancesFixture.enabledAccountId,
      },
    ]);
  });
});

describe("BDD POST /api/zero/banking/transactions — transactions chain", () => {
  beforeEach(() => {
    mockEnv("FINICITY_APP_KEY", "test-app-key");
    mockEnv("FINICITY_APP_SECRET", "test-secret");
    mockEnv("FINICITY_PARTNER_ID", "test-partner");
  });

  afterEach(() => {
    clearMockedEnv();
  });

  it("gwt-wt-wt: 200 reads transactions with sanitized fields + query params map to fromDate/toDate/limit", async () => {
    // Given: a fixture + a Finicity transactions
    // endpoint returning one transaction with extra
    // rawProviderField.

    // When + Then: 200 — the response contains only
    // sanitized fields + the fromDate/toDate/limit
    // query params are mapped to UTC timestamps + a
    // transactions.read allowed audit event is written.
    const fixture = await track(seedBankingFixture());
    let requestedUrl: URL | undefined;
    server.use(
      http.post(FINICITY_AUTH_URL, async () => {
        return HttpResponse.json({ token: "test-app-token" });
      }),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v3/customers/${fixture.providerCustomerId}/accounts/${fixture.enabledAccountId}/transactions`,
        ({ request }) => {
          requestedUrl = new URL(request.url);
          return HttpResponse.json({
            transactions: [
              {
                id: "txn-1",
                amount: -42.5,
                description: "Coffee",
                memo: "latte",
                postedDate: 1_767_225_600,
                transactionDate: 1_767_225_600,
                status: "active",
                categorization: "Food & Dining",
                merchant: "Cafe",
                rawProviderField: "not returned",
              },
            ],
          });
        },
      ),
    );
    const response = await accept(
      client().transactions({
        headers: { authorization: `Bearer ${zeroToken(fixture)}` },
        body: {
          accountId: fixture.enabledAccountId,
          from: "2026-01-01",
          to: "2026-01-31",
          limit: 25,
        },
      }),
      [200],
    );
    expect(requestedUrl?.searchParams.get("fromDate")).toBe(
      String(Math.floor(Date.UTC(2026, 0, 1) / 1000)),
    );
    expect(requestedUrl?.searchParams.get("toDate")).toBe(
      String(Math.floor(Date.UTC(2026, 0, 31) / 1000) + 86_399),
    );
    expect(requestedUrl?.searchParams.get("limit")).toBe("25");
    expect(response.body).toStrictEqual({
      operation: "transactions",
      provider: "finicity",
      accountId: fixture.enabledAccountId,
      transactions: [
        {
          id: "txn-1",
          accountId: fixture.enabledAccountId,
          amount: -42.5,
          description: "Coffee",
          memo: "latte",
          postedDate: 1_767_225_600,
          transactionDate: 1_767_225_600,
          status: "active",
          categorization: "Food & Dining",
          merchant: "Cafe",
        },
      ],
    });
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "transactions.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: fixture.enabledAccountId,
      },
    ]);
  });
});
