import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroBankingContract } from "@vm0/api-contracts/contracts/zero-banking";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import {
  readBankingAuditEventsState,
  seedBankingState,
} from "./helpers/zero-banking-state";

const context = testContext();

const FINICITY_BASE_URL = "https://api.finicity.com";
const FINICITY_AUTH_URL = `${FINICITY_BASE_URL}/aggregation/v2/partners/authentication`;

type BankingConnectionStatus =
  | "active"
  | "repair_required"
  | "revoked"
  | "deleted";
type BankingOperationScope =
  | "accounts.read"
  | "balances.read"
  | "transactions.read";

interface BankingFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly providerCustomerId: string;
  readonly enabledAccountId: string;
  readonly disabledAccountId: string;
}

interface SeedBankingFixtureArgs {
  readonly triggerSource?: "workflow-schedule" | "workflow-event";
  readonly operationScopes?: readonly BankingOperationScope[];
  readonly allowAutomationRuns?: boolean;
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
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Banking fixtures require an org-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Banking Agent",
    visibility: "private",
  });

  const run = args.triggerSource
    ? await api.createDirectRun(actor, {
        agentComposeId: agent.agentId,
        prompt: "banking automation precondition",
        modelProviderType: "anthropic-api-key",
        triggerSource: args.triggerSource,
        vars: { ZERO_AGENT_ID: agent.agentId },
        secrets: { ZERO_TOKEN: "bdd-banking-zero-token" },
      })
    : await api.createRun(actor, {
        agentId: agent.agentId,
        prompt: "banking precondition",
        modelProvider: "anthropic-api-key",
      });

  const providerCustomerId = randomProviderId("customer");
  const enabledAccountId = randomProviderId("acct-enabled");
  const disabledAccountId = randomProviderId("acct-disabled");
  if (args.featureSwitchEnabled ?? true) {
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: actor.userId,
        orgId: actor.orgId,
      },
      {
        [FeatureSwitchKey.Banking]: true,
      },
    );
  }

  const operationScopes = [
    ...(args.operationScopes ?? [
      "accounts.read",
      "balances.read",
      "transactions.read",
    ]),
  ];
  const connection = await seedBankingState(context, {
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
    providerCustomerId,
    enabledAccountId,
    disabledAccountId,
    accountProviderIds: [...(args.accountProviderIds ?? [enabledAccountId])],
    operationScopes,
    // #17307 D3: only allow_automation_runs is seeded; the legacy
    // allow_scheduled_runs column is NOT NULL with a default and drops in the
    // final phase.
    allowAutomationRuns: args.allowAutomationRuns ?? false,
    connectionStatus: args.connectionStatus ?? "active",
  });

  return {
    orgId: actor.orgId,
    userId: actor.userId,
    runId: run.runId,
    agentId: agent.agentId,
    connectionId: connection.connectionId,
    providerCustomerId,
    enabledAccountId,
    disabledAccountId,
  };
}

async function bankingAuditEvents(fixture: BankingFixture) {
  return await readBankingAuditEventsState(context, fixture);
}

function finicityAuthHandler() {
  return http.post(FINICITY_AUTH_URL, async ({ request }) => {
    const body = await request.json();
    expect(request.headers.get("Finicity-App-Key")).toBe("test-app-key");
    expect(body).toStrictEqual({
      partnerId: "test-partner",
      partnerSecret: "test-secret",
    });
    return HttpResponse.json({ token: "test-app-token" });
  });
}

