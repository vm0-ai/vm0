import { randomUUID } from "node:crypto";

import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import {
  seedOrgMetadata,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  deleteVm0ManagedDefaultModelKey,
  seedVm0ManagedDefaultModelKey as seedVm0ManagedDefaultModelKeyState,
} from "./helpers/runtime-state";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  generatedStripeCustomerId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();

function usageProvider(): string {
  return `usage-allowance-${randomUUID()}`;
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

async function seedVm0ManagedDefaultModelKey(): Promise<void> {
  onTestFinished(async () => {
    await deleteVm0ManagedDefaultModelKey(context);
  });
  await seedVm0ManagedDefaultModelKeyState(context);
}

interface AllowanceEntitlementArgs {
  readonly shortWindowUnits: number;
  readonly weeklyWindowUnits: number;
  readonly shortWindowSeconds?: number;
}

/**
 * An org whose runs can be admitted with the vm0 managed model key. Tier and
 * credit balance are pinned through the org-metadata fixture; the allowance
 * entitlement (when given), window activation, usage events, and settlement
 * all run through product paths.
 */
async function vm0AllowanceActor(args: {
  readonly credits: number;
  readonly allowance?: AllowanceEntitlementArgs;
}): Promise<{
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
}> {
  await seedVm0ManagedDefaultModelKey();
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected test actor to have an org");
  }
  bdd.acceptAgentStorageWrites();
  api.configureRunnerGroup();
  const completed = await bdd.completeOnboarding(actor);
  expect(completed.status).toBe(200);
  await seedOrgMetadata({ orgId, tier: "pro", credits: args.credits });
  if (args.allowance) {
    await seedAllowanceEntitlement(actor, orgId, args.allowance);
  }
  const agent = await bdd.createAgent(actor, {
    displayName: "Usage allowance agent",
    visibility: "private",
  });
  return { actor, orgId, agentId: agent.agentId };
}

async function seedAllowanceEntitlement(
  actor: ApiTestUser,
  orgId: string,
  args: AllowanceEntitlementArgs,
): Promise<void> {
  await postUsageAllowanceInvoicePaid(context.signal, {
    orgId,
    userId: actor.userId,
    customerId: generatedStripeCustomerId(),
    subscriptionId: usageAllowanceSubscriptionId(orgId),
    effectiveAt: nowDate(),
    expiresAt: addDays(nowDate(), 365),
    shortWindowSeconds: args.shortWindowSeconds ?? 5 * 60 * 60,
    shortWindowUnits: args.shortWindowUnits,
    weeklyWindowSeconds: 7 * 24 * 60 * 60,
    weeklyWindowUnits: args.weeklyWindowUnits,
  });
}

function usageAllowanceSubscriptionId(orgId: string): string {
  return `sub_usage_allowance_${orgId}`;
}

