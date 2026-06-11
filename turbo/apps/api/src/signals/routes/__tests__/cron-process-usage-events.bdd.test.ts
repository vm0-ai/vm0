import { randomUUID } from "node:crypto";

import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageFixture$,
  insertUsageEvent$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy
// `cron-process-usage-events.test.ts`. The 9 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) auth chain
// (401 invalid cron secret → 401 missing cron
// authorization), (2) single-event processing chain
// (200 processes pending event + deducts credits → 200
// rounds up partial pricing units → 200 charges model
// token categories with per-token rounding → 200 uses
// fallback pricing + records missing pricing → 200 skips
// already-processed events), (3) batch + concurrency +
// multi-org chain (200 processes multiple pending rows in
// the same org batch → 200 serializes concurrent cron
// calls with the shared advisory lock → 200 processes
// pending events across all orgs).

const context = testContext();
const store = createStore();
const TOKEN_CATEGORY_INPUT = "tokens.input";
const TOKEN_CATEGORY_OUTPUT = "tokens.output";
const TOKEN_CATEGORY_CACHE_READ = "tokens.cache_read";
const TOKEN_CATEGORY_CACHE_CREATION = "tokens.cache_creation";

function apiClient() {
  return setupApp({ context })(cronProcessUsageEventsContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function seedCredits(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .update(orgMetadata)
    .set({ credits: 100_000 })
    .where(eq(orgMetadata.orgId, fixture.orgId));
}

async function insertPricing(args: {
  readonly kind?: string;
  readonly provider: string;
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize?: number;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(usagePricing).values({
    kind: args.kind ?? "connector",
    provider: args.provider,
    category: args.category,
    unitPrice: args.unitPrice,
    unitSize: args.unitSize ?? 1,
  });
}

async function findUsageEvent(id: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      status: usageEvent.status,
      creditsCharged: usageEvent.creditsCharged,
      billingError: usageEvent.billingError,
    })
    .from(usageEvent)
    .where(eq(usageEvent.id, id))
    .limit(1);
  return row;
}

async function getOrgCredits(orgId: string): Promise<number> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return Number(row?.credits ?? 0);
}

const track = createFixtureTracker<UsageFixture>((fixture) => {
  return store.set(deleteUsageFixture$, fixture, context.signal);
});

