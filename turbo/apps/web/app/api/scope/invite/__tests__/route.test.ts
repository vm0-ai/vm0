import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/scope/invite", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 400 for invalid email format", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/scope/invite",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid email");
  });

  it("should return 400 for missing email", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/scope/invite",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid email");
  });

  it("should return 400 for malformed JSON", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/scope/invite",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Invalid email");
  });

  it("should return 401 for unauthenticated request", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/scope/invite",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com" }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });
});
