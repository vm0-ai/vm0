import { randomUUID } from "node:crypto";

import { cronProcessUsageEventsContract } from "@vm0/api-contracts/contracts/cron";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

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

const context = testContext();
const store = createStore();

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
});
