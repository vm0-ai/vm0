import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/auth/me", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
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
});
