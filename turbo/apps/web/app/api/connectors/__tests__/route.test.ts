import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
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
import { handlers, http } from "../../../../src/__tests__/msw";
import { server } from "../../../../src/mocks/server";

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
    expect(data.connectorProvidedSecretNames).toEqual([]);
  });

  it("should list all connectors for user", async () => {
    await context.setupUser();
    await createTestConnector();

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectors).toHaveLength(1);
    expect(data.connectors[0].type).toBe("github");
    expect(data.connectors[0].authMethod).toBe("oauth");
    expect(data.connectors[0].externalUsername).toBe("testuser");
  });

  it("should return connector-provided secret names", async () => {
    await context.setupUser();
    await createTestConnector({ type: "github" });

    const request = createTestRequest("http://localhost:3000/api/connectors");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.connectorProvidedSecretNames).toEqual(
      expect.arrayContaining(["GH_TOKEN", "GITHUB_TOKEN"]),
    );
    expect(data.connectorProvidedSecretNames).toHaveLength(2);
  });

  it("should not return connectors from other users", async () => {
    // Create first user with connector
    const user1 = await context.setupUser();
    await createTestConnector();

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
    await context.setupUser();
    await createTestConnector();

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

  it("should delete connector and revoke remote token", async () => {
    await context.setupUser();
    await createTestConnector({ type: "github" });

    // Mock the revocation endpoint AFTER connector setup (so it doesn't interfere with OAuth callback)
    const { mocked, handlers: mswHandlers } = handlers({
      revokeGrant: http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        () => new HttpResponse(null, { status: 204 }),
      ),
    });
    server.use(...mswHandlers);

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

    // Verify revocation was called
    expect(mocked.revokeGrant).toHaveBeenCalledTimes(1);
  });

  it("should delete connector even when revocation fails", async () => {
    await context.setupUser();
    await createTestConnector({ type: "github" });

    // Mock the revocation endpoint to return 500 AFTER connector setup
    const { handlers: mswHandlers } = handlers({
      revokeGrant: http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        () => new HttpResponse(null, { status: 500 }),
      ),
    });
    server.use(...mswHandlers);

    // Delete connector should still succeed
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
});

describe("Dropbox auth URL - force_reapprove", () => {
  it("should include force_reapprove=true in authorization URL", async () => {
    const { buildDropboxAuthorizationUrl } = await import(
      "../../../../src/lib/connector/providers/dropbox"
    );
    const url = buildDropboxAuthorizationUrl(
      "test-client-id",
      "http://localhost:3000/callback",
      "test-state",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("force_reapprove")).toBe("true");
  });
});
