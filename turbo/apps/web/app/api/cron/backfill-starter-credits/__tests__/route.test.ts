import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import {
  setOrgCredits,
  getOrgCredits,
  updateOrgTier,
} from "../../../../../src/__tests__/api-test-helpers";
import { reloadEnv } from "../../../../../src/env";

vi.hoisted(() => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
});

const context = testContext();

function cronRequest(secret?: string) {
  return new Request(
    "http://localhost:3000/api/cron/backfill-starter-credits",
    {
      method: "POST",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    },
  );
}

describe("POST /api/cron/backfill-starter-credits", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    reloadEnv();
    user = await context.setupUser();
  });

  it("returns 401 with missing authorization header", async () => {
    const response = await POST(cronRequest());
    expect(response.status).toBe(401);
  });

  it("returns 401 with wrong cron secret", async () => {
    const response = await POST(cronRequest("wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("grants 10000 credits to free-tier orgs with zero balance", async () => {
    await setOrgCredits(user.orgId, 0);

    const response = await POST(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.updated).toBeGreaterThanOrEqual(1);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(10_000);
  });

  it("skips orgs that already have credits", async () => {
    await setOrgCredits(user.orgId, 5000);

    const response = await POST(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(5000);
  });

  it("skips non-free tier orgs with zero balance", async () => {
    await setOrgCredits(user.orgId, 0);
    await updateOrgTier(user.orgId, "pro");

    const response = await POST(cronRequest("test-cron-secret"));
    expect(response.status).toBe(200);

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(0);
  });

  it("is idempotent — second run does not double-grant", async () => {
    await setOrgCredits(user.orgId, 0);

    await POST(cronRequest("test-cron-secret"));
    await POST(cronRequest("test-cron-secret"));

    const credits = await getOrgCredits(user.orgId);
    expect(credits).toBe(10_000);
  });
});
