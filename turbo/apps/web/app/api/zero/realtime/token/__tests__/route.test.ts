import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { mockAblyCreateTokenRequest } from "../../../../../../src/__tests__/ably-mock";
import { reloadEnv } from "../../../../../../src/env";

const context = testContext();

describe("POST /api/zero/realtime/token", () => {
  beforeEach(async () => {
    mockAblyCreateTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: 1700000000000,
      capability: '{"user:test-user-id":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    });
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 for unauthenticated requests", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/realtime/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Authentication required");
  });

  it("should return 500 when ABLY_API_KEY is not configured", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/realtime/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error.message).toContain("Realtime service unavailable");
  });

  it("should return an Ably token for authenticated users", async () => {
    vi.stubEnv("ABLY_API_KEY", "test-api-key");
    reloadEnv();

    const request = createTestRequest(
      "http://localhost:3000/api/zero/realtime/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.keyName).toBe("test-key");
    expect(data.nonce).toBe("test-nonce");
    expect(data.mac).toBe("test-mac");
  });
});
