import { randomUUID } from "node:crypto";

import {
  triggerSourceSchema,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import {
  type UsageInsightBucket,
  zeroUsageInsightContract,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  ensureUsagePricingRow,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

/*
 * Finalized usage is filtered and bucketed by settlement time. Database
 * insertion time remains independent from the application clock used by
 * inline managed settlement and the pending-usage processing endpoint.
 */
const context = testContext();
const mocks = createZeroRouteMocks(context);
const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const HOUR_MS = 3_600_000;

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageInsightContract);
}

function sumBucketSeries(
  buckets: readonly UsageInsightBucket[],
): Record<string, { credits: number; tokens: number }> {
  const totals: Record<string, { credits: number; tokens: number }> = {};
  for (const bucket of buckets) {
    for (const [key, credits] of Object.entries(bucket.series)) {
      const current = totals[key] ?? { credits: 0, tokens: 0 };
      current.credits += credits;
      current.tokens += bucket.tokens[key] ?? 0;
      totals[key] = current;
    }
  }
  return totals;
}

async function entitledInsightActor(): Promise<ApiTestUser> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  return actor;
}

/**
 * Creates a compose with an inline model key. Direct runs launched from it
 * carry no managed model provider, so the sandbox usage webhook accepts
 * model-kind billing events for them (vm0-billed model usage).
 */
async function createInsightCompose(
  actor: ApiTestUser,
  name = `usage-insight-${randomUUID().slice(0, 8)}`,
): Promise<{ readonly composeId: string; readonly name: string }> {
  const api = createRunsApi(context);
  return await api.createCompose(actor, {
    version: "1",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      },
    },
  });
}

async function createSourceRun(
  actor: ApiTestUser,
  composeId: string,
  triggerSource: TriggerSource,
): Promise<string> {
  const api = createRunsApi(context);
  const run = await api.createDirectRun(actor, {
    agentComposeId: composeId,
    prompt: "generate usage insight activity",
    triggerSource,
  });
  // Free the org's concurrent-run slot; usage attribution only needs the
  // run row and its trigger source, not a live run.
  await api.requestCancelRun(actor, run.runId, [200]);
  return run.runId;
}

interface UsageEventSpec {
  readonly kind: "connector" | "model";
  readonly category: string;
  readonly quantity: number;
  readonly credits: number;
}

/**
 * Reports usage events against the run through the sandbox webhook. Each
 * event gets a dedicated pricing row (unique provider) sized so the charge
 * equals `credits` exactly once pending events are processed.
 */
