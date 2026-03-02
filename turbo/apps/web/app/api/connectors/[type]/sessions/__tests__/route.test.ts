import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET as getSessionStatus } from "../[sessionId]/route";
import {
  createTestRequest,
  createTestConnectorSession,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/connectors/:type/sessions - Create Session", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Authentication required");
  });

  it("should reject invalid connector type", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/invalid/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    // ts-rest validates connector type at contract level
    expect(data.message).toMatch(/validation failed/i);
  });

  it("should create session successfully", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBeDefined();
    expect(data.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(data.type).toBe("github");
    expect(data.status).toBe("pending");
    expect(data.verificationUrl).toContain("/api/connectors/github/authorize");
    expect(data.verificationUrl).toContain(`session=${data.id}`);
    expect(data.expiresIn).toBe(900); // 15 minutes
    expect(data.interval).toBe(5); // 5 seconds poll interval
  });
});

describe("GET /api/connectors/:type/sessions/:sessionId - Get Session Status", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    // Use a valid UUID format for sessionId
    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/sessions/00000000-0000-0000-0000-000000000000",
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Authentication required");
  });

  it("should return 404 for non-existent session", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/sessions/00000000-0000-0000-0000-000000000000",
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should return pending status for new session", async () => {
    await context.setupUser();

    // Create a session first
    const createRequest = createTestRequest(
      "http://localhost:3000/api/connectors/github/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();

    // Get session status
    const request = createTestRequest(
      `http://localhost:3000/api/connectors/github/sessions/${createData.id}`,
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("pending");
  });

  it("should return expired status for expired session", async () => {
    const user = await context.setupUser();

    // Create an expired session using the helper
    const expiredAt = new Date(Date.now() - 1000); // 1 second ago
    const session = await createTestConnectorSession(user.userId, "github", {
      status: "pending",
      expiresAt: expiredAt,
    });

    // Get session status
    const request = createTestRequest(
      `http://localhost:3000/api/connectors/github/sessions/${session.id}`,
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("expired");
    expect(data.errorMessage).toContain("expired");
  });

  it("should return complete status for completed session", async () => {
    const user = await context.setupUser();

    // Create a completed session using the helper
    const session = await createTestConnectorSession(user.userId, "github", {
      status: "complete",
      completedAt: new Date(),
    });

    // Get session status
    const request = createTestRequest(
      `http://localhost:3000/api/connectors/github/sessions/${session.id}`,
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("complete");
  });

  it("should return error status with message for failed session", async () => {
    const user = await context.setupUser();

    // Create an error session using the helper
    const session = await createTestConnectorSession(user.userId, "github", {
      status: "error",
      errorMessage: "OAuth failed: access denied",
    });

    // Get session status
    const request = createTestRequest(
      `http://localhost:3000/api/connectors/github/sessions/${session.id}`,
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("error");
    expect(data.errorMessage).toBe("OAuth failed: access denied");
  });

  it("should not return session from other users", async () => {
    // Create first user with session
    await context.setupUser();

    const createRequest = createTestRequest(
      "http://localhost:3000/api/connectors/github/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const createResponse = await POST(createRequest);
    const createData = await createResponse.json();

    // Create second user
    await context.setupUser({ prefix: "other-user" });

    // Try to get session as second user
    const request = createTestRequest(
      `http://localhost:3000/api/connectors/github/sessions/${createData.id}`,
    );
    const response = await getSessionStatus(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });
});