async function cancelUsageAllowanceSubscription(orgId: string): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  await webhooks.postStripeEvent(
    {
      id: `evt_usage_allowance_cancel_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: usageAllowanceSubscriptionId(orgId),
          status: "canceled",
          items: { data: [] },
        },
      },
    },
    [200],
  );
}

async function createVm0Run(
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
): Promise<{ readonly runId: string }> {
  const api = createRunsApi(context);
  return await api.createRun(actor, {
    agentId,
    prompt,
    modelProvider: "vm0",
  });
}

async function recordPendingUsageEvents(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly provider: string;
  readonly quantities: readonly number[];
}): Promise<void> {
  const api = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider: args.provider,
      category: "credits",
      unitPrice: 1,
      unitSize: 1,
    },
  ]);
  await webhooks.requestAgentUsageEvent(
    {
      runId: args.runId,
      events: args.quantities.map((quantity) => {
        return {
          idempotencyKey: randomUUID(),
          kind: "connector",
          provider: args.provider,
          category: "credits",
          quantity,
        };
      }),
    },
    {
      authorization: `Bearer ${api.sandboxTokenForRun(args.actor, args.runId)}`,
    },
    [200],
  );
}

async function recordPendingUsage(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly provider: string;
  readonly quantity: number;
}): Promise<void> {
  await recordPendingUsageEvents({
    actor: args.actor,
    runId: args.runId,
    provider: args.provider,
    quantities: [args.quantity],
  });
}

async function processUsageEvents(): Promise<void> {
  await createBillingMediaApi(context).processUsageEvents();
}

async function readOrgCredits(actor: ApiTestUser): Promise<number> {
  const api = createRunsApi(context);
  const status = await api.readBillingStatus(actor);
  return status.credits;
}

async function readRunCreditsCharged(
  actor: ApiTestUser,
  runId: string,
): Promise<number> {
  const billing = createBillingMediaApi(context);
  const response = await billing.readUsageRuns(actor, [200]);
  if (response.status !== 200) {
    throw new Error("Expected usage runs read to succeed");
  }
  const run = response.body.runs.find((entry) => {
    return entry.runId === runId;
  });
  if (!run) {
    throw new Error(`Run ${runId} missing from usage runs read`);
  }
  return run.creditsCharged;
}

describe("Usage Allowance", () => {
  it("applies usage allowance before legacy org credits", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 10,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const run = await createVm0Run(actor, agentId, "allowance-covered usage");
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    // Another Vitest worker can settle this org through the shared test DB, so
    // verify persisted billing behavior instead of a worker-local Ably mock.
    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(10);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("settles multiple events and runs against shared allowance windows", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 90 },
    });
    const firstRun = await createVm0Run(actor, agentId, "batched first run");
    const secondRun = await createVm0Run(actor, agentId, "batched second run");
    const provider = usageProvider();
    await recordPendingUsageEvents({
      actor,
      runId: firstRun.runId,
      provider,
      quantities: [30, 40],
    });
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(70);
    await expect(readRunCreditsCharged(actor, firstRun.runId)).resolves.toBe(
      70,
    );
    await expect(readRunCreditsCharged(actor, secondRun.runId)).resolves.toBe(
      50,
    );
    const status = await createRunsApi(context).readBillingStatus(actor);
    if (!status.usageAllowance) {
      throw new Error("Expected usage allowance windows");
    }
    expect(
      Object.fromEntries(
        status.usageAllowance.windows.map((window) => {
          return [window.kind, window.consumedUnits];
        }),
      ),
    ).toStrictEqual({ short: 90, weekly: 90 });
  });

  it("falls back to org credits after the binding window cap is exhausted", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 60 },
    });
    const run = await createVm0Run(actor, agentId, "weekly cap binds first");
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(80);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("charges org credits after the short window is exhausted", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const firstRun = await createVm0Run(
      actor,
      agentId,
      "exhausts short window",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 100,
    });
    await processUsageEvents();

    mockNow(addHours(startedAt, 1));
    const secondRun = await createVm0Run(actor, agentId, "same short window");
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });
    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(50);
    await expect(readRunCreditsCharged(actor, firstRun.runId)).resolves.toBe(
      100,
    );
    await expect(readRunCreditsCharged(actor, secondRun.runId)).resolves.toBe(
      50,
    );
  });

  it("refreshes the short window while continuing the active weekly window", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const firstRun = await createVm0Run(
      actor,
      agentId,
      "exhausts short window",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 100,
    });
    await processUsageEvents();

    mockNow(addHours(startedAt, 6));
    const secondRun = await createVm0Run(actor, agentId, "fresh short window");
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });
    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readRunCreditsCharged(actor, secondRun.runId)).resolves.toBe(
      50,
    );
  });

  it("refreshes the weekly window for runs after the weekly window expires", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 120 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const firstRun = await createVm0Run(actor, agentId, "first weekly window");
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 80,
    });
    await processUsageEvents();

    mockNow(addDays(startedAt, 8));
    const secondRun = await createVm0Run(actor, agentId, "fresh weekly window");
    await recordPendingUsage({
      actor,
      runId: secondRun.runId,
      provider,
      quantity: 50,
    });
    await processUsageEvents();

    // A continued weekly window would only have 40 units left (120 - 80), so
    // full coverage of the 50-unit event proves the weekly window refreshed.
    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readRunCreditsCharged(actor, secondRun.runId)).resolves.toBe(
      50,
    );
  });

  it("admits vm0 runs with zero org credits when allowance remains", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 0,
      allowance: { shortWindowUnits: 10, weeklyWindowUnits: 10 },
    });

    const run = await createVm0Run(
      actor,
      agentId,
      "vm0 run admitted by usage allowance",
    );

    expect(run.runId).toStrictEqual(expect.any(String));
    // The activated windows fully cover usage despite the zero balance.
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 10,
    });
    await processUsageEvents();
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(10);
  });

  it("rejects vm0 run admission after allowance is exhausted", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 0,
      allowance: { shortWindowUnits: 1, weeklyWindowUnits: 1 },
    });
    const api = createRunsApi(context);
    const firstRun = await createVm0Run(
      actor,
      agentId,
      "vm0 run consumes the only allowance unit",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: firstRun.runId,
      provider,
      quantity: 1,
    });
    await processUsageEvents();

    const rejected = await api.requestCreateRun(
      actor,
      {
        agentId,
        prompt: "vm0 run rejected after allowance exhaustion",
        modelProvider: "vm0",
      },
      [402],
    );

    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("leases billable firewall auth from allowance and denies it after exhaustion", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 0,
      allowance: { shortWindowUnits: 2, weeklyWindowUnits: 2 },
    });
    const api = createRunsApi(context);
    const run = await createVm0Run(actor, agentId, "billable firewall lease");
    const client = setupApp({ context })(webhookFirewallAuthContract);
    const headers = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
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
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 2,
    });
    await processUsageEvents();

    const denied = await accept(client.resolve({ headers, body }), [402]);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("backfills allowance windows during non-vm0 usage settlement", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected test actor to have an org");
    }
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    await seedOrgMetadata({ orgId, tier: "pro", credits: 100 });
    await seedAllowanceEntitlement(actor, orgId, {
      shortWindowUnits: 100,
      weeklyWindowUnits: 200,
    });
    const agent = await bdd.createAgent(actor, {
      displayName: "Usage allowance agent",
      visibility: "private",
    });
    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "non-vm0 run uses allowance",
      modelProvider: "anthropic-api-key",
    });
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("applies allowance to non-vm0 runs inside active allowance windows", async () => {
    const { actor, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    await createVm0Run(actor, agentId, "activate allowance windows");

    const api = createRunsApi(context);
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.ensureOrgModelProvider(actor);
    const run = await api.createRun(actor, {
      agentId,
      prompt: "non-vm0 run inside active allowance window",
      modelProvider: "anthropic-api-key",
    });
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("does not apply newly created allowance to older runs", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const runCreatedAt = nowDate();
    mockNow(runCreatedAt);
    const { actor, orgId, agentId } = await vm0AllowanceActor({ credits: 100 });
    const run = await createVm0Run(actor, agentId, "run before entitlement");
    mockNow(addHours(runCreatedAt, 1));
    await seedAllowanceEntitlement(actor, orgId, {
      shortWindowUnits: 100,
      weeklyWindowUnits: 200,
    });
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(20);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("applies existing allowance windows after entitlement is canceled for an already created run", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, orgId, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    const run = await createVm0Run(
      actor,
      agentId,
      "run created before allowance cancellation",
    );

    const canceledAt = addHours(startedAt, 1);
    mockNow(canceledAt);
    await cancelUsageAllowanceSubscription(orgId);
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(100);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("does not apply existing allowance windows after entitlement is canceled", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const { actor, orgId, agentId } = await vm0AllowanceActor({
      credits: 100,
      allowance: { shortWindowUnits: 100, weeklyWindowUnits: 200 },
    });
    const startedAt = nowDate();
    mockNow(startedAt);
    await createVm0Run(actor, agentId, "activate allowance windows");
    const canceledAt = addHours(startedAt, 1);
    mockNow(canceledAt);
    await cancelUsageAllowanceSubscription(orgId);
    mockNow(addHours(startedAt, 2));
    const run = await createVm0Run(
      actor,
      agentId,
      "new run after allowance cancellation",
    );
    const provider = usageProvider();
    await recordPendingUsage({
      actor,
      runId: run.runId,
      provider,
      quantity: 80,
    });

    await processUsageEvents();

    await expect(readOrgCredits(actor)).resolves.toBe(20);
    await expect(readRunCreditsCharged(actor, run.runId)).resolves.toBe(80);
  });

  it("denies billable firewall auth when the run has no allowance window", async () => {
    onTestFinished(() => {
      clearMockNow();
    });
    const runCreatedAt = nowDate();
    mockNow(runCreatedAt);
    const { actor, orgId, agentId } = await vm0AllowanceActor({ credits: 100 });
    const api = createRunsApi(context);
    // The run predates the entitlement, so it has no allowance windows.
    const run = await createVm0Run(actor, agentId, "run without windows");
    mockNow(addHours(runCreatedAt, 1));
    await seedAllowanceEntitlement(actor, orgId, {
      shortWindowUnits: 2,
      weeklyWindowUnits: 2,
    });
    await seedOrgMetadata({ orgId, tier: "pro", credits: 0 });
    const client = setupApp({ context })(webhookFirewallAuthContract);
    const headers = {
      authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
    };
    const body = {
      encryptedSecrets: encryptSecretForTests(JSON.stringify({})),
      authHeaders: { Authorization: "Bearer static-token" },
      firewallBillable: true,
    };

    const denied = await accept(client.resolve({ headers, body }), [402]);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });
});
