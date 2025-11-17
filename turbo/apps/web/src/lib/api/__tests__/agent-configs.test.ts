/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { initServices } from "../../init-services";
import { apiKeys } from "../../../db/schema/api-key";
import { agentConfigs } from "../../../db/schema/agent-config";
import { eq } from "drizzle-orm";
import { POST } from "../../../../app/api/agent-configs/route";
import { GET } from "../../../../app/api/agent-configs/[id]/route";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

describe("Agent Configs API - integration tests", () => {
  const testApiKey = "test-api-key-123";
  let testApiKeyId: string;
  let testAgentConfigId: string;

  beforeEach(async () => {
    // Initialize services
    initServices();

    // Clean up test data
    if (testApiKeyId) {
      await globalThis.services.db
        .delete(agentConfigs)
        .where(eq(agentConfigs.apiKeyId, testApiKeyId))
        .execute();
    }
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.name, "Test API Key"))
      .execute();

    // Create test API key
    const [insertedKey] = await globalThis.services.db
      .insert(apiKeys)
      .values({
        keyHash: hashApiKey(testApiKey),
        name: "Test API Key",
      })
      .returning({ id: apiKeys.id });

    testApiKeyId = insertedKey?.id ?? "";
  });

  afterEach(async () => {
    // Clean up test data
    if (testAgentConfigId) {
      await globalThis.services.db
        .delete(agentConfigs)
        .where(eq(agentConfigs.id, testAgentConfigId))
        .execute();
    }
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.apiKeyId, testApiKeyId))
      .execute();
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.id, testApiKeyId))
      .execute();
  });

  describe("POST /api/agent-configs", () => {
    it("should return 401 when API key is missing", async () => {
      const request = new NextRequest("http://localhost/api/agent-configs", {
        method: "POST",
        body: JSON.stringify({
          config: { name: "test-agent" },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toBe("Missing API key");
    });

    it("should return 401 when API key is invalid", async () => {
      const request = new NextRequest("http://localhost/api/agent-configs", {
        method: "POST",
        headers: { "x-api-key": "invalid-key" },
        body: JSON.stringify({
          config: { name: "test-agent" },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toBe("Invalid API key");
    });

    it("should return 400 when config is missing", async () => {
      const request = new NextRequest("http://localhost/api/agent-configs", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify({}),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toBe("Missing config");
    });

    it("should create agent config and return 201", async () => {
      const configData = {
        version: "1.0.0",
        agent: {
          name: "test-agent",
          description: "Test agent config",
        },
      };

      const request = new NextRequest("http://localhost/api/agent-configs", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify({
          config: configData,
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.agentConfigId).toBeDefined();
      expect(data.createdAt).toBeDefined();

      // Store for cleanup
      testAgentConfigId = data.agentConfigId;

      // Verify in database
      const [dbConfig] = await globalThis.services.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, data.agentConfigId))
        .limit(1);

      expect(dbConfig).toBeDefined();
      expect(dbConfig?.apiKeyId).toBe(testApiKeyId);
      expect(dbConfig?.config).toEqual(configData);
    });
  });

  describe("GET /api/agent-configs/:id", () => {
    beforeEach(async () => {
      // Create a test agent config for GET tests
      const [inserted] = await globalThis.services.db
        .insert(agentConfigs)
        .values({
          apiKeyId: testApiKeyId,
          config: {
            version: "1.0.0",
            agent: {
              name: "test-agent",
            },
          },
        })
        .returning({ id: agentConfigs.id });

      testAgentConfigId = inserted?.id ?? "";
    });

    it("should return 401 when API key is missing", async () => {
      const request = new NextRequest(
        `http://localhost/api/agent-configs/${testAgentConfigId}`,
        {
          method: "GET",
        },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testAgentConfigId }),
      });
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toBe("Missing API key");
    });

    it("should return 401 when API key is invalid", async () => {
      const request = new NextRequest(
        `http://localhost/api/agent-configs/${testAgentConfigId}`,
        {
          method: "GET",
          headers: { "x-api-key": "invalid-key" },
        },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testAgentConfigId }),
      });
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toBe("Invalid API key");
    });

    it("should return 404 when agent config not found", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const request = new NextRequest(
        `http://localhost/api/agent-configs/${nonExistentId}`,
        {
          method: "GET",
          headers: { "x-api-key": testApiKey },
        },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: nonExistentId }),
      });
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
      expect(data.error.message).toBe("Agent config not found");
    });

    it("should return agent config when found", async () => {
      const request = new NextRequest(
        `http://localhost/api/agent-configs/${testAgentConfigId}`,
        {
          method: "GET",
          headers: { "x-api-key": testApiKey },
        },
      );

      const response = await GET(request, {
        params: Promise.resolve({ id: testAgentConfigId }),
      });
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.id).toBe(testAgentConfigId);
      expect(data.config).toEqual({
        version: "1.0.0",
        agent: {
          name: "test-agent",
        },
      });
      expect(data.createdAt).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });
  });
});
