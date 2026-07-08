import { randomUUID } from "node:crypto";

import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import {
  deleteVm0ManagedDefaultModelKey,
  seedVm0ManagedDefaultModelKey as seedVm0ManagedDefaultModelKeyState,
} from "./helpers/automations";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageFixture$,
  insertUsageEvent$,
  readRunUsageCredits$,
  readUsageAllowance$,
  readUsageOrgCredits$,
  seedRun$,
  seedUsageAllowance$,
  seedUsageFixture$,
  seedUsagePricing$,
  setUsageFixtureCreditBalance$,
  setUsageOrgTier$,
  type UsageAllowanceState,
  type UsageFixture,
} from "./helpers/zero-usage";

const context = testContext();
const store = createStore();

function cronHeaders() {
  return { authorization: "Bearer test-cron-secret" };
}

function usageProvider(): string {
  return `usage-allowance-${randomUUID()}`;
}

function windowByKind(state: UsageAllowanceState, kind: "short" | "weekly") {
  const window = state.windows.find((candidate) => {
    return candidate.kind === kind;
  });
  if (!window) {
    throw new Error(`Missing ${kind} usage allowance window`);
  }
  return window;
}

function windowsByKind(state: UsageAllowanceState, kind: "short" | "weekly") {
  return state.windows.filter((candidate) => {
    return candidate.kind === kind;
  });
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function processUsageEvents(): Promise<void> {
  const client = setupApp({ context })(cronProcessUsageEventsContract);
  const response = await accept(
    client.process({ headers: cronHeaders() }),
    [200],
  );
  expect(response.body.success).toBeTruthy();
}

async function seedPricing(provider: string): Promise<void> {
  await store.set(
    seedUsagePricing$,
    { provider, category: "credits", unitPrice: 1, unitSize: 1 },
    context.signal,
  );
}

async function seedPendingUsage(args: {
  readonly fixture: UsageFixture;
  readonly provider: string;
  readonly runId: string;
  readonly quantity: number;
}): Promise<void> {
  await store.set(
    insertUsageEvent$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      runId: args.runId,
      provider: args.provider,
      category: "credits",
      quantity: args.quantity,
      status: "pending",
      processedAt: null,
    },
    context.signal,
  );
}

async function seedVm0ManagedDefaultModelKey(): Promise<void> {
  onTestFinished(async () => {
    await deleteVm0ManagedDefaultModelKey(context);
  });
  await seedVm0ManagedDefaultModelKeyState(context);
}

async function setCredits(
  fixture: UsageFixture,
  credits: number,
): Promise<void> {
  await store.set(
    setUsageFixtureCreditBalance$,
    { fixture, credits },
    context.signal,
  );
}

