import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";

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

describe("/api/cli/auth/test-token", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    mockGetUserList.mockReset();
    mockGetUserList.mockResolvedValue({
      data: [{ id: "user_test123" }],
    });
  });

  describe("environment-based access control", () => {
    it("allows access in local development (no VERCEL_ENV, NODE_ENV=development)", async () => {
      vi.stubEnv("VERCEL_ENV", "");
      vi.stubEnv("NODE_ENV", "development");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.access_token).toBeDefined();
      expect(data.token_type).toBe("Bearer");
    });

    it("allows access in preview with valid bypass secret", async () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass-secret");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        {
          method: "POST",
          headers: { "x-vercel-protection-bypass": "test-bypass-secret" },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it("denies access in preview without bypass header", async () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass-secret");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });

    it("denies access in preview with invalid bypass secret", async () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass-secret");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        {
          method: "POST",
          headers: { "x-vercel-protection-bypass": "wrong-secret" },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });

    it("denies access in preview when bypass secret is not configured", async () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        {
          method: "POST",
          headers: { "x-vercel-protection-bypass": "any-secret" },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });

    it("denies access in production", async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("NODE_ENV", "production");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });

    it("denies access in non-Vercel production (no VERCEL_ENV, NODE_ENV=production)", async () => {
      vi.stubEnv("VERCEL_ENV", "");
      vi.stubEnv("NODE_ENV", "production");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });

    it("denies access in unknown environment", async () => {
      vi.stubEnv("VERCEL_ENV", "unknown-env");
      vi.stubEnv("NODE_ENV", "production");

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });
  });

  describe("token generation", () => {
    beforeEach(() => {
      vi.stubEnv("VERCEL_ENV", "");
      vi.stubEnv("NODE_ENV", "development");
    });

    it("returns token with correct format", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.access_token).toMatch(/^vm0_live_/);
      expect(data.token_type).toBe("Bearer");
      expect(data.expires_in).toBe(90 * 24 * 60 * 60);
      expect(data.user_id).toBe("user_test123");
    });

    it("returns 500 when test user is not found", async () => {
      mockGetUserList.mockResolvedValue({ data: [] });

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("Test user not found");
    });

    it("calls Clerk with correct email address", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      await POST(request);

      expect(mockGetUserList).toHaveBeenCalledWith({
        emailAddress: ["e2e+clerk_test@vm0.ai"],
      });
    });
  });
});
