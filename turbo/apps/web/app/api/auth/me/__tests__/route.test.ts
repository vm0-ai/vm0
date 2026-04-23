import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../src/lib/auth/sandbox-token";

const context = testContext();

describe("GET /api/auth/me", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest("http://localhost:3000/api/auth/me"),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return authenticated user info with email", async () => {
    const response = await GET(
      createTestRequest("http://localhost:3000/api/auth/me"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("error");
    expect(body.email).toBe("test@example.com");
  });

  describe("sandbox token support", () => {
    it("sandbox token with any capability returns user info", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-123",
        "org-test",
      );

      const response = await GET(
        createTestRequest("http://localhost:3000/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.userId).toBe(user.userId);
    });

    it("sandbox token with storage:write returns user info", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-456",
        "org-test",
      );

      const response = await GET(
        createTestRequest("http://localhost:3000/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.userId).toBe(user.userId);
    });

    it("sandbox token with no capabilities is accepted (acceptAnySandboxCapability)", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-789",
        "org-test",
      );

      const response = await GET(
        createTestRequest("http://localhost:3000/api/auth/me", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.userId).toBe(user.userId);
    });
  });
});
