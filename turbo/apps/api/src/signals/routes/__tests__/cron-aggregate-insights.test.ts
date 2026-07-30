import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { cronAggregateInsightsContract } from "@vm0/api-contracts/contracts/cron";
import type { DayInsight } from "@vm0/api-contracts/contracts/zero-insights";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  ensureUsagePricingRow,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  insertUsageEvent$,
  materializeHourlyUsage$,
  readInsightsDailyPermissions$,
} from "./helpers/zero-usage-insight";

/**
 * The aggregation cron sweeps all activity within a 25h lookback of "now".
 * Every test pins time to a far-future day so that concurrently running test
 * files (whose runs and usage events live at real wall-clock time) never fall
 * inside this file's aggregation window, and vice versa.
 */
const context = testContext();
const store = createStore();
const FIXED_NOW_ISO = "2999-01-02T12:00:00.000Z";
const TODAY = "2999-01-02";
const ACTIVITY_AT_ISO = "2999-01-02T11:55:00.000Z";
const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";

function activityAt(): Date {
  return new Date(ACTIVITY_AT_ISO);
}

function previousDayCreatedAt(): Date {
  return new Date("2999-01-01T10:00:00.000Z");
}

function previousDayCompletedAt(): Date {
  return new Date("2999-01-01T10:01:00.000Z");
}

function apiClient() {
  return setupApp({ context })(cronAggregateInsightsContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/cron/aggregate-insights", {
    method: "GET",
    headers,
  });
}

interface InsightActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
}

async function seedInsightActor(displayName?: string): Promise<InsightActor> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: displayName ?? "Insights agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

async function createAgentFor(
  actor: ApiTestUser,
  displayName: string,
): Promise<string> {
  const bdd = createBddApi(context);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "private",
  });
  return agent.agentId;
}

