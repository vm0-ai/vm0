import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import {
  materializeHourlyUsage$,
  readUsageStorageCounts$,
} from "./helpers/zero-usage-insight";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const billing = createBillingMediaApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createZeroRouteMocks(context);
const store = createStore();

const MODEL_TOKEN_CATEGORIES = {
  input: "tokens.input",
  output: "tokens.output",
  cacheRead: "tokens.cache_read",
  cacheCreation: "tokens.cache_creation",
} as const;

interface ModelTokenCounts {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageRunsContract);
}

function userIdsFromClerkRequest(args: unknown): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }
  const value = Reflect.get(args, "userId");
  if (
    Array.isArray(value) &&
    value.every((item): item is string => {
      return typeof item === "string";
    })
  ) {
    return value;
  }
  return [];
}

function mockClerkUserLookup(): void {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    return Promise.resolve({
      data: userIdsFromClerkRequest(args).map((userId) => {
        const emailId = `email_${userId}`;
        return {
          id: userId,
          primaryEmailAddressId: emailId,
          emailAddresses: [
            { id: emailId, emailAddress: `${userId}@example.com` },
          ],
        };
      }),
    });
  });
}

function createdAt(minutesAgo: number): Date {
  return new Date(nowDate().getTime() - minutesAgo * 60 * 1000);
}

async function entitledUsageActor(): Promise<ApiTestUser> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  await api.grantProEntitlement(actor);
  return actor;
}

/**
 * Creates a run whose compose declares an inline framework API key. Such runs
 * skip model-provider resolution (zero_runs.model_provider stays NULL), so the
 * sandbox usage-event webhook accepts their model-kind events into the
 * billing ledger. Without runner infrastructure the run settles into a
 * terminal status on creation; usage reads only depend on the run row.
 */
async function createBillableRun(
  actor: ApiTestUser,
  args: {
    readonly prompt?: string;
    readonly triggerSource?: TriggerSource;
    readonly createdAt?: Date;
  } = {},
): Promise<{ readonly runId: string; readonly composeId: string }> {
  const name = `bdd-usage-runs-${randomUUID().slice(0, 8)}`;
  const compose = await api.createCompose(actor, {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      },
    },
  });
  if (args.createdAt) {
    mockNow(args.createdAt);
  }
  const run = await api.createDirectRun(actor, {
    agentComposeId: compose.composeId,
    prompt: args.prompt ?? "usage run",
    ...(args.triggerSource ? { triggerSource: args.triggerSource } : {}),
  });
  if (args.createdAt) {
    clearMockNow();
  }
  return { runId: run.runId, composeId: compose.composeId };
}

// Unit pricing (1 credit per token) keeps webhook-recorded quantities and
// cron-computed credits aligned one-to-one for readable assertions.
async function seedModelPricing(model: string): Promise<void> {
  await seedUsagePricingRows(
    Object.values(MODEL_TOKEN_CATEGORIES).map((category) => {
      return {
        kind: "model",
        provider: model,
        category,
        unitPrice: 1,
        unitSize: 1,
      };
    }),
  );
}

async function seedConnectorPricing(provider: string): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider,
      category: "api_request",
      unitPrice: 10,
      unitSize: 1,
    },
  ]);
}

