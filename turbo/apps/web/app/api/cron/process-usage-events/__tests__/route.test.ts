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
  insertOrgCacheEntry,
  setOrgCredits,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

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

  // NOTE: evaluateMemberCaps currently only aggregates `credit_usage`, not
  // `usage_event`, so spend going through this processor can still slip
  // past a member cap. Tracked in #10734; no regression test here to avoid
  // pinning in the current broken behaviour.
});
