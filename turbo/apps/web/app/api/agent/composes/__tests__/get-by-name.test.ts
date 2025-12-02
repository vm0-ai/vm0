/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

// Mock the auth module
let mockUserId = "test-user-get-by-name";
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("GET /api/agent/composes?name=<name>", () => {
  const testUserId = "test-user-get-by-name";

  beforeAll(() => {
    initServices();
  });

  afterAll(async () => {
    // Cleanup: Delete test composes
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });

  it("should return compose when name exists", async () => {
    // Create a test compose
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
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest as NextRequest);
    const createData = await createResponse.json();
    expect(createResponse.status).toBe(201);

    // Now get it by name
    const getRequest = new Request(
      "http://localhost:3000/api/agent/composes?name=test-get-by-name-success",
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(createData.composeId);
    expect(getData.name).toBe("test-get-by-name-success");
    expect(getData.content.agents["test-get-by-name-success"]).toBeDefined();
    expect(getData.content.agents["test-get-by-name-success"].description).toBe(
      "Test description",
    );
    expect(getData.createdAt).toBeDefined();
    expect(getData.updatedAt).toBeDefined();

    // Cleanup
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, createData.composeId));
  });

  it("should return 400 when name does not exist", async () => {
    const getRequest = new Request(
      "http://localhost:3000/api/agent/composes?name=nonexistent-agent",
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Agent compose not found");
    expect(getData.error.message).toContain("nonexistent-agent");
  });

  it("should return 400 when name query parameter is missing", async () => {
    const getRequest = new Request("http://localhost:3000/api/agent/composes", {
      method: "GET",
    });

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Missing name query parameter");
  });

  it("should only return compose for authenticated user", async () => {
    // Create compose as user 1
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
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest as NextRequest);
    expect(createResponse.status).toBe(201);

    // Try to get it as user 2
    mockUserId = "user-2-isolation";
    const getRequest = new Request(
      "http://localhost:3000/api/agent/composes?name=test-user-isolation",
      {
        method: "GET",
      },
    );

    const getResponse = await GET(getRequest as NextRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    expect(getData.error.message).toContain("Agent compose not found");

    // Cleanup
    mockUserId = "user-1-isolation";
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, "user-1-isolation"));
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, "user-2-isolation"));

    // Reset mockUserId
    mockUserId = "test-user-get-by-name";
  });

  it("should handle URL-encoded names correctly", async () => {
    // Create a test compose with hyphens
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
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      },
    );

    const createResponse = await POST(createRequest as NextRequest);
    const createData = await createResponse.json();
    expect(createResponse.status).toBe(201);

    // Get it with URL-encoded name
    const encodedName = encodeURIComponent("test-agent-with-hyphens");
    const getRequest = new Request(
      `http://localhost:3000/api/agent/composes?name=${encodedName}`,
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
      .delete(agentComposes)
      .where(eq(agentComposes.id, createData.composeId));
  });
});