describe("BDD GET /api/cron/process-usage-events — auth chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
  });

  it("gwt-wt-wt: 401 invalid cron secret → 401 missing cron authorization", async () => {
    // Given: a wrong cron secret in the auth header.

    // When + Then: 401 — Invalid cron secret.
    const wrongSecret = await accept(
      apiClient().process({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(wrongSecret.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: no auth header.

    // When + Then: 401 — Invalid cron secret.
    const noAuth = await accept(apiClient().process({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/cron/process-usage-events — single-event processing chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
  });

  it("gwt-wt-wt: 200 processes pending event + deducts credits → 200 rounds up partial pricing units → 200 charges model token categories with per-token rounding → 200 uses fallback pricing + records missing pricing → 200 skips already-processed events", async () => {
    // Given: a fixture + 100_000 credits + a connector
    // pricing rule + 1 pending usage event.

    // When + Then: 200 — the event is processed + 30
    // credits are deducted + the org's credits drop from
    // 100_000 to 99_970.
    const basicFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(basicFixture);
    const basicProvider = `provider-${randomUUID()}`;
    await insertPricing({
      provider: basicProvider,
      category: "tweet.read",
      unitPrice: 10,
    });
    const basicEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: basicFixture.orgId,
        userId: basicFixture.userId,
        provider: basicProvider,
        category: "tweet.read",
        quantity: 3,
        status: "pending",
      },
      context.signal,
    );
    const basicResponse = await accept(
      apiClient().process({ headers: cronHeaders() }),
      [200],
    );
    expect(basicResponse.body.success).toBeTruthy();
    expect(basicResponse.body.processed).toBeGreaterThanOrEqual(1);
    await expect(findUsageEvent(basicEventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 30,
      billingError: null,
    });
    await expect(getOrgCredits(basicFixture.orgId)).resolves.toBe(99_970);

    // Given: a fixture + 100_000 credits + model pricing
    // for tokens.input at 3000 credits per 1M tokens + 1
    // pending model event with quantity 1.

    // When + Then: 200 — Math.ceil(1 * 3000 / 1_000_000)
    // = 1 credit.
    const roundingFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(roundingFixture);
    const roundingProvider = `rounding-${randomUUID()}`;
    await insertPricing({
      kind: "model",
      provider: roundingProvider,
      category: TOKEN_CATEGORY_INPUT,
      unitPrice: 3000,
      unitSize: 1_000_000,
    });
    const roundingEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: roundingFixture.orgId,
        userId: roundingFixture.userId,
        kind: "model",
        provider: roundingProvider,
        category: TOKEN_CATEGORY_INPUT,
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );
    await accept(apiClient().process({ headers: cronHeaders() }), [200]);
    await expect(findUsageEvent(roundingEventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 1,
      billingError: null,
    });

    // Given: a fixture + 100_000 credits + 4 model token
    // categories (input/output/cache_read/cache_creation)
    // at 1M unit size + 4 pending model events.

    // When + Then: 200 — each event is processed with
    // Math.ceil(quantity * unitPrice / 1_000_000) credits
    // and the org's total credits drop by the sum.
    const tokensFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(tokensFixture);
    const tokensProvider = `tokens-${randomUUID()}`;
    const tokensEvents = [
      {
        category: TOKEN_CATEGORY_INPUT,
        quantity: 1_234_567,
        unitPrice: 100,
      },
      {
        category: TOKEN_CATEGORY_OUTPUT,
        quantity: 765_432,
        unitPrice: 200,
      },
      {
        category: TOKEN_CATEGORY_CACHE_READ,
        quantity: 10_001,
        unitPrice: 30,
      },
      {
        category: TOKEN_CATEGORY_CACHE_CREATION,
        quantity: 2_000_001,
        unitPrice: 125,
      },
    ];
    const seededTokens: { id: string; expectedCredits: number }[] = [];
    for (const event of tokensEvents) {
      await insertPricing({
        kind: "model",
        provider: tokensProvider,
        category: event.category,
        unitPrice: event.unitPrice,
        unitSize: 1_000_000,
      });
      const id = await store.set(
        insertUsageEvent$,
        {
          orgId: tokensFixture.orgId,
          userId: tokensFixture.userId,
          kind: "model",
          provider: tokensProvider,
          category: event.category,
          quantity: event.quantity,
          status: "pending",
        },
        context.signal,
      );
      seededTokens.push({
        id,
        expectedCredits: Math.ceil(
          (event.quantity * event.unitPrice) / 1_000_000,
        ),
      });
    }
    await accept(apiClient().process({ headers: cronHeaders() }), [200]);
    for (const event of seededTokens) {
      await expect(findUsageEvent(event.id)).resolves.toStrictEqual({
        status: "processed",
        creditsCharged: event.expectedCredits,
        billingError: null,
      });
    }
    const tokensTotal = seededTokens.reduce((sum, event) => {
      return sum + event.expectedCredits;
    }, 0);
    await expect(getOrgCredits(tokensFixture.orgId)).resolves.toBe(
      100_000 - tokensTotal,
    );

    // Given: a fixture + 100_000 credits + a fallback
    // pricing rule for an unknown category + 1 event
    // matching the fallback provider + 1 event for a
    // provider with no pricing.

    // When + Then: 200 — the fallback event is
    // processed at 5 * 4 = 20 credits with
    // billingError="fallback_pricing" + the missing
    // event is processed at 0 credits with
    // billingError="missing_pricing".
    const fallbackFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fallbackFixture);
    const fallbackProvider = `fallback-${randomUUID()}`;
    const missingProvider = `missing-${randomUUID()}`;
    await insertPricing({
      provider: fallbackProvider,
      category: "__fallback__",
      unitPrice: 5,
    });
    const fallbackId = await store.set(
      insertUsageEvent$,
      {
        orgId: fallbackFixture.orgId,
        userId: fallbackFixture.userId,
        provider: fallbackProvider,
        category: "includes.unknown_key",
        quantity: 4,
        status: "pending",
      },
      context.signal,
    );
    const missingId = await store.set(
      insertUsageEvent$,
      {
        orgId: fallbackFixture.orgId,
        userId: fallbackFixture.userId,
        provider: missingProvider,
        category: "unknown.category",
        quantity: 8,
        status: "pending",
      },
      context.signal,
    );
    const fallbackResponse = await accept(
      apiClient().process({ headers: cronHeaders() }),
      [200],
    );
    expect(fallbackResponse.body.success).toBeTruthy();
    await expect(findUsageEvent(fallbackId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 20,
      billingError: "fallback_pricing",
    });
    await expect(findUsageEvent(missingId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 0,
      billingError: "missing_pricing",
    });

    // Given: a fixture + 100_000 credits + a connector
    // pricing rule + 1 already-processed event with
    // creditsCharged=500.

    // When + Then: 200 — the event is left alone +
    // credits stay at 100_000.
    const skipFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(skipFixture);
    const skipProvider = `processed-${randomUUID()}`;
    await insertPricing({
      provider: skipProvider,
      category: "tweet.read",
      unitPrice: 10,
    });
    const skipEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: skipFixture.orgId,
        userId: skipFixture.userId,
        provider: skipProvider,
        category: "tweet.read",
        quantity: 3,
        creditsCharged: 500,
        status: "processed",
      },
      context.signal,
    );
    await accept(apiClient().process({ headers: cronHeaders() }), [200]);
    await expect(findUsageEvent(skipEventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 500,
      billingError: null,
    });
    await expect(getOrgCredits(skipFixture.orgId)).resolves.toBe(100_000);
  });
});

