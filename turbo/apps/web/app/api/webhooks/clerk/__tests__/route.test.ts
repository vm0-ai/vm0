import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock @clerk/nextjs/webhooks (external dependency)
const mockVerifyWebhook = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: mockVerifyWebhook,
}));

// Import route handler AFTER mocks are set up
import { POST } from "../route";

/** Helper to send a webhook request through the route */
function createWebhookRequest(): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /api/webhooks/clerk", () => {
  it("returns 401 when signature verification fails", async () => {
    mockVerifyWebhook.mockRejectedValue(new Error("Invalid signature"));

    const response = await POST(createWebhookRequest());

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Invalid webhook signature");
  });

  it("returns 200 for organization.deleted event", async () => {
    mockVerifyWebhook.mockResolvedValue({
      type: "organization.deleted",
      data: { object: "organization", id: "org_test123", deleted: true },
    });

    const response = await POST(createWebhookRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
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
});