function sandboxHeaders(actor: ApiTestUser, runId: string) {
  return { authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}` };
}

async function recordModelUsage(
  actor: ApiTestUser,
  runId: string,
  model: string,
  tokens: ModelTokenCounts,
): Promise<void> {
  const events = (
    Object.keys(MODEL_TOKEN_CATEGORIES) as (keyof ModelTokenCounts)[]
  ).flatMap((key) => {
    const quantity = tokens[key];
    if (!quantity) {
      return [];
    }
    return [
      {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: model,
        category: MODEL_TOKEN_CATEGORIES[key],
        quantity,
      },
    ];
  });
  await webhooks.requestAgentUsageEvent(
    { runId, events },
    sandboxHeaders(actor, runId),
    [200],
  );
}

async function recordConnectorUsage(
  actor: ApiTestUser,
  runId: string,
  provider: string,
  quantity: number,
): Promise<void> {
  await webhooks.requestAgentUsageEvent(
    {
      runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "connector",
          provider,
          category: "api_request",
          quantity,
        },
      ],
    },
    sandboxHeaders(actor, runId),
    [200],
  );
}

function uniqueModelName(): string {
  return `bdd-model-${randomUUID().slice(0, 8)}`;
}

describe("GET /api/zero/usage/runs", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin users", async () => {
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can view run usage",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns empty result when no runs have processed usage events", async () => {
    mockClerkUserLookup();
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });

  it("returns per-run records with credit totals", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const older = await createBillableRun(actor, {
      createdAt: createdAt(10),
    });
    await recordModelUsage(actor, older.runId, model, {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheCreation: 100,
    });
    const newer = await createBillableRun(actor, {
      createdAt: createdAt(1),
    });
    await recordModelUsage(actor, newer.runId, model, {
      input: 2000,
      output: 1000,
    });
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);
    expect(response.body.runs[0]?.runId).toBe(newer.runId);
    expect(response.body.runs[0]?.creditsCharged).toBe(3000);
    expect(response.body.runs[1]?.runId).toBe(older.runId);
    expect(response.body.runs[1]?.creditsCharged).toBe(1800);
  });

  it("filters by runId", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const included = await createBillableRun(actor, {
      createdAt: createdAt(2),
    });
    const excluded = await createBillableRun(actor, {
      createdAt: createdAt(1),
    });
    await recordModelUsage(actor, included.runId, model, {
      input: 123,
      output: 45,
    });
    await recordModelUsage(actor, excluded.runId, model, {
      input: 999,
      output: 999,
    });
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { runId: included.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 20,
      total: 1,
    });
    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]).toMatchObject({
      runId: included.runId,
      model,
      inputTokens: 123,
      outputTokens: 45,
      creditsCharged: 168,
    });
  });

  it("rejects invalid runId format", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { runId: "not-a-uuid" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns empty result for runId without processed usage", async () => {
    const actor = await entitledUsageActor();
    const run = await createBillableRun(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { runId: run.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });

  it("does not leak another org's runId", async () => {
    const otherActor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);
    const otherRun = await createBillableRun(otherActor);
    await recordModelUsage(otherActor, otherRun.runId, model, {
      input: 100,
      output: 50,
    });
    await billing.processOrgUsageEvents(otherActor);

    mockClerkUserLookup();
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { runId: otherRun.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });

  it("paginates results correctly", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);
    const tiedCreatedAt = createdAt(10);
    const runIds: string[] = [];

    for (let index = 0; index < 3; index++) {
      const run = await createBillableRun(actor, {
        createdAt: tiedCreatedAt,
      });
      runIds.push(run.runId);
      await recordModelUsage(actor, run.runId, model, {
        output: (index + 1) * 10,
      });
    }
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response1 = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response1.body.runs).toHaveLength(2);
    const expectedRunIds = [...runIds].sort();
    expect(
      response1.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual(expectedRunIds.slice(0, 2));
    expect(response1.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 2,
      total: 3,
    });

    const response2 = await accept(
      apiClient().get({
        query: { page: 2, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(response2.body.runs).toHaveLength(1);
    expect(response2.body.runs[0]?.runId).toBe(expectedRunIds[2]);
    expect(response2.body.pagination.page).toBe(2);
  });

  it("filters by userIds", async () => {
    const actor = await entitledUsageActor();
    const member = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const model = uniqueModelName();
    await seedModelPricing(model);

    const actorRun = await createBillableRun(actor, {
      createdAt: createdAt(2),
    });
    const memberRun = await createBillableRun(member, {
      createdAt: createdAt(1),
    });
    await recordModelUsage(actor, actorRun.runId, model, { output: 50 });
    await recordModelUsage(member, memberRun.runId, model, { output: 100 });
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { userIds: ` ${member.userId}, ` },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.userId).toBe(member.userId);
    expect(response.body.runs[0]?.creditsCharged).toBe(100);
  });

  it("orders tied member totals by user ID", async () => {
    const actor = await entitledUsageActor();
    const members = [
      actor,
      bdd.user({ orgId: actor.orgId, orgRole: "org:member" }),
      bdd.user({ orgId: actor.orgId, orgRole: "org:member" }),
    ];
    const model = uniqueModelName();
    await seedModelPricing(model);
    for (const member of members) {
      const run = await createBillableRun(member);
      await recordModelUsage(member, run.runId, model, { output: 10 });
    }
    await billing.processOrgUsageEvents(actor);
    mockClerkUserLookup();

    const response = await billing.readUsageMembers(actor, {
      range: "today",
      tz: "UTC",
    });

    expect(
      response.body.members.map((member) => {
        return member.userId;
      }),
    ).toStrictEqual(
      members
        .map((member) => {
          return member.userId;
        })
        .sort(),
    );
  });

  it("filters by agentId", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const included = await createBillableRun(actor, {
      createdAt: createdAt(2),
    });
    const excluded = await createBillableRun(actor, {
      createdAt: createdAt(1),
    });
    await recordModelUsage(actor, included.runId, model, { output: 50 });
    await recordModelUsage(actor, excluded.runId, model, { output: 100 });
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { agentId: included.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(
      response.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual([included.runId]);
    expect(response.body.runs[0]?.creditsCharged).toBe(50);
  });

  it("filters by created-at date range", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const dateFrom = new Date("2026-01-10T00:00:00.000Z");
    const dateTo = new Date("2026-01-11T00:00:00.000Z");
    const before = await createBillableRun(actor, {
      createdAt: new Date("2026-01-09T12:00:00.000Z"),
    });
    const inside = await createBillableRun(actor, {
      createdAt: new Date("2026-01-10T12:00:00.000Z"),
    });
    const endBoundary = await createBillableRun(actor, {
      createdAt: dateTo,
    });
    const after = await createBillableRun(actor, {
      createdAt: new Date("2026-01-11T12:00:00.000Z"),
    });
    for (const run of [before, inside, endBoundary, after]) {
      await recordModelUsage(actor, run.runId, model, { output: 50 });
    }
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({
        query: {
          dateFrom: dateFrom.toISOString(),
          dateTo: dateTo.toISOString(),
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(
      response.body.runs.map((run) => {
        return run.runId;
      }),
    ).toStrictEqual([inside.runId]);
    expect(response.body.pagination.total).toBe(1);
  });

  it("excludes runs with only pending usage events", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const processed = await createBillableRun(actor, {
      createdAt: createdAt(2),
    });
    await recordModelUsage(actor, processed.runId, model, { output: 50 });
    await billing.processOrgUsageEvents(actor);

    const pending = await createBillableRun(actor, {
      createdAt: createdAt(1),
    });
    await recordModelUsage(actor, pending.runId, model, { output: 999 });

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]?.runId).toBe(processed.runId);
    expect(response.body.runs[0]?.creditsCharged).toBe(50);
  });

  it("processes usage events only for the requested organization", async () => {
    const actor = await entitledUsageActor();
    const otherActor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const run = await createBillableRun(actor);
    const otherRun = await createBillableRun(otherActor);
    await recordModelUsage(actor, run.runId, model, { output: 50 });
    await recordModelUsage(otherActor, otherRun.runId, model, { output: 100 });

    await billing.processOrgUsageEvents(actor);

    const response = await billing.readUsageRuns(actor, [200]);
    const otherResponse = await billing.readUsageRuns(otherActor, [200]);

    await billing.processOrgUsageEvents(otherActor);

    if (response.status !== 200 || otherResponse.status !== 200) {
      throw new Error("Expected usage runs reads to succeed");
    }
    expect(response.body.runs).toHaveLength(1);
    expect(response.body.runs[0]).toMatchObject({
      runId: run.runId,
      creditsCharged: 50,
    });
    expect(otherResponse.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });

  // Run-less usage events (built-in generation charges without a run) are
  // exercised through their own product surfaces in zero-image-io-generate
  // tests; the agent usage-event webhook always requires a run.
  it("aggregates mixed-kind usage_event records for a run", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    const connectorProvider = `bdd-connector-${randomUUID().slice(0, 8)}`;
    await seedModelPricing(model);
    await seedConnectorPricing(connectorProvider);

    const run = await createBillableRun(actor);
    await recordModelUsage(actor, run.runId, model, { input: 300 });
    await recordConnectorUsage(actor, run.runId, connectorProvider, 2);
    await billing.processOrgUsageEvents(actor);

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.runs[0]).toMatchObject({
      runId: run.runId,
      model,
      inputTokens: 300,
      outputTokens: 0,
      cacheTokens: 0,
      creditsCharged: 320,
    });
  });

  it("sums multiple usage_event totals for the same run", async () => {
    const actor = await entitledUsageActor();
    const model = uniqueModelName();
    await seedModelPricing(model);

    const run = await createBillableRun(actor);
    await recordModelUsage(actor, run.runId, model, {
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheCreation: 10,
    });
    await recordModelUsage(actor, run.runId, model, {
      input: 30,
      output: 70,
      cacheRead: 11,
      cacheCreation: 13,
    });
    await billing.processOrgUsageEvents(actor);

    // A later, still-pending event must not contribute to the totals.
    await recordModelUsage(actor, run.runId, model, { input: 9999 });

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.runs).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.runs[0]).toMatchObject({
      runId: run.runId,
      inputTokens: 130,
      outputTokens: 120,
      cacheTokens: 54,
      creditsCharged: 304,
    });
  });

  it("regroups mixed raw and hourly facts with partial allowance usage", async () => {
    const actor = await entitledUsageActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const firstRunAt = new Date(nowDate());
    firstRunAt.setUTCHours(8, 0, 0, 0);
    mockNow(firstRunAt);
    await postUsageAllowanceInvoicePaid(context.signal, {
      orgId: actor.orgId,
      userId: actor.userId,
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      effectiveAt: new Date(firstRunAt.getTime() - 1000),
      expiresAt: new Date(firstRunAt.getTime() + 365 * 86_400_000),
      shortWindowSeconds: 3600,
      shortWindowUnits: 100,
      weeklyWindowSeconds: 7 * 86_400,
      weeklyWindowUnits: 100,
    });
    const model = uniqueModelName();
    await seedModelPricing(model);
    const firstRun = await createBillableRun(actor);

    await recordModelUsage(actor, firstRun.runId, model, { input: 80 });
    await billing.processOrgUsageEvents(actor);
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: actor.orgId,
          userId: actor.userId,
          runId: firstRun.runId,
        },
        context.signal,
      ),
    ).resolves.toBe(1);

    mockNow(new Date(firstRunAt.getTime() + 2 * 3_600_000));
    const secondRun = await createBillableRun(actor);
    await recordModelUsage(actor, secondRun.runId, model, {
      input: 50,
      output: 40,
    });
    await billing.processOrgUsageEvents(actor);
    mockNow(new Date(firstRunAt.getTime() + 2 * 3_600_000 + 60_000));
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: actor.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 2, hourly: 1 });

    mockClerkUserLookup();
    mocks.clerk.session(actor.userId, actor.orgId);
    const runsResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(runsResponse.body.runs).toStrictEqual([
      expect.objectContaining({
        runId: secondRun.runId,
        model,
        inputTokens: 50,
        outputTokens: 40,
        creditsCharged: 90,
      }),
      expect.objectContaining({
        runId: firstRun.runId,
        model,
        inputTokens: 80,
        outputTokens: 0,
        creditsCharged: 80,
      }),
    ]);

    const membersResponse = await billing.readUsageMembers(actor, {
      range: "today",
      tz: "UTC",
    });
    expect(membersResponse.body.members).toStrictEqual([
      expect.objectContaining({
        userId: actor.userId,
        inputTokens: 130,
        outputTokens: 40,
        creditsCharged: 170,
      }),
    ]);

    await bdd.updateAgent(actor, firstRun.composeId, {
      displayName: "Deleted first usage agent",
      visibility: "private",
    });
    await bdd.updateAgent(actor, secondRun.composeId, {
      displayName: "Deleted second usage agent",
      visibility: "private",
    });
    await bdd.deleteAgent(actor, firstRun.composeId);
    await bdd.deleteAgent(actor, secondRun.composeId);
    const deletedRunsResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(deletedRunsResponse.body).toStrictEqual({
      runs: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
    const membersAfterRunDeletion = await billing.readUsageMembers(actor, {
      range: "today",
      tz: "UTC",
    });
    expect(membersAfterRunDeletion.body.members).toStrictEqual([
      expect.objectContaining({
        userId: actor.userId,
        inputTokens: 130,
        outputTokens: 40,
        creditsCharged: 170,
      }),
    ]);
  });
});
