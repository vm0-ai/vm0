import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  updateOrgTier,
  updateOrgAutoRecharge,
  getOrgAutoRechargeFields,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        invoices: {
          create: vi.fn(),
          finalizeInvoice: vi.fn(),
          pay: vi.fn(),
        },
        invoiceItems: { create: vi.fn() },
        subscriptions: { retrieve: vi.fn() },
        customers: { create: vi.fn() },
        checkout: { sessions: { create: vi.fn() } },
        billingPortal: { sessions: { create: vi.fn() } },
        webhooks: { constructEvent: vi.fn() },
      };
    },
  };
});

import { GET, PUT } from "../route";

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/billing/auto-recharge";

describe("/api/zero/billing/auto-recharge", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();
  });

  describe("GET", () => {
    it("returns 401 when the request is unauthenticated", async () => {
      mockClerk({ userId: null });

      const request = createTestRequest(BASE_URL);
      const response = await GET(request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          message: "Not authenticated",
          code: "UNAUTHORIZED",
        },
      });
    });

    it("returns 401 when the user has no active org", async () => {
      mockClerk({ userId: user.userId, orgId: null });

      const request = createTestRequest(BASE_URL);
      const response = await GET(request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toStrictEqual({
        error: {
          message: "Not authenticated",
          code: "UNAUTHORIZED",
        },
      });
    });

    it("returns default config for new org", async () => {
      const request = createTestRequest(BASE_URL);
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        enabled: false,
        threshold: null,
        amount: null,
      });
    });

    it("returns configured auto-recharge settings", async () => {
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 2000,
        autoRechargeAmount: 10000,
      });

      const request = createTestRequest(BASE_URL);
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({
        enabled: true,
        threshold: 2000,
        amount: 10000,
      });
    });
  });

  describe("PUT", () => {
    it("enables auto-recharge for pro tier org", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 1000,
          amount: 5000,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual({
        enabled: true,
        threshold: 1000,
        amount: 5000,
      });

      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargeEnabled).toBe(true);
      expect(fields?.autoRechargeThreshold).toBe(1000);
      expect(fields?.autoRechargeAmount).toBe(5000);
    });

    it("disables auto-recharge and clears pending state", async () => {
      await updateOrgTier(user.orgId, "pro");
      await updateOrgAutoRecharge(user.orgId, {
        autoRechargeEnabled: true,
        autoRechargeThreshold: 1000,
        autoRechargeAmount: 5000,
        autoRechargePendingAt: new Date(),
      });

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(200);

      const fields = await getOrgAutoRechargeFields(user.orgId);
      expect(fields?.autoRechargeEnabled).toBe(false);
      expect(fields?.autoRechargePendingAt).toBeNull();
    });

    it("returns 400 when enabling on free tier", async () => {
      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 1000,
          amount: 5000,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when enabling without threshold and amount", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when amount is below minimum", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 1000,
          amount: 500,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when amount exceeds the maximum", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 1000,
          amount: 10_000_001,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when threshold exceeds the maximum", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 10_000_001,
          amount: 20_000_000,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when threshold equals amount", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 5000,
          amount: 5000,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          message: "threshold must be less than amount to avoid recharge loops",
        },
      });
    });

    it("returns 400 when threshold is greater than amount", async () => {
      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 6000,
          amount: 5000,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          message: "threshold must be less than amount to avoid recharge loops",
        },
      });
    });

    it("returns 403 for non-admin member", async () => {
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:member",
      });

      await updateOrgTier(user.orgId, "pro");

      const request = createTestRequest(BASE_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          threshold: 1000,
          amount: 5000,
        }),
      });

      const response = await PUT(request);
      expect(response.status).toBe(403);
    });
  });
});
