import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  insertOrgCacheEntry,
  ensureOrgRow,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";
import { DEFAULT_TEST_EMAIL } from "../../../../../../src/lib/auth/test-user";

// Mock Clerk Server API
const mockGetUserList = vi.fn();
const mockCreateUser = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUserList: mockGetUserList,
      createUser: mockCreateUser,
    },
  })),
  auth: vi.fn(async () => ({ userId: null, orgId: null, orgRole: null })),
}));

const context = testContext();

const TEST_ORG_ID = "org_connector_test";
const TEST_ORG_SLUG = "connector-test-org";
const TEST_USER_ID = "user_connector_test123";

describe("/api/cli/auth/test-connector", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("CLERK_SECRET_KEY", "test-secret-key");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    reloadEnv();
    mockGetUserList.mockReset();
    mockCreateUser.mockReset();
    mockGetUserList.mockResolvedValue({
      data: [{ id: TEST_USER_ID }],
    });

    // Pre-populate org cache and membership so test-connector can resolve the org
    await insertOrgCacheEntry({ orgId: TEST_ORG_ID, slug: TEST_ORG_SLUG });
    await ensureOrgRow(TEST_ORG_ID);
    await insertOrgMembersCacheEntry({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      role: "admin",
    });
  });

  describe("environment gate", () => {
    it("returns 404 in production", async () => {
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("NODE_ENV", "production");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "github",
            accessToken: "gho_test",
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });

    it("returns 404 in preview without bypass header", async () => {
      vi.stubEnv("VERCEL_ENV", "preview");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-secret");
      reloadEnv();

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "github",
            accessToken: "gho_test",
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(404);
    });
  });

  describe("input validation", () => {
    it("returns 400 for invalid JSON body", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid JSON body");
    });

    it("returns 400 when connectorName is missing", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: "gho_test" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("connectorName and accessToken are required");
    });

    it("returns 400 when accessToken is missing", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectorName: "github" }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("connectorName and accessToken are required");
    });

    it("returns 400 for unknown connector type", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "not-a-real-connector",
            accessToken: "some-token",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain("not-a-real-connector");
    });
  });

  describe("org resolution", () => {
    it("returns 400 when user has no org in org_members_cache", async () => {
      // Use a user ID not in org_members_cache
      mockGetUserList.mockResolvedValue({
        data: [{ id: "user_no_org" }],
      });

      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "github",
            accessToken: "gho_test",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Test user has no org — run test-token first");
    });
  });

  describe("successful connector setup", () => {
    it("creates connector and returns ok with connectorType and orgId", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "github",
            accessToken: "gho_test_token",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.connectorType).toBe("github");
      expect(data.orgId).toBe(TEST_ORG_ID);
    });

    it("uses default email when email param is absent", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/cli/auth/test-connector",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "github",
            accessToken: "gho_test_token",
          }),
        },
      );

      await POST(request);

      expect(mockGetUserList).toHaveBeenCalledWith({
        emailAddress: [DEFAULT_TEST_EMAIL],
      });
    });

    it("uses provided email param", async () => {
      const email = "pr-99+clerk_test@runner.test";
      const userIdForEmail = "user_email_test";
      mockGetUserList.mockResolvedValue({ data: [{ id: userIdForEmail }] });

      // Pre-populate org membership for this user
      await insertOrgMembersCacheEntry({
        orgId: TEST_ORG_ID,
        userId: userIdForEmail,
        role: "admin",
      });

      const request = createTestRequest(
        `http://localhost:3000/api/cli/auth/test-connector?email=${encodeURIComponent(email)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectorName: "github",
            accessToken: "gho_test_token",
          }),
        },
      );

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(mockGetUserList).toHaveBeenCalledWith({
        emailAddress: [email],
      });
    });
  });
});
