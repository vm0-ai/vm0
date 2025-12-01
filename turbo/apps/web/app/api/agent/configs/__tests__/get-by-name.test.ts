/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { initServices } from "../../../../../src/lib/init-services";
import { agentConfigs } from "../../../../../src/db/schema/agent-config";
import { eq } from "drizzle-orm";

// Mock the auth module
let mockUserId = "test-user-get-by-name";
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("GET /api/agent/configs?name=<name>", () => {
  const testUserId = "test-user-get-by-name";

  beforeAll(() => {
    initServices();
  });

  afterAll(async () => {
    // Cleanup: Delete test configs
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.userId, testUserId));
  });

  it("should return config when name exists", async () => {
    // Create a test config
    const config = {
      version: "1.0",
      agents: {
        "test-get-by-name-success": {
          description: "Test description",
          image: "vm0-claude-code-dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = new Request(
      "http://localhost:3000/api/agent/configs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ config }),
      },
    );

    const createResponse = await POST(createRequest as NextRequest);
    const createData = await createResponse.json();
    expect(createResponse.status).toBe(201);

    // Now get it by name
    const getRequest = new Request(
      "http://localhost:3000/api/agent/configs?name=test-get-by-name-success",
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(createData.configId);
    expect(getData.name).toBe("test-get-by-name-success");
    expect(getData.config.agents["test-get-by-name-success"]).toBeDefined();
    expect(getData.config.agents["test-get-by-name-success"].description).toBe(
      "Test description",
    );
    expect(getData.createdAt).toBeDefined();
    expect(getData.updatedAt).toBeDefined();

    // Cleanup
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, createData.configId));
  });

  it("should return 400 when name does not exist", async () => {
    const getRequest = new Request(
      "http://localhost:3000/api/agent/configs?name=nonexistent-agent",
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Agent config not found");
    expect(getData.error.message).toContain("nonexistent-agent");
  });

  it("should return 400 when name query parameter is missing", async () => {
    const getRequest = new Request("http://localhost:3000/api/agent/configs", {
      method: "GET",
    });

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Missing name query parameter");
  });

  it("should only return config for authenticated user", async () => {
    // Create config as user 1
    mockUserId = "user-1-isolation";
    const config = {
      version: "1.0",
      agents: {
        "test-user-isolation": {
          description: "Test",
          image: "vm0-claude-code-dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = new Request(
      "http://localhost:3000/api/agent/configs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ config }),
      },
    );

    const createResponse = await POST(createRequest as NextRequest);
    expect(createResponse.status).toBe(201);

    // Try to get it as user 2
    mockUserId = "user-2-isolation";
    const getRequest = new Request(
      "http://localhost:3000/api/agent/configs?name=test-user-isolation",
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Agent config not found");

    // Cleanup
    mockUserId = "user-1-isolation";
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.userId, "user-1-isolation"));
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.userId, "user-2-isolation"));

    // Reset mockUserId
    mockUserId = "test-user-get-by-name";
  });

  it("should handle URL-encoded names correctly", async () => {
    // Create a test config with hyphens
    const config = {
      version: "1.0",
      agents: {
        "test-agent-with-hyphens": {
          description: "Test description",
          image: "vm0-claude-code-dev",
          provider: "claude-code",
          working_dir: "/home/user/workspace",
        },
      },
    };

    const createRequest = new Request(
      "http://localhost:3000/api/agent/configs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ config }),
      },
    );

    const createResponse = await POST(createRequest as NextRequest);
    const createData = await createResponse.json();
    expect(createResponse.status).toBe(201);

    // Get it with URL-encoded name
    const encodedName = encodeURIComponent("test-agent-with-hyphens");
    const getRequest = new Request(
      `http://localhost:3000/api/agent/configs?name=${encodedName}`,
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.name).toBe("test-agent-with-hyphens");

    // Cleanup
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, createData.configId));
  });
});
