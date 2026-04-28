import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  insertTestUsagePricing,
  insertTestUsageEvent,
  findTestUsageEvent,
  getOrgCredits,
  getOrgMembersEntry,
  insertOrgCacheEntry,
  insertOrgMembersEntry,
  setOrgCredits,
  updateOrgStripeFields,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";
import {
  TOKEN_CATEGORY_CACHE_CREATION,
  TOKEN_CATEGORY_CACHE_READ,
  TOKEN_CATEGORY_INPUT,
  TOKEN_CATEGORY_OUTPUT,
} from "../../../../../src/lib/zero/billing/model-usage-categories";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request("http://localhost:3000/api/cron/process-usage-events", {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/process-usage-events", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
    user = await context.setupUser();
    await setOrgCredits(user.orgId, 100_000);
  });

  it("charges ceil(quantity × unit_price / unit_size)", async () => {
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      unitPrice: 10,
      unitSize: 1,
    });

    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 3,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const record = await findTestUsageEvent(eventId);
    expect(record!.status).toBe("processed");
    expect(record!.creditsCharged).toBe(30);
    expect(record!.processedAt).toBeInstanceOf(Date);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(99_970);
  });

  it("rounds up partial units", async () => {
    // 1 token at $3 / 1M → ceil(1 × 3000 / 1_000_000) = 1
    await insertTestUsagePricing({
      kind: "model",
      provider: "anthropic",
      category: "tokens.input",
      unitPrice: 3000,
      unitSize: 1_000_000,
    });

    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      kind: "model",
      provider: "anthropic",
      category: "tokens.input",
      quantity: 1,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const record = await findTestUsageEvent(eventId);
    expect(record!.creditsCharged).toBe(1);
  });

  it("charges model token categories with legacy per-token rounding", async () => {
    const provider = "claude-sonnet-4-6";
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

    const seededEvents: Array<{ id: string; expectedCredits: number }> = [];
    for (const event of events) {
      await insertTestUsagePricing({
        kind: "model",
        provider,
        category: event.category,
        unitPrice: event.unitPrice,
        unitSize: 1_000_000,
      });

      const id = await insertTestUsageEvent(user.orgId, {
        userId: user.userId,
        kind: "model",
        provider,
        category: event.category,
        quantity: event.quantity,
      });
      seededEvents.push({
        id,
        expectedCredits: Math.ceil(
          (event.quantity * event.unitPrice) / 1_000_000,
        ),
      });
    }

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const records = await Promise.all(
      seededEvents.map(async (event) => {
        return {
          expectedCredits: event.expectedCredits,
          record: await findTestUsageEvent(event.id),
        };
      }),
    );
    for (const { expectedCredits, record } of records) {
      expect(record!.status).toBe("processed");
      expect(record!.creditsCharged).toBe(expectedCredits);
    }

    const expectedTotal = seededEvents.reduce((sum, event) => {
      return sum + event.expectedCredits;
    }, 0);
    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(100_000 - expectedTotal);
  });

  it("marks records with no matching pricing as processed with zero charge", async () => {
    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      kind: "connector",
      provider: "unknown-provider",
      category: "unknown.category",
      quantity: 5,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const record = await findTestUsageEvent(eventId);
    expect(record!.status).toBe("processed");
    expect(record!.creditsCharged).toBe(0);
    expect(record!.processedAt).toBeInstanceOf(Date);
    expect(record!.billingError).toBe("missing_pricing");
  });

  it("falls back to (kind, provider, __fallback__) when exact category is unseeded", async () => {
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "__fallback__",
      unitPrice: 5,
      unitSize: 1,
    });

    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      kind: "connector",
      provider: "x",
      category: "includes.unknown_key",
      quantity: 4,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const record = await findTestUsageEvent(eventId);
    expect(record!.status).toBe("processed");
    expect(record!.creditsCharged).toBe(20);
    expect(record!.billingError).toBe("fallback_pricing");

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(100_000 - 20);
  });

  it("skips already-processed records", async () => {
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      unitPrice: 10,
      unitSize: 1,
    });

    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      status: "processed",
      creditsCharged: 500,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const record = await findTestUsageEvent(eventId);
    expect(record!.status).toBe("processed");
    expect(record!.creditsCharged).toBe(500);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(100_000);
  });

  it("processes multiple pending records in a batch", async () => {
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      unitPrice: 10,
      unitSize: 1,
    });
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.write",
      unitPrice: 200,
      unitSize: 1,
    });

    const id1 = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      category: "tweet.read",
      quantity: 2,
    });
    const id2 = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      category: "tweet.write",
      quantity: 1,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const r1 = await findTestUsageEvent(id1);
    expect(r1!.creditsCharged).toBe(20);

    const r2 = await findTestUsageEvent(id2);
    expect(r2!.creditsCharged).toBe(200);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(100_000 - 220);
  });

  it("concurrent calls serialize via advisory lock", async () => {
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      unitPrice: 10,
      unitSize: 1,
    });

    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      quantity: 3,
    });

    await Promise.all([
      GET(cronRequest("test-cron-secret")),
      GET(cronRequest("test-cron-secret")),
    ]);

    const record = await findTestUsageEvent(eventId);
    expect(record!.creditsCharged).toBe(30);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(100_000 - 30);
  });

  it("finds and processes all orgs with pending usage events", async () => {
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      unitPrice: 10,
      unitSize: 1,
    });

    const org2Id = uniqueId("org");
    await insertOrgCacheEntry({ orgId: org2Id, slug: uniqueId("slug") });

    const id1 = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      quantity: 1,
    });
    const id2 = await insertTestUsageEvent(org2Id, {
      userId: user.userId,
      quantity: 1,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const r1 = await findTestUsageEvent(id1);
    expect(r1!.status).toBe("processed");

    const r2 = await findTestUsageEvent(id2);
    expect(r2!.status).toBe("processed");
  });

  it("disables capped members when processed usage_event spend reaches the cap", async () => {
    const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });
    await insertOrgMembersEntry({
      orgId: user.orgId,
      userId: user.userId,
      creditCap: 25,
      creditEnabled: true,
    });
    await insertTestUsagePricing({
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      unitPrice: 10,
      unitSize: 1,
    });

    const eventId = await insertTestUsageEvent(user.orgId, {
      userId: user.userId,
      kind: "connector",
      provider: "x",
      category: "tweet.read",
      quantity: 3,
    });

    const response = await GET(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const event = await findTestUsageEvent(eventId);
    expect(event!.status).toBe("processed");
    expect(event!.creditsCharged).toBe(30);

    const member = await getOrgMembersEntry(user.orgId, user.userId);
    expect(member!.creditEnabled).toBe(false);
  });
});
