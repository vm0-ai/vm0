import { randomUUID } from "node:crypto";

import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageFixture$,
  insertUsageEvent$,
  seedUsageFixture$,
  setMemberCreditCap$,
  type UsageFixture,
} from "./helpers/zero-usage";
import { createFixtureTracker } from "./helpers/zero-route-test";

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

async function cleanupFixture(fixture: UsageFixture): Promise<void> {
  await store.set(deleteUsageFixture$, fixture, context.signal);
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

async function getMemberCreditEnabled(
  orgId: string,
  userId: string,
): Promise<boolean | undefined> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ creditEnabled: orgMembersMetadata.creditEnabled })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return row?.creditEnabled;
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

describe("GET /api/cron/process-usage-events", () => {
  const track = createFixtureTracker<UsageFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().process({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with missing cron authorization", async () => {
    const response = await accept(apiClient().process({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("processes pending usage events and deducts credits", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
    const provider = `provider-${randomUUID()}`;
    await insertPricing({ provider, category: "tweet.read", unitPrice: 10 });
    const eventId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider,
        category: "tweet.read",
        quantity: 3,
        status: "pending",
      },
      context.signal,
    );

    const response = await accept(
      apiClient().process({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.success).toBeTruthy();
    expect(response.body.processed).toBeGreaterThanOrEqual(1);
    await expect(findUsageEvent(eventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 30,
      billingError: null,
    });
    await expect(getOrgCredits(fixture.orgId)).resolves.toBe(99_970);
  });

  it("rounds up partial pricing units", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
    const provider = `rounding-${randomUUID()}`;
    await insertPricing({
      kind: "model",
      provider,
      category: TOKEN_CATEGORY_INPUT,
      unitPrice: 3000,
      unitSize: 1_000_000,
    });
    const eventId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "model",
        provider,
        category: TOKEN_CATEGORY_INPUT,
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );

    await accept(apiClient().process({ headers: cronHeaders() }), [200]);

    await expect(findUsageEvent(eventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 1,
      billingError: null,
    });
  });

  it("charges model token categories with per-token rounding", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
    const provider = `tokens-${randomUUID()}`;
    const events = [
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
    const seededEvents: { id: string; expectedCredits: number }[] = [];
    for (const event of events) {
      await insertPricing({
        kind: "model",
        provider,
        category: event.category,
        unitPrice: event.unitPrice,
        unitSize: 1_000_000,
      });
      const id = await store.set(
        insertUsageEvent$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          kind: "model",
          provider,
          category: event.category,
          quantity: event.quantity,
          status: "pending",
        },
        context.signal,
      );
      seededEvents.push({
        id,
        expectedCredits: Math.ceil(
          (event.quantity * event.unitPrice) / 1_000_000,
        ),
      });
    }

    await accept(apiClient().process({ headers: cronHeaders() }), [200]);

    for (const event of seededEvents) {
      await expect(findUsageEvent(event.id)).resolves.toStrictEqual({
        status: "processed",
        creditsCharged: event.expectedCredits,
        billingError: null,
      });
    }
    const expectedTotal = seededEvents.reduce((sum, event) => {
      return sum + event.expectedCredits;
    }, 0);
    await expect(getOrgCredits(fixture.orgId)).resolves.toBe(
      100_000 - expectedTotal,
    );
  });

  it("uses fallback pricing and records missing pricing", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
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
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider: missingProvider,
        category: "unknown.category",
        quantity: 8,
        status: "pending",
      },
      context.signal,
    );

    const response = await accept(
      apiClient().process({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.success).toBeTruthy();
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
  });

  it("skips already processed usage events", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
    const provider = `processed-${randomUUID()}`;
    await insertPricing({ provider, category: "tweet.read", unitPrice: 10 });
    const eventId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider,
        category: "tweet.read",
        quantity: 3,
        creditsCharged: 500,
        status: "processed",
      },
      context.signal,
    );

    await accept(apiClient().process({ headers: cronHeaders() }), [200]);

    await expect(findUsageEvent(eventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 500,
      billingError: null,
    });
    await expect(getOrgCredits(fixture.orgId)).resolves.toBe(100_000);
  });

  it("processes multiple pending rows in the same org batch", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
    const provider = `batch-${randomUUID()}`;
    await insertPricing({ provider, category: "tweet.read", unitPrice: 10 });
    await insertPricing({ provider, category: "tweet.write", unitPrice: 200 });
    const readId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider,
        category: "tweet.read",
        quantity: 2,
        status: "pending",
      },
      context.signal,
    );
    const writeId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider,
        category: "tweet.write",
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );

    await accept(apiClient().process({ headers: cronHeaders() }), [200]);

    await expect(findUsageEvent(readId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 20,
      billingError: null,
    });
    await expect(findUsageEvent(writeId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 200,
      billingError: null,
    });
    await expect(getOrgCredits(fixture.orgId)).resolves.toBe(99_780);
  });

  it("serializes concurrent cron calls with the shared advisory lock", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(fixture);
    const provider = `concurrent-${randomUUID()}`;
    await insertPricing({ provider, category: "tweet.read", unitPrice: 10 });
    const eventId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider,
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

    await expect(findUsageEvent(eventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 30,
      billingError: null,
    });
    await expect(getOrgCredits(fixture.orgId)).resolves.toBe(99_970);
  });

  it("processes pending usage events across all orgs", async () => {
    const firstFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const secondFixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await seedCredits(firstFixture);
    await seedCredits(secondFixture);
    const provider = `multi-org-${randomUUID()}`;
    await insertPricing({ provider, category: "tweet.read", unitPrice: 10 });
    const firstId = await store.set(
      insertUsageEvent$,
      {
        orgId: firstFixture.orgId,
        userId: firstFixture.userId,
        provider,
        category: "tweet.read",
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );
    const secondId = await store.set(
      insertUsageEvent$,
      {
        orgId: secondFixture.orgId,
        userId: secondFixture.userId,
        provider,
        category: "tweet.read",
        quantity: 1,
        status: "pending",
      },
      context.signal,
    );

    await accept(apiClient().process({ headers: cronHeaders() }), [200]);

    await expect(findUsageEvent(firstId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 10,
      billingError: null,
    });
    await expect(findUsageEvent(secondId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 10,
      billingError: null,
    });
  });

  it("disables capped members when processed usage reaches the cap", async () => {
    const periodEnd = new Date(nowDate().getTime() + 15 * 24 * 60 * 60 * 1000);
    const fixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEnd },
        context.signal,
      ),
    );
    await seedCredits(fixture);
    await store.set(
      setMemberCreditCap$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        creditCap: 25,
      },
      context.signal,
    );
    const provider = `cap-${randomUUID()}`;
    await insertPricing({ provider, category: "tweet.read", unitPrice: 10 });
    const eventId = await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        provider,
        category: "tweet.read",
        quantity: 3,
        status: "pending",
      },
      context.signal,
    );

    await accept(apiClient().process({ headers: cronHeaders() }), [200]);

    await expect(findUsageEvent(eventId)).resolves.toStrictEqual({
      status: "processed",
      creditsCharged: 30,
      billingError: null,
    });
    await expect(
      getMemberCreditEnabled(fixture.orgId, fixture.userId),
    ).resolves.toBeFalsy();
  });
});
