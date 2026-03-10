import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestConnector,
  findTestConnectorSecret,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("POST /api/connectors/:type/token - Submit API Token", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/figma/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { FIGMA_TOKEN: "test-token" } }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should create connector via api-token", async () => {
    const user = await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/figma/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secrets: { FIGMA_TOKEN: "figd_test123" },
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe("figma");
    expect(data.authMethod).toBe("api-token");
    expect(data.externalId).toBeNull();
    expect(data.externalUsername).toBeNull();

    // Verify secret was stored
    const storedToken = await findTestConnectorSecret(
      user.scopeId,
      "FIGMA_TOKEN",
    );
    expect(storedToken).toBe("figd_test123");
  });

  it("should update existing oauth connector to api-token", async () => {
    const user = await context.setupUser();
    await createTestConnector(user.scopeId, {
      type: "figma",
      authMethod: "oauth",
      externalUsername: "figma-user",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/figma/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secrets: { FIGMA_TOKEN: "figd_updated" },
        }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.type).toBe("figma");
    expect(data.authMethod).toBe("api-token");
    // OAuth fields should be cleared
    expect(data.externalId).toBeNull();
    expect(data.externalUsername).toBeNull();
    expect(data.oauthScopes).toBeNull();

    // Verify updated secret
    const storedToken = await findTestConnectorSecret(
      user.scopeId,
      "FIGMA_TOKEN",
    );
    expect(storedToken).toBe("figd_updated");
  });

  it("should reject missing required secrets", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/figma/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: {} }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("Missing required secret");
  });

  it("should reject connector type without api-token support", async () => {
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/connectors/github/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { GH_TOKEN: "ghp_test" } }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("does not support api-token");
  });
});
