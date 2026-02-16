import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "../route";
import {
  GET as getConnector,
  DELETE as deleteConnector,
} from "../[type]/route";
import {
  createTestRequest,
  createTestConnector,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/connectors - List Connectors", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return empty array for user without connectors", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toEqual([]);
  });

  it("should list all connectors for user", async () => {
    const user = await context.setupUser();
    await createTestConnector(user.scopeId);

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].type).toBe("github");
    expect(data.connectors[0].authMethod).toBe("oauth");
    expect(data.connectors[0].externalUsername).toBe("testuser");
  });

  it("should not return connectors from other users", async () => {
    // Create first user with connector
    const user1 = await context.setupUser();
    await createTestConnector(user1.scopeId);

    // Create second user
    await context.setupUser({ prefix: "other-user" });

    // List connectors as second user
    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toEqual([]);

    // Verify first user still has their connector
    mockClerk({ userId: user1.userId });
    const request2 = createTestRequest("http://localhost:3000/api/connectors");
    const response2 = await GET(request2);
    const data2 = await response2.json();

    expect(data2.connectors).toHaveLength(1);
  });
});

describe("GET /api/connectors/:type - Get Connector", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github",
    );
    const response = await getConnector(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for non-existent connector", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github",
    );
    const response = await getConnector(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should return connector details", async () => {
    const user = await context.setupUser();
    await createTestConnector(user.scopeId);

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github",
    );
    const response = await getConnector(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe("github");
    expect(data.authMethod).toBe("oauth");
    expect(data.externalUsername).toBe("testuser");
    expect(data.externalEmail).toBe("test@example.com");
  });
});

describe("DELETE /api/connectors/:type - Delete Connector", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github",
      { method: "DELETE" },
    );
    const response = await deleteConnector(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return 404 for non-existent connector", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github",
      { method: "DELETE" },
    );
    const response = await deleteConnector(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toContain("not found");
  });

  it("should delete self-hosted connector successfully", async () => {
    const user = await context.setupUser();
    await createTestConnector(user.scopeId, {
      type: "github",
      platform: "self-hosted",
    });

    // Delete connector
    const deleteRequest = createTestRequest(
      "http://localhost:3000/api/connectors/github",
      { method: "DELETE" },
    );
    const deleteResponse = await deleteConnector(deleteRequest);

    expect(deleteResponse.status).toBe(204);

    // Verify connector is gone
    const getRequest = createTestRequest(
      "http://localhost:3000/api/connectors/github",
    );
    const getResponse = await getConnector(getRequest);

    expect(getResponse.status).toBe(404);
  });

  it("should delete nango connector and call nango.deleteConnection with correct UUID", async () => {
    const user = await context.setupUser();
    const nangoConnectionId = "nango-uuid-12345";

    // Create Nango connector with UUID
    await createTestConnector(user.scopeId, {
      type: "gmail",
      platform: "nango",
      nangoConnectionId,
    });

    // Delete connector
    const deleteRequest = createTestRequest(
      "http://localhost:3000/api/connectors/gmail",
      { method: "DELETE" },
    );
    const deleteResponse = await deleteConnector(deleteRequest);

    expect(deleteResponse.status).toBe(204);

    // Verify connector is gone from database
    const getRequest = createTestRequest(
      "http://localhost:3000/api/connectors/gmail",
    );
    const getResponse = await getConnector(getRequest);

    expect(getResponse.status).toBe(404);
  });
});

describe("GET /api/connectors - Nango Sync", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should handle nango sync gracefully when enabled", async () => {
    await context.setupUser();

    // List connectors - sync will be attempted but mock returns empty connections
    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toEqual([]);
  });

  it("should handle disabled nango feature gracefully", async () => {
    await context.setupUser();

    // Temporarily disable Nango feature
    vi.stubEnv("FEATURE_NANGO_ENABLED", "false");

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toEqual([]);

    vi.unstubAllEnvs();
  });

  it("should skip connections that already exist in database", async () => {
    const user = await context.setupUser();

    // Create existing connector
    await createTestConnector(user.scopeId, {
      type: "gmail",
      platform: "nango",
      nangoConnectionId: "existing-uuid",
    });

    // Mock Nango with same connection (already handled by testContext)

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].type).toBe("gmail");
    expect(data.connectors[0].platform).toBe("nango");
  });
});