describe("POST /api/zero/banking/*", () => {
  beforeEach(() => {
    mockEnv("FINICITY_APP_KEY", "test-app-key");
    mockEnv("FINICITY_APP_SECRET", "test-secret");
    mockEnv("FINICITY_PARTNER_ID", "test-partner");
  });

  it("rejects banking requests when the banking feature switch is disabled", async () => {
    const fixture = await seedBankingFixture({ featureSwitchEnabled: false });
    let authRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.accounts({
        headers: { authorization: `Bearer ${zeroToken(fixture)}` },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Zero Banking is not enabled",
        code: "FORBIDDEN",
      },
    });
    expect(authRequestCount).toBe(0);
  });

  it("lists only accounts enabled for the current agent", async () => {
    const fixture = await seedBankingFixture();
    let accountsRequestHeaders: Headers | undefined;
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        ({ request }) => {
          accountsRequestHeaders = request.headers;
          return HttpResponse.json({
            accounts: [
              {
                id: fixture.enabledAccountId,
                name: "Provider Checking",
                type: "checking",
                realAccountNumberLast4: "6789",
                status: "active",
                currency: "USD",
              },
              {
                id: fixture.disabledAccountId,
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

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.accounts({
        headers: { authorization: `Bearer ${zeroToken(fixture)}` },
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
    expect(response.body).toStrictEqual({
      operation: "accounts",
      provider: "finicity",
      accounts: [
        {
          id: fixture.enabledAccountId,
          name: "Provider Checking",
          institutionName: "Example Bank",
          type: "checking",
          last4: "6789",
          status: "active",
          currency: "USD",
        },
      ],
    });
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: null,
      },
    ]);
  });

  it("denies balances for accounts not enabled for the agent", async () => {
    const fixture = await seedBankingFixture();
    let accountsRequestCount = 0;
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        () => {
          accountsRequestCount += 1;
          return HttpResponse.json({ accounts: [] });
        },
      ),
    );

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.balances({
        headers: { authorization: `Bearer ${zeroToken(fixture)}` },
        body: { accountId: fixture.disabledAccountId },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("BANKING_ACCESS_DENIED");
    expect(accountsRequestCount).toBe(0);
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "balances.read",
        status: "denied",
        failureCode: "ACCOUNT_NOT_ALLOWED",
        providerAccountId: fixture.disabledAccountId,
      },
    ]);
  });

  it("reads balances through Finicity with only sanitized fields returned", async () => {
    const fixture = await seedBankingFixture();
    server.use(
      finicityAuthHandler(),
      http.get(
        `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
        () => {
          return HttpResponse.json({
            accounts: [
              {
                id: fixture.enabledAccountId,
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

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.balances({
        headers: { authorization: `Bearer ${zeroToken(fixture)}` },
        body: { accountId: fixture.enabledAccountId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      operation: "balances",
      provider: "finicity",
      balance: {
        accountId: fixture.enabledAccountId,
        name: "Provider Checking",
        type: "checking",
        balance: 1234.56,
        availableBalance: 1200.34,
        currency: "USD",
        balanceDate: 1_767_225_600,
      },
    });
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "balances.read",
        status: "allowed",
        failureCode: null,
        providerAccountId: fixture.enabledAccountId,
      },
    ]);
  });

  it("rejects zero tokens without banking capability before provider access", async () => {
    const fixture = await seedBankingFixture();
    let authRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.accounts({
        headers: {
          authorization: `Bearer ${zeroToken(fixture, ["file:read"])}`,
        },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: banking:read",
        code: "FORBIDDEN",
      },
    });
    expect(authRequestCount).toBe(0);
  });

  it.each(["workflow-schedule", "workflow-event"] as const)(
    "denies %s runs unless the banking grant allows automations",
    async (triggerSource) => {
      const fixture = await seedBankingFixture({ triggerSource });
      let authRequestCount = 0;
      server.use(
        http.post(FINICITY_AUTH_URL, () => {
          authRequestCount += 1;
          return HttpResponse.json({ token: "test-app-token" });
        }),
      );

      const client = setupApp({ context })(zeroBankingContract);
      const response = await accept(
        client.accounts({
          headers: { authorization: `Bearer ${zeroToken(fixture)}` },
          body: {},
        }),
        [403],
      );

      expect(response.body.error.message).toBe(
        "Banking is not enabled for automation runs",
      );
      expect(authRequestCount).toBe(0);
      await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
        {
          action: "accounts.read",
          status: "denied",
          failureCode: "AUTOMATION_NOT_ALLOWED",
        },
      ]);
    },
  );

  it.each(["workflow-schedule", "workflow-event"] as const)(
    "allows %s runs when the banking grant allows automations",
    async (triggerSource) => {
      const fixture = await seedBankingFixture({
        triggerSource,
        allowAutomationRuns: true,
      });
      server.use(
        finicityAuthHandler(),
        http.get(
          `${FINICITY_BASE_URL}/aggregation/v1/customers/${fixture.providerCustomerId}/accounts`,
          () => {
            return HttpResponse.json({ accounts: [] });
          },
        ),
      );

      const client = setupApp({ context })(zeroBankingContract);
      const response = await accept(
        client.accounts({
          headers: { authorization: `Bearer ${zeroToken(fixture)}` },
          body: {},
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        operation: "accounts",
        provider: "finicity",
      });
      expect(response.body.accounts).toHaveLength(1);
      await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
        {
          action: "accounts.read",
          status: "allowed",
          failureCode: null,
        },
      ]);
    },
  );

  it("denies revoked banking connections before provider access", async () => {
    const fixture = await seedBankingFixture({ connectionStatus: "revoked" });
    let authRequestCount = 0;
    server.use(
      http.post(FINICITY_AUTH_URL, () => {
        authRequestCount += 1;
        return HttpResponse.json({ token: "test-app-token" });
      }),
    );

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.accounts({
        headers: { authorization: `Bearer ${zeroToken(fixture)}` },
        body: {},
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Banking is not enabled for this agent",
    );
    expect(authRequestCount).toBe(0);
    await expect(bankingAuditEvents(fixture)).resolves.toMatchObject([
      {
        action: "accounts.read",
        status: "denied",
        failureCode: "NO_ACTIVE_GRANT",
      },
    ]);
  });

  it("reads transactions through Finicity with only sanitized fields returned", async () => {
    const fixture = await seedBankingFixture();
    let requestedUrl: URL | undefined;
    server.use(
      finicityAuthHandler(),
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

    const client = setupApp({ context })(zeroBankingContract);
    const response = await accept(
      client.transactions({
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
