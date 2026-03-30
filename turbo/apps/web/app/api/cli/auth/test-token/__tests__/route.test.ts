import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { DEFAULT_TEST_EMAIL } from "../../../../../../src/lib/auth/test-user";
import {
  createTestRequest,
  insertOrgCacheEntry,
  ensureOrgRow,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

// Mock Clerk Server API
const mockGetUserList = vi.fn();
const mockGetOrganizationMembershipList = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUserList: mockGetUserList,
      getOrganizationMembershipList: mockGetOrganizationMembershipList,
    },
  })),
  auth: vi.fn(async () => ({ userId: null, orgId: null, orgRole: null })),
}));

const context = testContext();

describe("/api/cli/auth/test-token", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    reloadEnv();
    mockGetUserList.mockReset();
    mockGetOrganizationMembershipList.mockReset();
    mockGetUserList.mockResolvedValue({
      data: [{ id: "user_test123" }],
    });
    // Return a Clerk org membership so ensureTestOrg can discover a local org
    mockGetOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: {
            id: "org_test_token",
            slug: "test-token-org",
            name: "test-token-org",
          },
          role: "org:admin",
          publicUserData: { userId: "user_test123" },
        },
      ],
    });
    // Pre-populate org_cache so getOrgData() resolves without hitting Clerk API
    await insertOrgCacheEntry({
      orgId: "org_test_token",
      slug: "test-token-org",
    });
    await ensureOrgRow("org_test_token");
  });

  describe("environment-based access control", () => {
    it("allows access in local development (no VERCEL_ENV, NODE_ENV=development)", async () => {
      vi.stubEnv("VERCEL_ENV", "");
      vi.stubEnv("NODE_ENV", "development");
      reloadEnv();

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
      reloadEnv();

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
      reloadEnv();

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
      reloadEnv();

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
      reloadEnv();

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
      reloadEnv();

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
      reloadEnv();

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
      reloadEnv();
    });

    it("returns token with correct format and org_slug", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(data.access_token).toMatch(/^vm0_pat_/);
      expect(data.token_type).toBe("Bearer");
      expect(data.expires_in).toBe(90 * 24 * 60 * 60);
      expect(data.user_id).toBe("user_test123");
      expect(data.org_slug).toBe("test-token-org");
    });

    it("throws when test user is not found", async () => {
      mockGetUserList.mockResolvedValue({ data: [] });

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      await expect(POST(request)).rejects.toThrow(
        "Test user not found for email:",
      );
    });

    it("calls Clerk with default email address", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token",
        { method: "POST" },
      );

      await POST(request);

      expect(mockGetUserList).toHaveBeenCalledWith({
        emailAddress: [DEFAULT_TEST_EMAIL],
      });
    });

    it("calls Clerk with custom email via query param", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-token?email=custom%40test.com",
        { method: "POST" },
      );

      await POST(request);

      expect(mockGetUserList).toHaveBeenCalledWith({
        emailAddress: ["custom@test.com"],
      });
    });
  });
});
