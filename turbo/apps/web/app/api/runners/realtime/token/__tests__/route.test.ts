import { describe, it, expect, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCliToken,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockAblyCreateTokenRequest } from "../../../../../../src/__tests__/ably-mock";

const context = testContext();

const OFFICIAL_RUNNER_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeRequest(
  body: Record<string, unknown>,
  authorization?: string,
): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authorization) {
    headers["Authorization"] = authorization;
  }
  return createTestRequest("http://localhost:3000/api/runners/realtime/token", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/runners/realtime/token", () => {
  let user: UserContext;

  beforeEach(async () => {
    mockAblyCreateTokenRequest.mockResolvedValue({
      keyName: "test-key",
      timestamp: 1700000000000,
      capability: '{"runner-group:vm0/production":["subscribe"]}',
      nonce: "test-nonce",
      mac: "test-mac",
    });
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("Authentication (401)", () => {
    it("should return 401 with no Authorization header", async () => {
      const response = await POST(makeRequest({ group: "vm0/production" }));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Authentication required");
    });

    it("should return 401 with non-Bearer token", async () => {
      const response = await POST(
        makeRequest({ group: "vm0/production" }, "Basic sometoken"),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Authentication required");
    });

    it("should return 401 with invalid CLI token", async () => {
      const response = await POST(
        makeRequest(
          { group: "vm0/production" },
          "Bearer invalid_nonexistent_token",
        ),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Authentication required");
    });

    it("should return 401 with expired CLI token", async () => {
      const expiredToken = await createTestCliToken(
        user.userId,
        new Date(Date.now() - 1000),
      );

      const response = await POST(
        makeRequest({ group: "vm0/production" }, `Bearer ${expiredToken}`),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.message).toContain("Authentication required");
    });
  });

  describe("Authorization (403)", () => {
    it("should return 403 when official runner requests non-vm0 group", async () => {
      const token = `vm0_official_${OFFICIAL_RUNNER_SECRET}`;

      const response = await POST(
        makeRequest({ group: "other-org/default" }, `Bearer ${token}`),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.message).toContain(
        "Official runners can only subscribe to vm0/* groups",
      );
    });

    it("should return 403 when user runner requests group from wrong org", async () => {
      const token = await createTestCliToken(user.userId);

      const response = await POST(
        makeRequest({ group: "wrong-org/default" }, `Bearer ${token}`),
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });
  });

  describe("Success (200)", () => {
    it("should return Ably TokenRequest for official runner with vm0 group", async () => {
      const token = `vm0_official_${OFFICIAL_RUNNER_SECRET}`;

      const response = await POST(
        makeRequest({ group: "vm0/production" }, `Bearer ${token}`),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keyName).toBe("test-key");
      expect(data.nonce).toBe("test-nonce");
      expect(data.mac).toBe("test-mac");
    });

    it("should return Ably TokenRequest for user runner with vm0 group", async () => {
      const token = await createTestCliToken(user.userId);

      const response = await POST(
        makeRequest({ group: "vm0/production" }, `Bearer ${token}`),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.keyName).toBe("test-key");
      expect(data.nonce).toBe("test-nonce");
    });
  });

  describe("Token generation failures (500)", () => {
    it("should return 500 when Ably token generation fails", async () => {
      const token = `vm0_official_${OFFICIAL_RUNNER_SECRET}`;

      mockAblyCreateTokenRequest.mockRejectedValueOnce(
        new Error("Token gen failed"),
      );

      const response = await POST(
        makeRequest({ group: "vm0/production" }, `Bearer ${token}`),
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.message).toContain("An internal error occurred");
    });
  });
});