describe("Usage Allowance", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("applies usage allowance before legacy org credits", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 10);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 200,
      },
      context.signal,
    );
    const run = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: run.runId,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(10);
    await expect(
      store.set(readRunUsageCredits$, run.runId, context.signal),
    ).resolves.toBe(0);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(windowByKind(allowance, "short").consumedUnits).toBe(80);
    expect(windowByKind(allowance, "weekly").consumedUnits).toBe(80);
    expect(allowance.allocations).toStrictEqual([
      {
        usageEventId: expect.any(String),
        runId: run.runId,
        unitsApplied: 80,
      },
    ]);
  });

  it("falls back to org credits after the binding window cap is exhausted", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 100);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 60,
      },
      context.signal,
    );
    const run = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: run.runId,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(80);
    await expect(
      store.set(readRunUsageCredits$, run.runId, context.signal),
    ).resolves.toBe(20);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(windowByKind(allowance, "short").consumedUnits).toBe(60);
    expect(windowByKind(allowance, "weekly").consumedUnits).toBe(60);
    expect(allowance.allocations[0]?.unitsApplied).toBe(60);
  });

  it("charges org credits after the short window is exhausted", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 100);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 200,
      },
      context.signal,
    );
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: startedAt,
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: firstRun.runId,
      quantity: 100,
    });
    await processUsageEvents();

    const secondRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: addHours(startedAt, 1),
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    await seedPendingUsage({
      fixture,
      provider,
      runId: secondRun.runId,
      quantity: 50,
    });
    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(50);
    await expect(
      store.set(readRunUsageCredits$, secondRun.runId, context.signal),
    ).resolves.toBe(50);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(windowsByKind(allowance, "short")).toHaveLength(1);
    expect(windowsByKind(allowance, "weekly")).toHaveLength(1);
    expect(windowByKind(allowance, "short").consumedUnits).toBe(100);
    expect(windowByKind(allowance, "weekly").consumedUnits).toBe(100);
    expect(allowance.allocations).toHaveLength(1);
    expect(allowance.allocations[0]?.runId).toBe(firstRun.runId);
  });

  it("refreshes the short window while continuing the active weekly window", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 100);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 200,
      },
      context.signal,
    );
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: startedAt,
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: firstRun.runId,
      quantity: 100,
    });
    await processUsageEvents();

    const secondRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: addHours(startedAt, 6),
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    await seedPendingUsage({
      fixture,
      provider,
      runId: secondRun.runId,
      quantity: 50,
    });
    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(100);
    await expect(
      store.set(readRunUsageCredits$, secondRun.runId, context.signal),
    ).resolves.toBe(0);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(
      windowsByKind(allowance, "short").map((window) => {
        return window.consumedUnits;
      }),
    ).toStrictEqual([100, 50]);
    expect(windowsByKind(allowance, "weekly")).toHaveLength(1);
    expect(windowByKind(allowance, "weekly").consumedUnits).toBe(150);
    expect(
      allowance.allocations.map((allocation) => {
        return allocation.unitsApplied;
      }),
    ).toStrictEqual([100, 50]);
  });

  it("refreshes the weekly window for runs after the weekly window expires", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 100);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 120,
      },
      context.signal,
    );
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: startedAt,
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: firstRun.runId,
      quantity: 80,
    });
    await processUsageEvents();

    const secondRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: addDays(startedAt, 8),
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    await seedPendingUsage({
      fixture,
      provider,
      runId: secondRun.runId,
      quantity: 50,
    });
    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(100);
    await expect(
      store.set(readRunUsageCredits$, secondRun.runId, context.signal),
    ).resolves.toBe(0);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(
      windowsByKind(allowance, "short").map((window) => {
        return window.consumedUnits;
      }),
    ).toStrictEqual([80, 50]);
    expect(
      windowsByKind(allowance, "weekly").map((window) => {
        return window.consumedUnits;
      }),
    ).toStrictEqual([80, 50]);
  });

  it("admits vm0 runs with zero org credits when allowance remains", async () => {
    await seedVm0ManagedDefaultModelKey();
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const actor = bdd.user();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected test actor to have an org");
    }
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();
    await bdd.setupOnboarding(actor, {
      displayName: "Usage allowance admission agent",
    });
    await store.set(setUsageOrgTier$, { orgId, tier: "pro" }, context.signal);
    await setCredits(
      { orgId, userId: actor.userId, userIds: [actor.userId] },
      0,
    );
    await store.set(
      seedUsageAllowance$,
      {
        orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 10,
        weeklyWindowUnits: 10,
      },
      context.signal,
    );
    const agent = await bdd.createAgent(actor, {
      displayName: "Usage allowance admission agent",
      visibility: "private",
    });

    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "vm0 run admitted by usage allowance",
      modelProvider: "vm0",
    });

    expect(run.runId).toStrictEqual(expect.any(String));
    const allowance = await store.set(
      readUsageAllowance$,
      orgId,
      context.signal,
    );
    expect(windowsByKind(allowance, "short")).toHaveLength(1);
    expect(windowsByKind(allowance, "weekly")).toHaveLength(1);
  });

  it("rejects vm0 run admission after allowance is exhausted", async () => {
    await seedVm0ManagedDefaultModelKey();
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const actor = bdd.user();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected test actor to have an org");
    }
    bdd.acceptAgentStorageWrites();
    api.configureRunnerGroup();
    await bdd.setupOnboarding(actor, {
      displayName: "Usage allowance exhausted agent",
    });
    await store.set(setUsageOrgTier$, { orgId, tier: "pro" }, context.signal);
    await setCredits(
      { orgId, userId: actor.userId, userIds: [actor.userId] },
      0,
    );
    await store.set(
      seedUsageAllowance$,
      {
        orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 1,
        weeklyWindowUnits: 1,
      },
      context.signal,
    );
    const agent = await bdd.createAgent(actor, {
      displayName: "Usage allowance exhausted agent",
      visibility: "private",
    });
    const firstRun = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "vm0 run consumes the only allowance unit",
      modelProvider: "vm0",
    });
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture: { orgId, userId: actor.userId, userIds: [actor.userId] },
      provider,
      runId: firstRun.runId,
      quantity: 1,
    });
    await processUsageEvents();

    const rejected = await api.requestCreateRun(
      actor,
      {
        agentId: agent.agentId,
        prompt: "vm0 run rejected after allowance exhaustion",
        modelProvider: "vm0",
      },
      [402],
    );

    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("leases billable firewall auth from allowance and denies it after exhaustion", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 0);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 2,
        weeklyWindowUnits: 2,
      },
      context.signal,
    );
    const run = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        status: "running",
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    const client = setupApp({ context })(webhookFirewallAuthContract);
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        run.runId,
        fixture.orgId,
      )}`,
    };
    const body = {
      encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
      authHeaders: { Authorization: "Bearer static-token" },
      firewallBillable: true,
    };

    const before = Math.floor(now() / 1000);
    const leased = await accept(client.resolve({ headers, body }), [200]);
    expect(leased.body.expiresAt).not.toBeNull();
    expect(leased.body.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 1);

    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: run.runId,
      quantity: 2,
    });
    await processUsageEvents();

    const denied = await accept(client.resolve({ headers, body }), [402]);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("does not backfill allowance windows during usage settlement", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 100);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 200,
      },
      context.signal,
    );
    const run = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: run.runId,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(20);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(allowance.windows).toHaveLength(0);
    expect(allowance.allocations).toStrictEqual([]);
  });

  it("does not apply newly created allowance to older runs", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 100);
    const run = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 100,
        weeklyWindowUnits: 200,
      },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: run.runId,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(20);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(allowance.windows).toHaveLength(0);
    expect(allowance.allocations).toStrictEqual([]);
  });

  it("keeps applying already activated windows after entitlement is inactive", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 0);
    const allowanceArgs = {
      orgId: fixture.orgId,
      shortWindowSeconds: 5 * 60 * 60,
      shortWindowUnits: 100,
      weeklyWindowUnits: 200,
    };
    await store.set(seedUsageAllowance$, allowanceArgs, context.signal);
    const run = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        activateUsageAllowanceWindows: true,
      },
      context.signal,
    );
    await store.set(
      seedUsageAllowance$,
      { ...allowanceArgs, status: "inactive" },
      context.signal,
    );
    const provider = usageProvider();
    await seedPricing(provider);
    await seedPendingUsage({
      fixture,
      provider,
      runId: run.runId,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(
      store.set(readUsageOrgCredits$, fixture.orgId, context.signal),
    ).resolves.toBe(0);
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(windowByKind(allowance, "short").consumedUnits).toBe(80);
    expect(windowByKind(allowance, "weekly").consumedUnits).toBe(80);
    expect(allowance.allocations[0]?.unitsApplied).toBe(80);
  });

  it("denies billable firewall auth when the run has no allowance window", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { tier: "pro" }, context.signal),
    );
    await setCredits(fixture, 0);
    await store.set(
      seedUsageAllowance$,
      {
        orgId: fixture.orgId,
        shortWindowSeconds: 5 * 60 * 60,
        shortWindowUnits: 2,
        weeklyWindowUnits: 2,
      },
      context.signal,
    );
    const run = await store.set(
      seedRun$,
      { orgId: fixture.orgId, userId: fixture.userId, status: "running" },
      context.signal,
    );
    const client = setupApp({ context })(webhookFirewallAuthContract);
    const headers = {
      authorization: `Bearer ${generateSandboxToken(
        fixture.userId,
        run.runId,
        fixture.orgId,
      )}`,
    };
    const body = {
      encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
      authHeaders: { Authorization: "Bearer static-token" },
      firewallBillable: true,
    };

    const denied = await accept(client.resolve({ headers, body }), [402]);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
    const allowance = await store.set(
      readUsageAllowance$,
      fixture.orgId,
      context.signal,
    );
    expect(allowance.windows).toHaveLength(0);
  });
});
