import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { deviceCodes } from "../../../../../../src/db/schema/device-codes";
import { eq } from "drizzle-orm";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

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

// Characters used in device codes (excluding confusing ones like 0/O, 1/I/L)
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// Generate a unique 9-character device code (XXXX-XXXX format)
function generateUniqueCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

// Helper to create a device code in the database
async function createTestDeviceCode(options?: {
  status?: "pending" | "authenticated" | "expired" | "denied";
  expiresAt?: Date;
}) {
  const code = generateUniqueCode();
  const status = options?.status ?? "pending";
  const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000); // 15 min default

  await globalThis.services.db.insert(deviceCodes).values({
    code,
    status,
    expiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { code, status, expiresAt };
}

// Helper to get device code from database
async function getDeviceCode(code: string) {
  const [result] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.code, code))
    .limit(1);
  return result;
}

describe("/api/cli/auth/test-approve", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("USE_MOCK_CLAUDE", "true");
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    mockGetUserList.mockReset();
  });

  describe("environment gate", () => {
    it("should return 404 when USE_MOCK_CLAUDE is not set", async () => {
      vi.stubEnv("USE_MOCK_CLAUDE", "");

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
      const { code } = await createTestDeviceCode({
        status: "authenticated",
      });

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
      const { code } = await createTestDeviceCode({
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
      });

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
    });
  });

  describe("successful authentication", () => {
    it("should approve device code and update database", async () => {
      const testUserId = "user_test123";
      mockGetUserList.mockResolvedValue({
        data: [{ id: testUserId }],
      });

      const { code } = await createTestDeviceCode();

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

      // Verify database was updated
      const deviceCode = await getDeviceCode(code);
      expect(deviceCode?.status).toBe("authenticated");
      expect(deviceCode?.userId).toBe(testUserId);
    });

    it("should handle case-insensitive device codes", async () => {
      const testUserId = "user_test456";
      mockGetUserList.mockResolvedValue({
        data: [{ id: testUserId }],
      });

      const { code } = await createTestDeviceCode();

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

      const { code } = await createTestDeviceCode();

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

      const { code } = await createTestDeviceCode();

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
