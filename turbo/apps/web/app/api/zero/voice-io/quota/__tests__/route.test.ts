import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestOrg,
  updateOrgTier,
} from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { seedBehaviorCount } from "../../../../../../src/__tests__/db-test-seeders/behavior";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  AUDIO_INPUT_FREE_QUOTA,
} from "../../../../../../src/lib/zero/voice-io/audio-input-policy";

const { GET } = await import("../route");

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("quota");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function createQuotaRequest(): Request {
  return new Request("http://localhost:3000/api/zero/voice-io/quota", {
    method: "GET",
  });
}

describe("GET /api/zero/voice-io/quota", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return allowed=true with count=0 for a free org with no prior records", async () => {
    const userId = uniqueId("quota-free-empty");
    await setupOrg(userId);
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: true,
      count: 0,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("should return allowed=true with accurate count for a free org with partial usage", async () => {
    const userId = uniqueId("quota-free-partial");
    const { orgId } = await setupOrg(userId);
    await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 2);
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: true,
      count: 2,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("should return allowed=true when a free org is one below the quota boundary", async () => {
    const userId = uniqueId("quota-free-boundary-below");
    const { orgId } = await setupOrg(userId);
    await seedBehaviorCount(
      orgId,
      userId,
      AUDIO_INPUT_BEHAVIOR_KEY,
      AUDIO_INPUT_FREE_QUOTA - 1,
    );
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: true,
      count: AUDIO_INPUT_FREE_QUOTA - 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("should return allowed=false when a free org has reached the quota", async () => {
    const userId = uniqueId("quota-free-full");
    const { orgId } = await setupOrg(userId);
    await seedBehaviorCount(
      orgId,
      userId,
      AUDIO_INPUT_BEHAVIOR_KEY,
      AUDIO_INPUT_FREE_QUOTA,
    );
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("should return allowed=false when a free org has exceeded the quota", async () => {
    const userId = uniqueId("quota-free-exceeded");
    const { orgId } = await setupOrg(userId);
    await seedBehaviorCount(
      orgId,
      userId,
      AUDIO_INPUT_BEHAVIOR_KEY,
      AUDIO_INPUT_FREE_QUOTA + 1,
    );
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: false,
      count: AUDIO_INPUT_FREE_QUOTA + 1,
      limit: AUDIO_INPUT_FREE_QUOTA,
    });
  });

  it("should return allowed=true with limit=null for a pro org regardless of history", async () => {
    const userId = uniqueId("quota-pro");
    const { orgId } = await setupOrg(userId);
    await updateOrgTier(orgId, "pro");
    await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 10);
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: true,
      count: 0,
      limit: null,
    });
  });

  it("should return allowed=true with limit=null for a team org", async () => {
    const userId = uniqueId("quota-team");
    const { orgId } = await setupOrg(userId);
    await updateOrgTier(orgId, "team");
    const response = await GET(createQuotaRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      allowed: true,
      count: 0,
      limit: null,
    });
  });
});
