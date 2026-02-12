import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { POST as createDeviceRoute } from "../../device/route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

// Mock Clerk Server API
const mockGetUserList = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUserList: mockGetUserList,
    },
  })),
  auth: vi.fn(),
}));

const context = testContext();

/**
 * Create a device code via the device endpoint
 */
async function createTestDeviceCode(): Promise<string> {
  const request = createTestRequest(
    "http://localhost:3000/api/cli/auth/device",
    { method: "POST" },
  );
  const response = await createDeviceRoute(request);
  const data = await response.json();
  return data.device_code;
}

describe("/api/cli/auth/test-approve", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("USE_MOCK_CLAUDE", "true");
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    reloadEnv();
    mockGetUserList.mockReset();
  });

  describe("environment gate", () => {
    it("should return 404 when USE_MOCK_CLAUDE is not set", async () => {
      vi.stubEnv("USE_MOCK_CLAUDE", "");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: "TEST-CODE" }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });

    it("should return 404 when USE_MOCK_CLAUDE is false", async () => {
      vi.stubEnv("USE_MOCK_CLAUDE", "false");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: "TEST-CODE" }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("validation", () => {
    it("should return 400 when device_code is missing", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("device_code required");
    });

    it("should return 404 when device_code does not exist", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: "XXXX-XXXX" }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("device code status", () => {
    it("should return 400 when device code is not pending", async () => {
      // Create and approve a device code first
      const code = await createTestDeviceCode();
      mockGetUserList.mockResolvedValue({ data: [{ id: "user_setup" }] });

      const approveRequest = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: code }),
        },
      );
      await POST(approveRequest);

      // Now try to approve again — should fail
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: code }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Device code is not in pending status");
    });

    it("should return 400 when device code is expired", async () => {
      // Create device code with real time
      const code = await createTestDeviceCode();

      // Use fake timers to simulate time passage.
      // Note: This is one of the rare cases where fake timers are necessary
      // because the code under test uses `new Date()` constructor for comparison,
      // which cannot be mocked with vi.spyOn(Date, "now").
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + 16 * 60 * 1000);

        const request = createTestRequest(
          "http://localhost:3000/api/cli/auth/test-approve",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: code }),
          },
        );

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toBe("Device code has expired");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("successful authentication", () => {
    it("should approve device code and return success", async () => {
      const testUserId = "user_test123";
      mockGetUserList.mockResolvedValue({
        data: [{ id: testUserId }],
      });

      const code = await createTestDeviceCode();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: code }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.userId).toBe(testUserId);
    });

    it("should handle case-insensitive device codes", async () => {
      const testUserId = "user_test456";
      mockGetUserList.mockResolvedValue({
        data: [{ id: testUserId }],
      });

      const code = await createTestDeviceCode();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: code.toLowerCase() }), // lowercase input
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.userId).toBe(testUserId);
    });
  });

  describe("Clerk integration", () => {
    it("should return 500 when test user is not found", async () => {
      mockGetUserList.mockResolvedValue({
        data: [],
      });

      const code = await createTestDeviceCode();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: code }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Test user not found");
    });

    it("should call Clerk with correct email address", async () => {
      mockGetUserList.mockResolvedValue({
        data: [{ id: "user_test789" }],
      });

      const code = await createTestDeviceCode();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: code }),
        },
      );

      await POST(request);

      expect(mockGetUserList).toHaveBeenCalledWith({
        emailAddress: ["e2e+clerk_test@vm0.ai"],
      });
    });
  });
});
