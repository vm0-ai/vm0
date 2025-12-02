/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { GET } from "../[id]/route";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

// Mock the auth module
let mockUserId = "test-user-123";
vi.mock("../../../../../src/lib/auth/get-user-id", () => ({
  getUserId: async () => mockUserId,
}));

describe("Agent Compose Upsert Behavior", () => {
  const testUserId = "test-user-123";

  beforeAll(() => {
    initServices();
  });

  afterAll(async () => {
    // Cleanup: Delete test composes
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.userId, testUserId));
  });

  describe("POST /api/agent/composes", () => {
    it("should create new compose when name does not exist", async () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent-create": {
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const request = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response = await POST(request as NextRequest);
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.action).toBe("created");
      expect(data.name).toBe("test-agent-create");
      expect(data.composeId).toBeDefined();
      expect(data.versionId).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it("should update existing compose when name matches", async () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent-update": {
            description: "Initial description",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      // First create
      const request1 = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response1 = await POST(request1 as NextRequest);
      const data1 = await response1.json();

      expect(data1.action).toBe("created");
      const composeId = data1.composeId;

      // Then update with same name
      const updatedConfig = {
        ...config,
        agents: {
          "test-agent-update": {
            ...config.agents["test-agent-update"],
            description: "Updated description",
          },
        },
      };

      const request2 = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: updatedConfig }),
      });

      const response2 = await POST(request2 as NextRequest);
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(data2.action).toBe("created"); // New version created (different content hash)
      expect(data2.composeId).toBe(composeId); // Same compose ID
      expect(data2.versionId).not.toBe(data1.versionId); // Different version (different content)
      expect(data2.name).toBe("test-agent-update");
      expect(data2.updatedAt).toBeDefined();

      // Verify the compose was actually updated
      const getRequest = new Request(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        {
          method: "GET",
        },
      );

      const getResponse = await GET(getRequest as NextRequest, {
        params: Promise.resolve({ id: composeId }),
      });
      const composeData = await getResponse.json();

      expect(composeData.content.agents["test-agent-update"].description).toBe(
        "Updated description",
      );
    });

    it("should maintain unique constraint on (userId, name)", async () => {
      const config = {
        version: "1.0",
        agents: {
          "test-unique-constraint": {
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      // Create compose for user 1
      mockUserId = "user-1";
      const request1 = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response1 = await POST(request1 as NextRequest);
      const data1 = await response1.json();
      expect(response1.status).toBe(201);

      // Create compose with same name for user 2 (should succeed)
      mockUserId = "user-2";
      const request2 = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response2 = await POST(request2 as NextRequest);
      const data2 = await response2.json();
      expect(response2.status).toBe(201);

      // Should be different compose IDs
      expect(data1.composeId).not.toBe(data2.composeId);

      // Cleanup
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.userId, "user-1"));
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.userId, "user-2"));

      // Reset mockUserId
      mockUserId = "test-user-123";
    });
  });

  describe("agent name validation", () => {
    it("should reject compose with multiple agents", async () => {
      const config = {
        version: "1.0",
        agents: {
          "agent-one": {
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
          "agent-two": {
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const request = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response = await POST(request as NextRequest);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toBe(
        "Multiple agents not supported yet. Only one agent allowed.",
      );
    });

    it("should reject compose with invalid name format", async () => {
      const config = {
        version: "1.0",
        agents: {
          ab: {
            // Too short name
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const request = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response = await POST(request as NextRequest);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("Invalid agent name");
    });

    it("should accept valid name with hyphens", async () => {
      const config = {
        version: "1.0",
        agents: {
          "my-test-agent-123": {
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const request = new Request("http://localhost:3000/api/agent/composes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: config }),
      });

      const response = await POST(request as NextRequest);

      expect(response.status).toBe(201);

      // Cleanup
      const data = await response.json();
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, data.composeId));
    });
  });

  describe("GET /api/agent/composes/:id", () => {
    it("should return compose with name field", async () => {
      const config = {
        version: "1.0",
        agents: {
          "test-get-compose": {
            description: "Test",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      // Create compose
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

      // Get compose
      const getRequest = new Request(
        `http://localhost:3000/api/agent/composes/${createData.composeId}`,
        {
          method: "GET",
        },
      );

      const getResponse = await GET(getRequest as NextRequest, {
        params: Promise.resolve({ id: createData.composeId }),
      });

      expect(getResponse.status).toBe(200);
      const getData = await getResponse.json();

      expect(getData.name).toBe("test-get-compose");
      expect(getData.content.agents["test-get-compose"]).toBeDefined();

      // Cleanup
      await globalThis.services.db
        .delete(agentComposes)
        .where(eq(agentComposes.id, createData.composeId));
    });
  });
});
