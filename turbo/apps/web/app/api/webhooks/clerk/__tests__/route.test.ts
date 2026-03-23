import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import * as externalCleanup from "../../../../../src/lib/org/org-external-cleanup";
import * as s3Cleanup from "../../../../../src/lib/org/org-s3-cleanup";
import * as dbCleanup from "../../../../../src/lib/org/org-deletion-service";

// Mock @clerk/nextjs/webhooks (external dependency)
const mockVerifyWebhook = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: mockVerifyWebhook,
}));

// Import route handler AFTER mocks are set up
import { POST } from "../route";

const context = testContext();

/** Helper to send a webhook request through the route */
function createWebhookRequest(): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /api/webhooks/clerk", () => {
  let spyCleanupExternal: ReturnType<typeof vi.spyOn>;
  let spyDeleteS3: ReturnType<typeof vi.spyOn>;
  let spyDeleteOrgData: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    context.setupMocks();
    spyCleanupExternal = vi
      .spyOn(externalCleanup, "cleanupOrgExternalServices")
      .mockResolvedValue(undefined);
    spyDeleteS3 = vi
      .spyOn(s3Cleanup, "deleteOrgS3Data")
      .mockResolvedValue(undefined);
    spyDeleteOrgData = vi
      .spyOn(dbCleanup, "deleteOrgData")
      .mockResolvedValue(undefined);
  });

  it("returns 401 when signature verification fails", async () => {
    mockVerifyWebhook.mockRejectedValue(new Error("Invalid signature"));

    const response = await POST(createWebhookRequest());

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Invalid webhook signature");
  });

  it("returns 200 for unhandled event types", async () => {
    mockVerifyWebhook.mockResolvedValue({
      type: "user.created",
      data: { id: "user_test123" },
    });

    const response = await POST(createWebhookRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("calls verifyWebhook with the request", async () => {
    mockVerifyWebhook.mockResolvedValue({
      type: "user.created",
      data: { id: "user_test123" },
    });

    const request = createWebhookRequest();
    await POST(request);

    expect(mockVerifyWebhook).toHaveBeenCalledWith(request);
  });

  describe("organization.deleted cleanup", () => {
    it("calls all cleanup functions in correct order", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organization.deleted",
        data: { object: "organization", id: "org_test123", deleted: true },
      });

      const callOrder: string[] = [];
      spyCleanupExternal.mockImplementation(async () => {
        callOrder.push("external");
      });
      spyDeleteS3.mockImplementation(async () => {
        callOrder.push("s3");
      });
      spyDeleteOrgData.mockImplementation(async () => {
        callOrder.push("db");
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(spyCleanupExternal).toHaveBeenCalledWith("org_test123");
      expect(spyDeleteS3).toHaveBeenCalledWith("org_test123");
      expect(spyDeleteOrgData).toHaveBeenCalledWith("org_test123");
      expect(callOrder).toEqual(["external", "s3", "db"]);
    });

    it("handles missing org ID gracefully", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organization.deleted",
        data: { object: "organization", id: undefined, deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(spyCleanupExternal).not.toHaveBeenCalled();
      expect(spyDeleteS3).not.toHaveBeenCalled();
      expect(spyDeleteOrgData).not.toHaveBeenCalled();
    });

    it("catches cleanup errors without affecting response", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organization.deleted",
        data: { object: "organization", id: "org_fail", deleted: true },
      });
      spyCleanupExternal.mockRejectedValue(new Error("external failed"));

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      // flushAfter should not throw — error is caught inside the after() callback
      await expect(context.mocks.flushAfter()).resolves.toBeUndefined();
    });
  });

  describe("organizationMembership.deleted", () => {
    it("returns 200 without calling cleanup functions", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organizationMembership.deleted",
        data: {
          object: "organization_membership",
          organization: { id: "org_test123" },
          public_user_data: { user_id: "user_test456" },
        },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();

      expect(spyCleanupExternal).not.toHaveBeenCalled();
      expect(spyDeleteS3).not.toHaveBeenCalled();
      expect(spyDeleteOrgData).not.toHaveBeenCalled();
    });
  });
});