describe("BDD GET /api/cron/process-usage-events — batch + concurrency + multi-org chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
  });

  it("gwt-wt-wt: 200 processes multiple pending rows in the same org batch → 200 serializes concurrent cron calls with the shared advisory lock → 200 processes pending events across all orgs", async () => {
    // Given: a fixture + 100_000 credits + 2 connector
    // pricing rules (tweet.read at 10, tweet.write at
    // 200) + 2 pending events (read=2, write=1).

    // When + Then: 200 — the read event charges 20
    // credits + the write event charges 200 credits +
    // the org's total drops from 100_000 to 99_780.
    const batchFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(batchFixture);
    const batchProvider = `batch-${randomUUID()}`;
    await insertPricing({
      provider: batchProvider,
      category: "tweet.read",
      unitPrice: 10,
    });
    await insertPricing({
      provider: batchProvider,
      category: "tweet.write",
      unitPrice: 200,
    });
    const batchReadId = await store.set(
      insertUsageEvent$,
      {
        orgId: batchFixture.orgId,
        userId: batchFixture.userId,
        provider: batchProvider,
        category: "tweet.read",
        quantity: 2,
        status: "pending",
      },
      context.signal,
    );
    const batchWriteId = await store.set(
      insertUsageEvent$,
      {
        orgId: batchFixture.orgId,
        userId: batchFixture.userId,
        provider: batchProvider,
        category: "tweet.write",
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );
    await accept(apiClient().process({ headers: cronHeaders() }), [200]);
    await expect(findUsageEvent(batchReadId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 20,
      billingError: null,
    });
    await expect(findUsageEvent(batchWriteId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 200,
      billingError: null,
    });
    await expect(getOrgCredits(batchFixture.orgId)).resolves.toBe(99_780);

    // Given: a fixture + 100_000 credits + 1 connector
    // pricing rule + 1 pending event.

    // When + Then: 200 — even with 2 concurrent cron
    // calls, the event is processed exactly once at 30
    // credits and the org's credits drop to 99_970.
    const concurrentFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(concurrentFixture);
    const concurrentProvider = `concurrent-${randomUUID()}`;
    await insertPricing({
      provider: concurrentProvider,
      category: "tweet.read",
      unitPrice: 10,
    });
    const concurrentEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: concurrentFixture.orgId,
        userId: concurrentFixture.userId,
        provider: concurrentProvider,
        category: "tweet.read",
        quantity: 3,
        status: "pending",
      },
      context.signal,
    );
    await Promise.all([
      accept(apiClient().process({ headers: cronHeaders() }), [200]),
      accept(apiClient().process({ headers: cronHeaders() }), [200]),
    ]);
    await expect(findUsageEvent(concurrentEventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 30,
      billingError: null,
    });
    await expect(getOrgCredits(concurrentFixture.orgId)).resolves.toBe(99_970);

    // Given: 2 fixtures + 100_000 credits each + 1
    // connector pricing rule + 1 pending event per
    // fixture.

    // When + Then: 200 — events from both orgs are
    // processed at 10 credits each.
    const firstOrg = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const secondOrg = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(firstOrg);
    await seedCredits(secondOrg);
    const multiOrgProvider = `multi-org-${randomUUID()}`;
    await insertPricing({
      provider: multiOrgProvider,
      category: "tweet.read",
      unitPrice: 10,
    });
    const firstOrgEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: firstOrg.orgId,
        userId: firstOrg.userId,
        provider: multiOrgProvider,
        category: "tweet.read",
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );
    const secondOrgEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: secondOrg.orgId,
        userId: secondOrg.userId,
        provider: multiOrgProvider,
        category: "tweet.read",
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );
    await accept(apiClient().process({ headers: cronHeaders() }), [200]);
    await expect(findUsageEvent(firstOrgEventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 10,
      billingError: null,
    });
    await expect(findUsageEvent(secondOrgEventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 10,
      billingError: null,
    });
  });
});
