import { randomUUID } from "node:crypto";

import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
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
});