async function reportRunUsage(
  actor: ApiTestUser,
  runId: string,
  specs: readonly UsageEventSpec[],
): Promise<void> {
  const api = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const events = specs.map((spec) => {
    return {
      idempotencyKey: randomUUID(),
      kind: spec.kind,
      provider: `bdd-ui-${randomUUID().slice(0, 8)}`,
      category: spec.category,
      quantity: spec.quantity,
    };
  });
  await seedUsagePricingRows(
    events.map((event, index) => {
      const spec = specs[index];
      if (!spec) {
        throw new Error("Usage event spec missing");
      }
      return {
        kind: event.kind,
        provider: event.provider,
        category: event.category,
        unitPrice: spec.credits,
        unitSize: Math.max(spec.quantity, 1),
      };
    }),
  );
  await webhooks.requestAgentUsageEvent(
    { runId, events },
    { authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}` },
    [200],
  );
}

async function processPendingUsage(actor: ApiTestUser): Promise<void> {
  const billing = createBillingMediaApi(context);
  await billing.processOrgUsageEvents(actor);
}

/**
 * Records runless usage through the Zero Maps geocode product route (billed
 * without a run and settled inline). Returns the exact credits charged.
 */
async function recordRunlessUsage(actor: ApiTestUser): Promise<number> {
  const billing = createBillingMediaApi(context);
  billing.configureMapsProvider();
  await ensureUsagePricingRow({
    kind: "maps",
    provider: "google-maps",
    category: "geocoding",
    unitPrice: 6,
    unitSize: 1,
  });
  server.use(
    http.get(GOOGLE_GEOCODING_URL, () => {
      return HttpResponse.json({
        status: "OK",
        results: [
          {
            formatted_address: "1 Infinite Loop, Cupertino, CA",
            geometry: { location: { lat: 37.3317, lng: -122.0301 } },
          },
        ],
      });
    }),
  );
  const geocode = await billing.requestMapsGeocode(
    actor,
    { address: "1 Infinite Loop, Cupertino" },
    [200],
  );
  if (geocode.status !== 200) {
    throw new Error("Expected the geocode call to succeed");
  }
  const { creditsCharged } = geocode.body;
  if (typeof creditsCharged !== "number") {
    throw new Error("Expected the geocode response to report creditsCharged");
  }
  return creditsCharged;
}

function authenticateInsightActor(actor: ApiTestUser): void {
  mocks.clerk.session(actor.userId, actor.orgId);
}

describe("GET /api/zero/usage/insight", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid timezone", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "Not/A/Timezone" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("accepts timezone aliases supported by Intl.DateTimeFormat", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "US/Pacific" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(Array.isArray(response.body.buckets)).toBeTruthy();
  });

  it("returns 400 when range=day is missing a date", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { range: "day", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("happy path — shape and totals add up for range=7d groupBy=source tz=UTC", async () => {
    const actor = await entitledInsightActor();
    const compose = await createInsightCompose(actor);
    const runId = await createSourceRun(actor, compose.composeId, "web");
    await reportRunUsage(actor, runId, [
      { kind: "model", category: "tokens.input", quantity: 1000, credits: 100 },
      { kind: "model", category: "tokens.output", quantity: 500, credits: 0 },
    ]);
    await processPendingUsage(actor);
    authenticateInsightActor(actor);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(Array.isArray(response.body.buckets)).toBeTruthy();
    expect(Array.isArray(response.body.automations)).toBeTruthy();
    expect(Array.isArray(response.body.chats)).toBeTruthy();
    expect(typeof response.body.grandTotalCredits).toBe("number");
    expect(typeof response.body.grandTotalTokens).toBe("number");
    expect(response.body.grandTotalCredits).toBeGreaterThanOrEqual(100);

    const bucketSum = response.body.buckets.reduce((sum, bucket) => {
      const seriesSum = Object.values(bucket.series).reduce((s, v) => {
        return s + v;
      }, 0);
      return sum + seriesSum;
    }, 0);
    expect(bucketSum).toBeLessThanOrEqual(response.body.grandTotalCredits + 1);
  });

  it("source mapping — every TriggerSource lands in the correct bucket", async () => {
    const actor = await entitledInsightActor();
    const compose = await createInsightCompose(actor);

    for (const source of triggerSourceSchema.options) {
      const runId = await createSourceRun(actor, compose.composeId, source);
      await reportRunUsage(actor, runId, [
        { kind: "connector", category: "call", quantity: 1, credits: 50 },
      ]);
    }
    await processPendingUsage(actor);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    const totalByBucket: Record<string, number> = {};
    for (const bucket of response.body.buckets) {
      for (const [key, val] of Object.entries(bucket.series)) {
        totalByBucket[key] = (totalByBucket[key] ?? 0) + val;
      }
    }

    expect(totalByBucket["chat"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["slack"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["email"]).toBeGreaterThanOrEqual(50);
    expect(totalByBucket["automation"]).toBeGreaterThanOrEqual(100);
    expect(totalByBucket["others"]).toBeGreaterThanOrEqual(250);
  });

  it("groupBy=agent with 9 agents produces top-7 + others series keys", async () => {
    const actor = await entitledInsightActor();

    for (let i = 1; i <= 9; i++) {
      const compose = await createInsightCompose(
        actor,
        `agent-${i}-${randomUUID().slice(0, 8)}`,
      );
      const runId = await createSourceRun(actor, compose.composeId, "cli");
      await reportRunUsage(actor, runId, [
        {
          kind: "connector",
          category: "call",
          quantity: 1,
          credits: i * 100,
        },
      ]);
    }
    await processPendingUsage(actor);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "agent", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    const seriesKeys = new Set<string>();
    for (const bucket of response.body.buckets) {
      for (const key of Object.keys(bucket.series)) {
        seriesKeys.add(key);
      }
    }
    expect(seriesKeys.size).toBeLessThanOrEqual(8);
    expect(seriesKeys.has("others")).toBeTruthy();
  });

  it("today produces hourly bucket strings", async () => {
    const actor = await entitledInsightActor();
    const compose = await createInsightCompose(actor);
    const runId = await createSourceRun(actor, compose.composeId, "cli");
    await reportRunUsage(actor, runId, [
      { kind: "connector", category: "call", quantity: 1, credits: 10 },
    ]);
    await processPendingUsage(actor);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "today", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.buckets.length).toBeGreaterThanOrEqual(1);
    for (const bucket of response.body.buckets) {
      expect(bucket.ts).toMatch(/:00:00/);
    }
  });

  it("day window returns the selected calendar day with hourly buckets", async () => {
    const actor = await entitledInsightActor();
    const compose = await createInsightCompose(actor);
    const runId = await createSourceRun(actor, compose.composeId, "cli");
    await reportRunUsage(actor, runId, [
      { kind: "connector", category: "call", quantity: 1, credits: 42 },
    ]);
    await processPendingUsage(actor);
    const selectedDate = nowDate().toISOString().split("T")[0];
    expect(selectedDate).toBeDefined();

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: {
          range: "day",
          date: selectedDate,
          groupBy: "source",
          tz: "UTC",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.grandTotalCredits).toBe(42);
    const bucket = response.body.buckets.find((b) => {
      return Object.values(b.series).some((v) => {
        return v === 42;
      });
    });
    expect(bucket).toBeDefined();
    expect(bucket?.ts).toContain(selectedDate);
    expect(bucket?.ts).toMatch(/:00:00/);
  });

  it("uses settlement time for range membership and hourly buckets", async () => {
    const actor = await entitledInsightActor();
    const settledAt = new Date(nowDate().getTime() + 25 * HOUR_MS);
    mockNow(settledAt);
    const credits = await recordRunlessUsage(actor);
    clearMockNow();
    authenticateInsightActor(actor);

    const currentRange = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(currentRange.body.grandTotalCredits).toBe(0);
    expect(currentRange.body.buckets).toStrictEqual([]);

    const processedDate = settledAt.toISOString().slice(0, 10);
    const processedRange = await accept(
      apiClient().get({
        query: {
          range: "day",
          date: processedDate,
          groupBy: "source",
          tz: "UTC",
        },
        headers: authHeaders(),
      }),
      [200],
    );
    const processedHour = new Date(settledAt);
    processedHour.setUTCMinutes(0, 0, 0);

    expect(processedRange.body.grandTotalCredits).toBe(credits);
    expect(processedRange.body.buckets).toStrictEqual([
      {
        ts: processedHour.toISOString(),
        series: { others: credits },
        tokens: { others: 0 },
      },
    ]);
  });

  it("scope isolation — other user's activity in same org is invisible", async () => {
    const bdd = createBddApi(context);
    const actor = await entitledInsightActor();
    const otherUser = bdd.user({ orgId: actor.orgId });

    const compose = await createInsightCompose(actor);
    const myRunId = await createSourceRun(actor, compose.composeId, "web");
    await reportRunUsage(actor, myRunId, [
      { kind: "model", category: "tokens.input", quantity: 100, credits: 100 },
    ]);

    const otherCompose = await createInsightCompose(
      otherUser,
      `other-compose-${randomUUID().slice(0, 8)}`,
    );
    const otherRunId = await createSourceRun(
      otherUser,
      otherCompose.composeId,
      "web",
    );
    await reportRunUsage(otherUser, otherRunId, [
      { kind: "model", category: "tokens.input", quantity: 999, credits: 999 },
      { kind: "connector", category: "tweet.read", quantity: 1, credits: 999 },
    ]);
    await processPendingUsage(actor);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.grandTotalCredits).toBe(100);
  });

  it("includes usage_event rows in grand totals and source buckets", async () => {
    const actor = await entitledInsightActor();
    const compose = await createInsightCompose(actor);
    const runId = await createSourceRun(actor, compose.composeId, "web");

    const runlessCredits = await recordRunlessUsage(actor);
    await reportRunUsage(actor, runId, [
      { kind: "model", category: "tokens.input", quantity: 100, credits: 10 },
      { kind: "model", category: "tokens.output", quantity: 50, credits: 0 },
      { kind: "model", category: "tokens.input", quantity: 30, credits: 3 },
      { kind: "model", category: "tokens.output", quantity: 20, credits: 2 },
      { kind: "model", category: "tokens.cache_read", quantity: 5, credits: 1 },
      {
        kind: "model",
        category: "tokens.cache_creation",
        quantity: 10,
        credits: 4,
      },
    ]);
    await processPendingUsage(actor);
    // Reported after processing and never settled: pending rows must stay
    // out of every total.
    await reportRunUsage(actor, runId, [
      { kind: "model", category: "tokens.input", quantity: 999, credits: 999 },
    ]);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    const totals = sumBucketSeries(response.body.buckets);

    expect(response.body.grandTotalCredits).toBe(20 + runlessCredits);
    expect(response.body.grandTotalTokens).toBe(215);
    expect(totals["chat"]).toStrictEqual({ credits: 20, tokens: 215 });
    expect(totals["others"]).toStrictEqual({
      credits: runlessCredits,
      tokens: 0,
    });
  });

  it("includes run-linked usage_event rows in agent buckets and channel totals", async () => {
    const actor = await entitledInsightActor();
    const agentName = `usage-event-agent-${randomUUID().slice(0, 8)}`;
    const compose = await createInsightCompose(actor, agentName);
    const runId = await createSourceRun(actor, compose.composeId, "slack");

    const runlessCredits = await recordRunlessUsage(actor);
    await reportRunUsage(actor, runId, [
      { kind: "connector", category: "tweet.read", quantity: 1, credits: 40 },
      { kind: "model", category: "tokens.output", quantity: 15, credits: 5 },
    ]);
    await processPendingUsage(actor);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "agent", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );
    const totals = sumBucketSeries(response.body.buckets);

    expect(totals[agentName]).toStrictEqual({ credits: 45, tokens: 15 });
    expect(totals["others"]).toStrictEqual({
      credits: runlessCredits,
      tokens: 0,
    });
    expect(response.body.slackCredits).toBe(45);
    expect(response.body.slackTokens).toBe(15);
  });

  it("returns chat rows when groupBy=source and there are chat runs", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const actor = await entitledInsightActor();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Usage insight chat agent",
      visibility: "private",
    });
    const thread = await chat.createThread(actor, {
      agentId: agent.agentId,
      title: "Test Chat Thread",
    });
    const sent = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "generate chat usage",
        threadId: thread.id,
        model: "claude-sonnet-4-6",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the chat send to create a run");
    }

    // Chat runs bill through a managed model provider, so model-kind events
    // are not accepted for them — the chat row aggregates connector credits
    // and reports zero tokens here.
    await reportRunUsage(actor, sent.body.runId, [
      { kind: "connector", category: "call", quantity: 1, credits: 225 },
    ]);
    await processPendingUsage(actor);

    authenticateInsightActor(actor);
    const response = await accept(
      apiClient().get({
        query: { range: "7d", groupBy: "source", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.chats.length).toBeGreaterThanOrEqual(1);
    const chatRow = response.body.chats.find((c) => {
      return c.threadId === thread.id;
    });
    expect(chatRow).toBeDefined();
    expect(chatRow?.threadTitle).toBe("Test Chat Thread");
    expect(chatRow?.credits).toBe(225);
    expect(chatRow?.tokens).toBe(0);
  });
});
