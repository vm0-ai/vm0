import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/connectors/:type/create-session", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/gmail/create-session",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ type: "gmail" }),
    });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toContain("Not authenticated");
  });

  it("should return 400 for invalid connector type", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/invalid/create-session",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ type: "invalid" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Unknown connector type");
  });

  it("should return 400 for computer connector", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/computer/create-session",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ type: "computer" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("Computer connector does not use OAuth");
  });

  it("should return 400 for self-hosted connectors", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/create-session",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ type: "github" }),
    });
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("does not support Connect Session");
  });

  it("should create nango connect session successfully", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/gmail/create-session",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ type: "gmail" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sessionToken).toBe("test-session-token");
  });

  it("should return session token for gmail connector", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/gmail/create-session",
      { method: "POST" },
    );
    const response = await POST(request, {
      params: Promise.resolve({ type: "gmail" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sessionToken).toBe("test-session-token");
  });
});
