/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../../../app/api/agent-runtimes/route";
import type {
  CreateAgentRuntimeRequest,
  CreateAgentRuntimeResponse,
} from "../../../types/agent-runtime";

describe("Agent Runtimes API - integration tests with real E2B", () => {
  beforeAll(() => {
    // Verify E2B_API_KEY is available
    if (!process.env.E2B_API_KEY) {
      throw new Error(
        "E2B_API_KEY is required for agent runtime tests. Please set it in .env.local",
      );
    }
  });

  describe("POST /api/agent-runtimes", () => {
    it("should return 400 when agentConfigId is missing", async () => {
      const requestBody = {
        prompt: "test prompt",
      } as CreateAgentRuntimeRequest;

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
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
        agentConfigId: "test-agent-001",
      } as CreateAgentRuntimeRequest;

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toBe("Missing prompt");
    });

    it("should create runtime and execute hello world with E2B", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: "test-agent-001",
        prompt: "test prompt for hello world",
        dynamicVars: {
          testVar: "testValue",
        },
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();

      // Verify response structure
      expect(data.runtimeId).toBeDefined();
      expect(data.runtimeId).toMatch(/^rt-\d+-[a-z0-9]+$/);

      // Verify sandbox was created
      expect(data.sandboxId).toBeDefined();
      expect(data.sandboxId).toBeTruthy();

      // Verify execution status
      expect(data.status).toBe("completed");

      // Verify output
      expect(data.output).toContain("Hello World from E2B!");

      // Verify timing
      expect(data.executionTimeMs).toBeGreaterThan(0);
      expect(data.executionTimeMs).toBeLessThan(60000);

      // Verify timestamp
      expect(data.createdAt).toBeDefined();
      expect(new Date(data.createdAt)).toBeInstanceOf(Date);

      // Verify no error
      expect(data.error).toBeUndefined();
    }, 60000); // 60 second timeout for real E2B API

    it("should handle multiple concurrent runtime requests", async () => {
      const requests = Array.from({ length: 3 }, (_, i) => {
        const requestBody: CreateAgentRuntimeRequest = {
          agentConfigId: `test-agent-concurrent-${i}`,
          prompt: `concurrent test ${i}`,
        };

        return new NextRequest("http://localhost/api/agent-runtimes", {
          method: "POST",
          body: JSON.stringify(requestBody),
        });
      });

      const responses = await Promise.all(requests.map((req) => POST(req)));

      // All should succeed
      responses.forEach((response) => {
        expect(response.status).toBe(201);
      });

      // Parse all responses
      const data = await Promise.all(
        responses.map(
          (res) => res.json() as Promise<CreateAgentRuntimeResponse>,
        ),
      );

      // All should have unique runtime IDs
      const runtimeIds = data.map((d) => d.runtimeId);
      const uniqueIds = new Set(runtimeIds);
      expect(uniqueIds.size).toBe(3);

      // All should have unique sandbox IDs
      const sandboxIds = data.map((d) => d.sandboxId);
      const uniqueSandboxIds = new Set(sandboxIds);
      expect(uniqueSandboxIds.size).toBe(3);

      // All should complete successfully
      data.forEach((d) => {
        expect(d.status).toBe("completed");
        expect(d.output).toContain("Hello World from E2B!");
      });
    }, 120000); // 120 second timeout for concurrent requests

    it("should handle minimal request body", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: "test-agent-minimal",
        prompt: "minimal test",
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();
      expect(data.status).toBe("completed");
      expect(data.output).toContain("Hello World from E2B!");
    }, 60000);

    it("should handle request with dynamic vars", async () => {
      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: "test-agent-vars",
        prompt: "test with vars",
        dynamicVars: {
          var1: "value1",
          var2: "value2",
          var3: "value3",
        },
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();

      // MVP doesn't use dynamic vars yet, but should accept them
      expect(data.status).toBe("completed");
      expect(data.output).toContain("Hello World from E2B!");
    }, 60000);

    it("should handle long prompts", async () => {
      const longPrompt = "test ".repeat(100); // 500 character prompt

      const requestBody: CreateAgentRuntimeRequest = {
        agentConfigId: "test-agent-long-prompt",
        prompt: longPrompt,
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();
      expect(data.status).toBe("completed");
      expect(data.output).toContain("Hello World from E2B!");
    }, 60000);

    it("should return proper error structure on E2B failure", async () => {
      // Save original API key
      const originalKey = process.env.E2B_API_KEY;

      try {
        // Temporarily set invalid API key to trigger E2B error
        process.env.E2B_API_KEY = "invalid-key-for-testing";

        const requestBody: CreateAgentRuntimeRequest = {
          agentConfigId: "test-agent-error",
          prompt: "error test",
        };

        const request = new NextRequest("http://localhost/api/agent-runtimes", {
          method: "POST",
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
        agentConfigId: "test-agent-performance",
        prompt: "performance test",
      };

      const request = new NextRequest("http://localhost/api/agent-runtimes", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      const startTime = Date.now();
      const response = await POST(request);
      const totalTime = Date.now() - startTime;

      expect(response.status).toBe(201);

      const data: CreateAgentRuntimeResponse = await response.json();

      // Should complete reasonably fast (E2B sandbox creation is usually 1-10s)
      expect(totalTime).toBeLessThan(30000); // 30 seconds max
      expect(data.executionTimeMs).toBeLessThan(30000);
    }, 60000);

    it("should handle sequential requests reliably", async () => {
      const results: CreateAgentRuntimeResponse[] = [];

      for (let i = 0; i < 3; i++) {
        const requestBody: CreateAgentRuntimeRequest = {
          agentConfigId: `test-agent-sequential-${i}`,
          prompt: `sequential test ${i}`,
        };

        const request = new NextRequest("http://localhost/api/agent-runtimes", {
          method: "POST",
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
        expect(result.output).toContain("Hello World from E2B!");
        expect(result.runtimeId).toBeDefined();
        expect(result.sandboxId).toBeDefined();
      });

      // All should have unique IDs
      const runtimeIds = results.map((r) => r.runtimeId);
      const uniqueIds = new Set(runtimeIds);
      expect(uniqueIds.size).toBe(3);
    }, 180000); // 180 second timeout for sequential requests
  });
});