function sandboxHeaders(actor: ApiTestUser, runId: string) {
  const api = createRunsApi(context);
  return { authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}` };
}

/**
 * Reports a connector usage event against the run through the sandbox
 * webhook. A dedicated pricing row (unique provider) makes the charge equal
 * `credits` exactly once the org's pending events are settled.
 */
async function reportRunCredits(
  actor: ApiTestUser,
  runId: string,
  credits: number,
): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  const provider = `bdd-insights-${randomUUID().slice(0, 8)}`;
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider,
      category: "call",
      unitPrice: credits,
      unitSize: 1,
    },
  ]);
  await webhooks.requestAgentUsageEvent(
    {
      runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "connector",
          provider,
          category: "call",
          quantity: 1,
        },
      ],
    },
    sandboxHeaders(actor, runId),
    [200],
  );
}

/**
 * Completes the run through the sandbox complete webhook at the given time.
 * Completion also settles the org's pending usage events (production's
 * billing trigger), so previously reported events get `processedAt` equal to
 * `completedAt`. Uses the failed-completion path (exit code 1) because a
 * successful completion requires a full checkpoint flow; insights count runs
 * by `completedAt` regardless of terminal status.
 */
async function completeRunAt(
  actor: ApiTestUser,
  runId: string,
  completedAt: Date,
): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  mockNow(completedAt);
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 1,
      error: "bdd insights run finished",
      lastEventSequence: 0,
    },
    sandboxHeaders(actor, runId),
    [200],
  );
}

async function createRunFor(
  actor: ApiTestUser,
  agentId: string,
): Promise<string> {
  const api = createRunsApi(context);
  const run = await api.createRun(actor, {
    agentId,
    prompt: "generate insight activity",
    modelProvider: "anthropic-api-key",
  });
  return run.runId;
}

/**
 * Seeds a run that completes at `completedAt`, optionally charging `credits`
 * against it. The charge is reported only after completion so the event's
 * pending window stays minimal — a concurrently running test file's global
 * usage sweep would otherwise settle it at real wall-clock time, outside
 * this file's pinned aggregation day. Callers that charge credits must
 * settle promptly (e.g. via `recordRunlessUsageAt`).
 */
async function seedCompletedRun(
  seeded: InsightActor,
  args: { readonly credits?: number; readonly completedAt?: Date } = {},
): Promise<string> {
  const runId = await createRunFor(seeded.actor, seeded.agentId);
  await completeRunAt(seeded.actor, runId, args.completedAt ?? activityAt());
  if (args.credits !== undefined) {
    await reportRunCredits(seeded.actor, runId, args.credits);
  }
  return runId;
}

function mockGeocodeProvider(): void {
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
}

/**
 * Records runless "Other usage" through the Zero Maps geocode product route
 * at the given time. The route bills a runless usage event and settles the
 * org's pending events inline. Returns the exact credits charged as reported
 * by the product response.
 */
async function recordRunlessUsageAt(
  actor: ApiTestUser,
  processedAt: Date,
): Promise<number> {
  const billing = createBillingMediaApi(context);
  billing.configureMapsProvider();
  await ensureUsagePricingRow({
    kind: "maps",
    provider: "google-maps",
    category: "geocoding",
    unitPrice: 6,
    unitSize: 1,
  });
  mockGeocodeProvider();
  mockNow(processedAt);
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

interface ClerkProfileSpec {
  readonly userId: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly username?: string | null;
}

/**
 * The aggregation resolves member names through Clerk's getUserList and
 * writes them to the user cache — this installs the Clerk side of that
 * production path for the given users.
 */
function mockClerkUserProfiles(profiles: readonly ClerkProfileSpec[]): void {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    const requested =
      typeof args === "object" &&
      args !== null &&
      "userId" in args &&
      Array.isArray(args.userId)
        ? (args.userId as readonly string[])
        : [];
    return Promise.resolve({
      data: profiles
        .filter((profile) => {
          return requested.includes(profile.userId);
        })
        .map((profile) => {
          const emailId = `email_${profile.userId}`;
          return {
            id: profile.userId,
            emailAddresses: [{ id: emailId, emailAddress: profile.email }],
            primaryEmailAddressId: emailId,
            firstName: profile.firstName,
            username: profile.username ?? null,
            imageUrl: null,
          };
        }),
    });
  });
}

/**
 * Installs org membership answers for the cron's current-member filter.
 * Orgs not listed report no members (they were touched by earlier tests in
 * this file and are skipped by the aggregation watermark anyway).
 */
function mockClerkOrgMembers(
  membersByOrg: Readonly<Record<string, readonly string[]>>,
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const input = args as {
        readonly organizationId?: string;
        readonly limit?: number;
        readonly offset?: number;
      };
      const members = membersByOrg[input.organizationId ?? ""] ?? [];
      const offset = input.offset ?? 0;
      const limit = input.limit ?? members.length;
      return Promise.resolve({
        data: members.slice(offset, offset + limit).map((userId) => {
          return { publicUserData: { userId } };
        }),
      });
    },
  );
}

function defaultClerkMocksFor(seeded: InsightActor): void {
  if (!seeded.actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  mockClerkOrgMembers({ [seeded.actor.orgId]: [seeded.actor.userId] });
  mockClerkUserProfiles([
    {
      userId: seeded.actor.userId,
      email: "test@example.com",
      firstName: "Test User",
    },
  ]);
}

async function runAggregation() {
  return await accept(apiClient().aggregate({ headers: cronHeaders() }), [200]);
}

/** Reads the actor's aggregated day through GET /api/zero/insights. */
async function findInsights(actor: ApiTestUser): Promise<DayInsight | null> {
  const billing = createBillingMediaApi(context);
  const insights = await billing.readInsights(actor);
  return (
    insights.days.find((day) => {
      return day.date === TODAY;
    }) ?? null
  );
}

async function readCreditBalance(actor: ApiTestUser): Promise<number> {
  const billing = createBillingMediaApi(context);
  const status = await billing.readBillingStatus(actor);
  return status.credits;
}

describe("GET /api/cron/aggregate-insights", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
    context.mocks.axiom.query.mockResolvedValue([]);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().aggregate({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with a missing authorization header", async () => {
    const response = await rawCronRequest();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  // The "skipped when idle" branch is not assertable against the shared
  // test database: any concurrent or previously interrupted test run leaves
  // pinned-day activity that keeps the global sweep busy. Global `users`
  // counts are likewise omitted from body assertions below for that reason.

  it("aggregates completed runs, processed credits, and network services", async () => {
    const seeded = await seedInsightActor();
    const runId = await seedCompletedRun(seeded, { credits: 500 });
    // The completion webhook's billing settlement runs in a background
    // envelope; a runless maps call settles the org's pending events
    // deterministically (and adds its own "Other usage" credits).
    const runlessCredits = await recordRunlessUsageAt(
      seeded.actor,
      activityAt(),
    );
    const creditBalance = await readCreditBalance(seeded.actor);
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.slack.com",
        firewall_name: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
    ]);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    const response = await runAggregation();

    expect(response.body).toMatchObject({
      windows: 1,
      networkRows: 1,
    });
    const data = await findInsights(seeded.actor);
    expect(data).toMatchObject({
      creditsUsed: 500 + runlessCredits,
      creditBalance,
    });
    const runAgent = data?.agents.find((agent) => {
      return agent.agentId !== null;
    });
    expect(runAgent).toMatchObject({ runs: 1, credits: 500 });
    expect(data?.teamUsage).toMatchObject([
      { name: "Test User", credits: 500 + runlessCredits },
    ]);
    expect(data?.services).toMatchObject([{ domain: "slack", calls: 1 }]);
    expect(data?.automations).toStrictEqual([]);
  });

  it("counts processed credits for an earlier run on the current aggregation day", async () => {
    const seeded = await seedInsightActor();
    mockNow(previousDayCreatedAt());
    const runId = await createRunFor(seeded.actor, seeded.agentId);
    await completeRunAt(seeded.actor, runId, previousDayCompletedAt());
    // The charge arrives after the run completed and is settled on the
    // current day by the org's next billing trigger (a runless maps call).
    await reportRunCredits(seeded.actor, runId, 600);
    const runlessCredits = await recordRunlessUsageAt(
      seeded.actor,
      activityAt(),
    );
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    const response = await runAggregation();

    expect(response.body).toMatchObject({
      windows: 1,
      networkRows: 0,
    });
    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(600 + runlessCredits);
    const runAgent = data?.agents.find((agent) => {
      return agent.agentId !== null;
    });
    expect(runAgent).toMatchObject({ runs: 0, credits: 600 });
    const otherUsage = data?.agents.find((agent) => {
      return agent.agentId === null;
    });
    expect(otherUsage).toMatchObject({
      agentName: "Other usage",
      credits: runlessCredits,
    });
  });

  it("counts runs by completedAt when the run was created earlier", async () => {
    const seeded = await seedInsightActor();
    mockNow(previousDayCreatedAt());
    const runId = await createRunFor(seeded.actor, seeded.agentId);
    await completeRunAt(seeded.actor, runId, activityAt());
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.agents).toMatchObject([{ runs: 1, credits: 0 }]);
  });

  it("includes runless usage events as other usage", async () => {
    const seeded = await seedInsightActor();
    const runlessCredits = await recordRunlessUsageAt(
      seeded.actor,
      activityAt(),
    );
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(runlessCredits);
    expect(data?.agents).toStrictEqual([
      {
        agentId: null,
        agentName: "Other usage",
        runs: 0,
        credits: runlessCredits,
      },
    ]);
    expect(data?.teamUsage).toHaveLength(1);
    expect(data?.teamUsage[0]).toMatchObject({
      name: "Test User",
      credits: runlessCredits,
      agentNames: ["Other usage"],
      agentCredits: { "Other usage": runlessCredits },
    });
  });

  it("aggregates run-linked and runless usage from hourly storage", async () => {
    const seeded = await seedInsightActor();
    if (!seeded.actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const runId = await seedCompletedRun(seeded);
    await store.set(
      insertUsageEvent$,
      {
        orgId: seeded.actor.orgId,
        userId: seeded.actor.userId,
        runId,
        kind: "connector",
        provider: "hourly-fixture",
        category: "call",
        quantity: 3,
        status: "processed",
        creditsCharged: 725,
        processedAt: activityAt(),
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: seeded.actor.orgId,
        userId: seeded.actor.userId,
        runId: null,
        kind: "maps",
        provider: "hourly-runless-fixture",
        category: "geocoding",
        quantity: 1,
        status: "processed",
        creditsCharged: 125,
        processedAt: activityAt(),
      },
      context.signal,
    );
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: seeded.actor.orgId,
          userId: seeded.actor.userId,
          runId,
        },
        context.signal,
      ),
    ).resolves.toBe(1);
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: seeded.actor.orgId,
          userId: seeded.actor.userId,
          runId: null,
        },
        context.signal,
      ),
    ).resolves.toBe(1);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(850);
    expect(data?.agents).toMatchObject([
      { runs: 1, credits: 725 },
      {
        agentId: null,
        agentName: "Other usage",
        runs: 0,
        credits: 125,
      },
    ]);
    expect(data?.teamUsage).toMatchObject([
      { name: "Test User", credits: 850 },
    ]);
  });

  it("excludes removed org members from team credit usage", async () => {
    const bdd = createBddApi(context);
    const seeded = await seedInsightActor();
    if (!seeded.actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    // The removed member generated real usage in the org before losing
    // membership; Clerk (mocked below) no longer lists them.
    const removed = bdd.user({
      orgId: seeded.actor.orgId,
      orgRole: "org:member",
    });
    const activeCredits = await recordRunlessUsageAt(
      seeded.actor,
      activityAt(),
    );
    const removedCredits = await recordRunlessUsageAt(removed, activityAt());
    expect(removedCredits).toBeGreaterThan(0);
    mockNow(new Date(FIXED_NOW_ISO));
    mockClerkOrgMembers({ [seeded.actor.orgId]: [seeded.actor.userId] });
    mockClerkUserProfiles([
      {
        userId: seeded.actor.userId,
        email: "active@example.com",
        firstName: "Active Member",
      },
      {
        userId: removed.userId,
        email: "removed@example.com",
        firstName: "Removed Member",
      },
    ]);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(activeCredits);
    expect(data?.teamUsage).toStrictEqual([
      {
        name: "Active Member",
        credits: activeCredits,
        agentNames: ["Other usage"],
        agentCredits: { "Other usage": activeCredits },
      },
    ]);
  });

  it("reprocesses new activity in the watermark hour", async () => {
    const seeded = await seedInsightActor();
    if (!seeded.actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    await store.set(
      insertUsageEvent$,
      {
        orgId: seeded.actor.orgId,
        userId: seeded.actor.userId,
        runId: null,
        status: "processed",
        creditsCharged: 300,
        processedAt: activityAt(),
      },
      context.signal,
    );
    mockNow(new Date("2999-01-02T12:30:00.000Z"));
    defaultClerkMocksFor(seeded);
    await runAggregation();
    const firstPass = await findInsights(seeded.actor);
    expect(firstPass?.creditsUsed).toBe(300);

    await store.set(
      insertUsageEvent$,
      {
        orgId: seeded.actor.orgId,
        userId: seeded.actor.userId,
        runId: null,
        status: "processed",
        creditsCharged: 100,
        processedAt: new Date("2999-01-02T12:40:00.000Z"),
      },
      context.signal,
    );
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: seeded.actor.orgId,
          userId: seeded.actor.userId,
          runId: null,
        },
        context.signal,
      ),
    ).resolves.toBe(2);
    mockNow(new Date("2999-01-02T12:50:00.000Z"));
    defaultClerkMocksFor(seeded);

    const secondPass = await runAggregation();
    expect(secondPass.body).toMatchObject({
      windows: 1,
    });

    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(400);
  });

  it("reprocesses activity at the previous aggregation watermark", async () => {
    const seeded = await seedInsightActor();
    await seedCompletedRun(seeded, { credits: 300 });
    const settleCredits = await recordRunlessUsageAt(
      seeded.actor,
      activityAt(),
    );
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);
    await runAggregation();
    const firstPass = await findInsights(seeded.actor);
    expect(firstPass?.creditsUsed).toBe(300 + settleCredits);

    const lateActivityAt = new Date("2999-01-02T23:56:00.000Z");
    const runlessCredits = await recordRunlessUsageAt(
      seeded.actor,
      lateActivityAt,
    );
    mockNow(new Date("2999-01-02T23:57:00.000Z"));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(300 + settleCredits + runlessCredits);
  });

  it("keeps agents with the same display name separate", async () => {
    const seeded = await seedInsightActor("Shared display");
    const secondAgentId = await createAgentFor(seeded.actor, "Shared display");
    const firstRunId = await createRunFor(seeded.actor, seeded.agentId);
    const secondRunId = await createRunFor(seeded.actor, secondAgentId);
    await completeRunAt(seeded.actor, firstRunId, activityAt());
    await completeRunAt(seeded.actor, secondRunId, activityAt());
    await reportRunCredits(seeded.actor, firstRunId, 100);
    await reportRunCredits(seeded.actor, secondRunId, 200);
    await recordRunlessUsageAt(seeded.actor, activityAt());
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    const runAgents = data?.agents.filter((agent) => {
      return agent.agentId !== null;
    });
    expect(runAgents).toHaveLength(2);
    expect(
      runAgents?.map((agent) => {
        return agent.agentName;
      }),
    ).toStrictEqual(["Shared display", "Shared display"]);
    expect(
      new Set(
        runAgents?.map((agent) => {
          return agent.agentId;
        }),
      ).size,
    ).toBe(2);
    expect(
      runAgents?.map((agent) => {
        return agent.runs;
      }),
    ).toStrictEqual([1, 1]);
    expect(
      runAgents
        ?.map((agent) => {
          return agent.credits;
        })
        .sort((a, b) => {
          return a - b;
        }),
    ).toStrictEqual([100, 200]);
  });

  it("records denied requests with empty firewall permission", async () => {
    const seeded = await seedInsightActor();
    const runId = await seedCompletedRun(seeded);
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
    ]);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    if (!seeded.actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const storedPermissions = await store.set(
      readInsightsDailyPermissions$,
      {
        orgId: seeded.actor.orgId,
        userId: seeded.actor.userId,
        date: TODAY,
      },
      context.signal,
    );
    expect(storedPermissions).toHaveLength(2);
    expect(storedPermissions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorSlug: "github",
          denied: 2,
        }),
        expect.objectContaining({
          connectorSlug: "github",
          allowed: 1,
        }),
      ]),
    );
    for (const permission of storedPermissions) {
      expect(permission).not.toHaveProperty("connectorType");
    }

    const data = await findInsights(seeded.actor);
    const githubDeny = data?.permissions.find((permission) => {
      return permission.label === "github" && permission.denied > 0;
    });
    expect(githubDeny).toMatchObject({
      connectorSlug: "github",
      connectorType: "github",
      denied: 2,
    });
    const repoRead = data?.permissions.find((permission) => {
      return permission.label.includes("repo-read");
    });
    expect(repoRead).toMatchObject({
      connectorSlug: "github",
      connectorType: "github",
      allowed: 1,
    });
  });

  it("skips malformed network insight rows without failing aggregation", async () => {
    const seeded = await seedInsightActor();
    const runId = await seedCompletedRun(seeded);
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
      "malformed-row",
      {
        _time: ACTIVITY_AT_ISO,
        runId: "not-a-uuid",
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: 123,
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "UNKNOWN",
      },
    ]);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    const response = await runAggregation();

    expect(response.body).toMatchObject({
      windows: 1,
      networkRows: 5,
    });
    const data = await findInsights(seeded.actor);
    expect(data?.services).toStrictEqual([
      { domain: "github", calls: 1, agentNames: [expect.any(String)] },
    ]);
    const repoRead = data?.permissions.find((permission) => {
      return permission.label.includes("repo-read");
    });
    expect(repoRead).toMatchObject({
      connectorSlug: "github",
      connectorType: "github",
      allowed: 1,
      denied: 0,
    });
  });

  it("handles missing permissions and excludes block actions from permission insights", async () => {
    const seeded = await seedInsightActor();
    const runId = await seedCompletedRun(seeded);
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        action: "DENY",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: null,
        action: "DENY",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "DENY",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        action: "ALLOW",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: null,
        action: "ALLOW",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "",
        action: "ALLOW",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-write",
        action: "BLOCK",
      },
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.github.com",
        firewall_name: "github",
        firewall_permission: "repo-read",
        action: "ALLOW",
      },
    ]);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    const response = await runAggregation();

    expect(response.body).toMatchObject({
      windows: 1,
      networkRows: 8,
    });
    const data = await findInsights(seeded.actor);
    expect(data?.services).toStrictEqual([
      { domain: "github", calls: 8, agentNames: [expect.any(String)] },
    ]);
    const githubDeny = data?.permissions.find((permission) => {
      return permission.label === "github";
    });
    expect(githubDeny).toMatchObject({
      connectorSlug: "github",
      connectorType: "github",
      allowed: 0,
      denied: 3,
    });
    const repoRead = data?.permissions.find((permission) => {
      return permission.label.includes("repo-read");
    });
    expect(repoRead).toMatchObject({
      connectorSlug: "github",
      connectorType: "github",
      allowed: 1,
      denied: 0,
    });
    expect(
      data?.permissions.some((permission) => {
        return permission.label.includes("repo-write");
      }),
    ).toBeFalsy();
  });

  it("attributes current-day network logs for older runs by runId", async () => {
    const seeded = await seedInsightActor();
    mockNow(previousDayCreatedAt());
    const runId = await createRunFor(seeded.actor, seeded.agentId);
    await completeRunAt(seeded.actor, runId, previousDayCompletedAt());
    await reportRunCredits(seeded.actor, runId, 25);
    const runlessCredits = await recordRunlessUsageAt(
      seeded.actor,
      activityAt(),
    );
    context.mocks.axiom.query.mockResolvedValue([
      {
        _time: ACTIVITY_AT_ISO,
        runId,
        host: "api.slack.com",
        firewall_name: "slack",
        firewall_permission: "send_message",
        action: "ALLOW",
      },
    ]);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.creditsUsed).toBe(25 + runlessCredits);
    const runAgent = data?.agents.find((agent) => {
      return agent.agentId !== null;
    });
    expect(runAgent).toMatchObject({ runs: 0, credits: 25 });
    expect(data?.services).toStrictEqual([
      { domain: "slack", calls: 1, agentNames: [expect.any(String)] },
    ]);
  });

  it("uses clerk user names and falls back to email prefix when the name is null", async () => {
    const alice = await seedInsightActor();
    const bob = await seedInsightActor();
    if (!alice.actor.orgId || !bob.actor.orgId) {
      throw new Error("Expected org-scoped actors");
    }
    const aliceCredits = await recordRunlessUsageAt(alice.actor, activityAt());
    const bobCredits = await recordRunlessUsageAt(bob.actor, activityAt());
    mockNow(new Date(FIXED_NOW_ISO));
    mockClerkOrgMembers({
      [alice.actor.orgId]: [alice.actor.userId],
      [bob.actor.orgId]: [bob.actor.userId],
    });
    mockClerkUserProfiles([
      {
        userId: alice.actor.userId,
        email: "alice@example.com",
        firstName: "Alice",
      },
      {
        userId: bob.actor.userId,
        email: "bob@example.com",
        firstName: null,
        username: null,
      },
    ]);

    await runAggregation();

    const aliceData = await findInsights(alice.actor);
    const bobData = await findInsights(bob.actor);
    expect(aliceData?.teamUsage).toMatchObject([
      { name: "Alice", credits: aliceCredits },
    ]);
    expect(bobData?.teamUsage).toMatchObject([
      { name: "bob", credits: bobCredits },
    ]);
  });

  it("is idempotent on rerun", async () => {
    const seeded = await seedInsightActor();
    await seedCompletedRun(seeded);
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    await runAggregation();
    const firstPass = await findInsights(seeded.actor);
    await runAggregation();

    const data = await findInsights(seeded.actor);
    expect(data?.agents).toMatchObject([{ runs: 1 }]);
    expect(data).toStrictEqual(firstPass);
  });

  // The stored axiomDegraded flag is not exposed through the insights read
  // API; degradation is asserted through its product-visible consequences:
  // zero network rows in the cron summary and an insight day without
  // services, while run aggregation still succeeds.
  it("still aggregates runs when the Axiom query fails", async () => {
    const seeded = await seedInsightActor();
    await seedCompletedRun(seeded);
    context.mocks.axiom.query.mockRejectedValue(new Error("axiom down"));
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    const response = await runAggregation();

    expect(response.body).toMatchObject({ networkRows: 0 });
    const data = await findInsights(seeded.actor);
    expect(data?.agents).toMatchObject([{ runs: 1 }]);
    expect(data?.services).toStrictEqual([]);
  });

  it("still aggregates runs when Axiom returns a non-array result", async () => {
    const seeded = await seedInsightActor();
    await seedCompletedRun(seeded);
    context.mocks.axiom.query.mockResolvedValue({ rows: [] });
    mockNow(new Date(FIXED_NOW_ISO));
    defaultClerkMocksFor(seeded);

    const response = await runAggregation();

    expect(response.body).toMatchObject({ networkRows: 0 });
    const data = await findInsights(seeded.actor);
    expect(data?.agents).toMatchObject([{ runs: 1 }]);
    expect(data?.services).toStrictEqual([]);
  });
});
