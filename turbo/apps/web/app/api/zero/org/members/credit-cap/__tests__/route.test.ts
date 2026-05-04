import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestRequest,
  insertOrgMembersEntry,
  insertTestModelUsageEvent,
  insertTestUsageEvent,
  updateOrgStripeFields,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { GET, PUT } from "../route";

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/org/members/credit-cap";

describe("/api/zero/org/members/credit-cap", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  /**
   * Helper to insert processed model usage_event rows via test helpers.
   */
  async function insertProcessedModelUsage(
    orgId: string,
    userId: string,
    creditsCharged: number,
    processedAt?: Date,
  ): Promise<void> {
    await insertTestModelUsageEvent(orgId, {
      userId,
      model: "claude-sonnet-4-20250514",
      creditsCharged,
      status: "processed",
      processedAt,
    });
  }

  async function insertProcessedUsageEvent(
    orgId: string,
    userId: string,
    creditsCharged: number,
    processedAt?: Date,
  ): Promise<void> {
    await insertTestUsageEvent(orgId, {
      userId,
      status: "processed",
      creditsCharged,
      processedAt,
    });
  }

  describe("GET", () => {
    it("returns 401 for unauthenticated request", async () => {
      mockClerk({ userId: null });
      const request = createTestRequest(`${BASE_URL}?userId=${user.userId}`);
      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it("returns default cap state (null cap, enabled)", async () => {
      const request = createTestRequest(`${BASE_URL}?userId=${user.userId}`);
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: null,
        creditEnabled: true,
      });
    });

    it("returns 400 when userId is missing", async () => {
      const request = createTestRequest(BASE_URL);
      const response = await GET(request);

      expect(response.status).toBe(400);
    });
  });

  describe("PUT", () => {
    it("sets credit cap as admin", async () => {
      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 5000 }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: 5000,
        creditEnabled: true,
      });
    });

    it("disables member when cap is below current usage", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

      // Set up billing period
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      // Insert processed usage exceeding the cap we'll set
      await insertProcessedModelUsage(user.orgId, user.userId, 200);

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 100 }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });
    });

    it("disables member when usage_event spend exceeds cap", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      await insertProcessedModelUsage(user.orgId, user.userId, 80);
      await insertProcessedUsageEvent(user.orgId, user.userId, 40);

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 100 }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });
    });

    it("disables member when usage_event spend exactly reaches cap", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      await insertProcessedModelUsage(user.orgId, user.userId, 60);
      await insertProcessedUsageEvent(user.orgId, user.userId, 40);

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 100 }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });
    });

    it("ignores processed usage at the billing period end boundary", async () => {
      const periodEnd = new Date("2099-04-01T00:00:00Z");
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      await insertProcessedModelUsage(
        user.orgId,
        user.userId,
        40,
        new Date("2099-03-15T00:00:00Z"),
      );
      await insertProcessedUsageEvent(user.orgId, user.userId, 80, periodEnd);

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 100 }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: 100,
        creditEnabled: true,
      });
    });

    it("re-enables member when cap is raised above usage", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

      // Set up billing period
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      // Insert usage of 200
      await insertProcessedModelUsage(user.orgId, user.userId, 200);

      // First set cap below usage (disables)
      const request1 = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 100 }),
        headers: { "content-type": "application/json" },
      });
      const response1 = await PUT(request1);
      expect((await response1.json()).creditEnabled).toBe(false);

      // Raise cap above usage (re-enables)
      const request2 = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: 500 }),
        headers: { "content-type": "application/json" },
      });
      const response2 = await PUT(request2);

      expect(response2.status).toBe(200);
      const data = await response2.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: 500,
        creditEnabled: true,
      });
    });

    it("removes cap and re-enables with null", async () => {
      // First disable the member
      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      // Set cap to null (removes and re-enables)
      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ userId: user.userId, creditCap: null }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        userId: user.userId,
        creditCap: null,
        creditEnabled: true,
      });
    });

    it("returns 403 for non-admin", async () => {
      // Create a non-admin user
      const nonAdmin = await context.setupUser({ prefix: "member" });
      mockClerk({
        userId: nonAdmin.userId,
        orgRole: "org:member",
      });

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({
          userId: user.userId,
          creditCap: 5000,
        }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(403);
    });

    it("returns 400 for invalid body", async () => {
      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        body: JSON.stringify({ creditCap: 5000 }),
        headers: { "content-type": "application/json" },
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });
  });
});
