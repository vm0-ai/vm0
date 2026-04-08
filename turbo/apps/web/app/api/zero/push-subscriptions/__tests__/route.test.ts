import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

function registerSubscription(body: Record<string, unknown>) {
  return POST(
    createTestRequest("http://localhost:3000/api/zero/push-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const validBody = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-123",
  keys: {
    p256dh:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI",
    auth: "tBHItJI5svbpC7hYyKw",
  },
};

describe("POST /api/zero/push-subscriptions", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });
    const response = await registerSubscription(validBody);
    expect(response.status).toBe(401);
  });

  it("should register a push subscription", async () => {
    await context.setupUser();
    const response = await registerSubscription(validBody);
    expect(response.status).toBe(201);

    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it("should upsert on same endpoint", async () => {
    await context.setupUser();

    // Register first
    const first = await registerSubscription(validBody);
    expect(first.status).toBe(201);

    // Register again with updated keys — should not fail
    const updatedBody = {
      ...validBody,
      keys: { p256dh: "updated-p256dh-key", auth: "updated-auth-key" },
    };
    const second = await registerSubscription(updatedBody);
    expect(second.status).toBe(201);
  });

  it("should reject invalid body", async () => {
    await context.setupUser();
    const response = await registerSubscription({
      endpoint: "not-a-url",
      keys: { p256dh: "", auth: "" },
    });
    expect(response.status).toBe(400);
  });
});
