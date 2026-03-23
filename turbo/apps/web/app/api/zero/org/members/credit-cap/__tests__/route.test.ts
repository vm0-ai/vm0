import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestRequest,
  insertOrgMembersEntry,
  insertTestCreditUsage,
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
   * Helper to insert a processed credit_usage record via test helpers.
   */
  async function insertProcessedCreditUsage(
    orgId: string,
    userId: string,
    creditsCharged: number,
  ): Promise<void> {
    await insertTestCreditUsage(orgId, {
      userId,
      model: "claude-sonnet-4-20250514",
      modelProvider: "vm0",
      creditsCharged,
      status: "processed",
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

      // Insert processed credit usage exceeding the cap we'll set
      await insertProcessedCreditUsage(user.orgId, user.userId, 200);

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

    it("re-enables member when cap is raised above usage", async () => {
      const periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

      // Set up billing period
      await updateOrgStripeFields(user.orgId, { currentPeriodEnd: periodEnd });

      // Insert usage of 200
      await insertProcessedCreditUsage(user.orgId, user.userId, 200);

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
