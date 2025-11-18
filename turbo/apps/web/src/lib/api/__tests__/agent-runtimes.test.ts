/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { initServices } from "../../init-services";
import { apiKeys } from "../../../db/schema/api-key";
import { agentConfigs } from "../../../db/schema/agent-config";
import { agentRuntimes } from "../../../db/schema/agent-runtime";
import { eq } from "drizzle-orm";
import { POST } from "../../../../app/api/agent-runtimes/route";
import type {
  CreateAgentRuntimeRequest,
  CreateAgentRuntimeResponse,
} from "../../../types/agent-runtime";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

describe("Agent Runtimes API - integration tests with real E2B", () => {
  const testApiKey = "test-api-key-123";
  let testApiKeyId: string;
  let testAgentConfigId: string;

  beforeEach(async () => {
    // Initialize services
    initServices();

    // Clean up test data
    await globalThis.services.db.delete(agentRuntimes).execute();
    await globalThis.services.db.delete(agentConfigs).execute();
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

    // Create test agent config
    const [insertedConfig] = await globalThis.services.db
      .insert(agentConfigs)
      .values({
        apiKeyId: testApiKeyId,
        config: {
          version: "1.0",
          agent: {
            description: "Test agent",
            image: "vm0-claude-code:test",
            provider: "claude-code",
            working_dir: "/workspace",
            volumes: [],
          },
        },
      })
      .returning({ id: agentConfigs.id });

    testAgentConfigId = insertedConfig?.id ?? "";

    // Verify E2B_API_KEY is available
    if (!process.env.E2B_API_KEY) {
      throw new Error(
        "E2B_API_KEY is required for agent runtime tests. Please set it in .env.local",
      );
    }
  });

  afterEach(async () => {
    // Clean up test data
    await globalThis.services.db.delete(agentRuntimes).execute();
    await globalThis.services.db
      .delete(agentConfigs)
      .where(eq(agentConfigs.id, testAgentConfigId))
      .execute();
    await globalThis.services.db
      .delete(apiKeys)
      .where(eq(apiKeys.id, testApiKeyId))
      .execute();
  });

  describe("POST /api/agent-runtimes", () => {
    it("should return 401 when API key is missing", async () => {
      const requestBody = {
        agentConfigId: testAgentConfigId,
        prompt: "test prompt",
      } as CreateAgentRuntimeRequest;

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should return 400 when agentConfigId is missing", async () => {
      const requestBody = {
        prompt: "test prompt",
      } as CreateAgentRuntimeRequest;

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toBe("Missing agentConfigId");
    });

    it("should return 400 when prompt is missing", async () => {
      const requestBody = {
        agentConfigId: testAgentConfigId,
      } as CreateAgentRuntimeRequest;

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toBe("Missing prompt");
    });

    it("should return 404 when agent config not found", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: "00000000-0000-0000-0000-000000000000", // Valid UUID that doesn't exist
        prompt: "test prompt",
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("should create runtime and execute hello world with E2B", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: testAgentConfigId,
        prompt: "test prompt for hello world",
        dynamicVars: {
          testVar: "testValue",
        },
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();

      // Verify response structure
      expect(data.runtimeId).toBeDefined();
      expect(data.runtimeId).toMatch(/^[0-9a-f-]+$/); // UUID format

      // Verify sandbox was created
      expect(data.sandboxId).toBeDefined();
      expect(data.sandboxId).toBeTruthy();

      // Verify execution status
      expect(data.status).toBe("completed");

      // Verify output is from Claude Code, NOT the old echo command
      expect(data.output).not.toContain("Hello World from E2B!");
      expect(data.output).toBeTruthy(); // Should have some output

      // Verify timing
      expect(data.executionTimeMs).toBeGreaterThan(0);
      expect(data.executionTimeMs).toBeLessThan(600000); // 10 minutes

      // Verify timestamp
      expect(data.createdAt).toBeDefined();
      expect(new Date(data.createdAt)).toBeInstanceOf(Date);

      // Verify no error
      expect(data.error).toBeUndefined();
    }, 600000); // 10 minute timeout for Claude Code execution

    it("should handle minimal request body", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: testAgentConfigId,
        prompt: "minimal test",
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();
      expect(data.status).toBe("completed");
      expect(data.output).not.toContain("Hello World from E2B!");
      expect(data.output).toBeTruthy();
    }, 600000);

    it("should handle request with dynamic vars", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: testAgentConfigId,
        prompt: "test with vars",
        dynamicVars: {
          var1: "value1",
          var2: "value2",
          var3: "value3",
        },
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();

      // MVP doesn't use dynamic vars yet, but should accept them
      expect(data.status).toBe("completed");
      expect(data.output).not.toContain("Hello World from E2B!");
      expect(data.output).toBeTruthy();
    }, 600000);

    it("should return proper error structure on E2B failure", async () => {
      // Save original API key
      const originalKey = process.env.E2B_API_KEY;

      try {
        // Temporarily set invalid API key to trigger E2B error
        process.env.E2B_API_KEY = "invalid-key-for-testing";

        const requestBody: CreateAgentRuntimeRequest = {
          agentConfigId: testAgentConfigId,
          prompt: "error test",
        };

        const request = new NextRequest("http://localhost/api/agent-runtimes", {
          method: "POST",
          headers: { "x-api-key": testApiKey },
          body: JSON.stringify(requestBody),
        });

        const response = await POST(request);
        expect(response.status).toBe(201); // Still returns 201 as runtime was created

        const data: CreateAgentRuntimeResponse = await response.json();

        // Should indicate failure
        expect(data.status).toBe("failed");
        expect(data.error).toBeDefined();
        expect(data.sandboxId).toBe("unknown");
      } finally {
        // Restore original API key
        process.env.E2B_API_KEY = originalKey;
      }
    }, 60000);
  });

  describe("performance and reliability", () => {
    it("should complete within reasonable time", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: testAgentConfigId,
        prompt: "performance test",
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        headers: { "x-api-key": testApiKey },
        body: JSON.stringify(requestBody),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const totalTime = Date.now() - startTime;

      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();

      // Claude Code execution should complete within 10 minutes
      expect(totalTime).toBeLessThan(600000); // 10 minutes max
      expect(data.executionTimeMs).toBeLessThan(600000);
    }, 600000);

    it("should handle sequential requests reliably", async () => {
      const results: CreateAgentRuntimeResponse[] = [];

      for (let i = 0; i < 3; i++) {
        const requestBody: CreateAgentRuntimeRequest = {
          agentConfigId: testAgentConfigId,
          prompt: `sequential test ${i}`,
        };

        const request = new NextRequest("http://localhost/api/agent-runtimes", {
          method: "POST",
          headers: { "x-api-key": testApiKey },
          body: JSON.stringify(requestBody),
        });

        const response = await POST(request);
        expect(response.status).toBe(201);

        const data: CreateAgentRuntimeResponse = await response.json();
        results.push(data);
      }

      // All should succeed
      results.forEach((result) => {
        expect(result.status).toBe("completed");
        expect(result.output).not.toContain("Hello World from E2B!");
        expect(result.output).toBeTruthy();
        expect(result.runtimeId).toBeDefined();
        expect(result.sandboxId).toBeDefined();
      });

      // All should have unique IDs
      const runtimeIds = results.map((r) => r.runtimeId);
      const uniqueIds = new Set(runtimeIds);
      expect(uniqueIds.size).toBe(3);
    }, 1800000); // 30 minute timeout for 3 sequential Claude Code executions
  });
});
