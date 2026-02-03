import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { testContext } from "../../../../../src/__tests__/test-helpers";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

// Mock env module to control OPENROUTER_API_KEY
// Use vi.hoisted() to ensure mockEnvValues is defined before vi.mock runs
const mockEnvValues = vi.hoisted(() => ({
  OPENROUTER_API_KEY: undefined as string | undefined,
}));

vi.mock("../../../../../src/env", () => ({
  env: () => mockEnvValues,
}));

const context = testContext();

describe("POST /api/llm/chat", () => {
  beforeEach(() => {
    context.setupMocks();
    // Default: user not logged in, no env token
    mockClerk({ userId: null });
    mockEnvValues.OPENROUTER_API_KEY = undefined;
  });

  describe("Authentication", () => {
    it("should return 401 when not logged in and no header token", async () => {
      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toContain("x-openrouter-token");
    });

    it("should use env token when user is logged in", async () => {
      mockClerk({ userId: "user-123" });
      mockEnvValues.OPENROUTER_API_KEY = "env-openrouter-token";

      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json({
            id: "gen-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "anthropic/claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Hello from env token!",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 15,
              total_tokens: 25,
            },
          });
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.content).toBe("Hello from env token!");
    });

    it("should return 503 when logged in but env token not configured", async () => {
      mockClerk({ userId: "user-123" });
      mockEnvValues.OPENROUTER_API_KEY = undefined;

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error.code).toBe("SERVICE_UNAVAILABLE");
      expect(data.error.message).toContain("not configured");
    });

    it("should use header token when not logged in", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json({
            id: "gen-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "anthropic/claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Hello from header token!",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 15,
              total_tokens: 25,
            },
          });
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "header-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.content).toBe("Hello from header token!");
    });
  });

  describe("Validation", () => {
    it("should return 400 when model is missing", async () => {
      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "test-token",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("should return 400 when messages is empty", async () => {
      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "test-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("should return 400 when message role is invalid", async () => {
      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "test-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "invalid", content: "Hello" }],
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("Non-streaming chat", () => {
    it("should return chat completion successfully", async () => {
      // Mock OpenRouter API response
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json({
            id: "gen-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "anthropic/claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Hello! How can I help you today?",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 15,
              total_tokens: 25,
            },
          });
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "test-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.content).toBe("Hello! How can I help you today?");
      expect(data.model).toBe("anthropic/claude-sonnet-4");
      expect(data.usage).toEqual({
        promptTokens: 10,
        completionTokens: 15,
        totalTokens: 25,
      });
    });

    it("should propagate OpenRouter API errors", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(
            { error: { message: "Invalid API key" } },
            { status: 401 },
          );
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "invalid-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      // Error propagates without catch-all handler
      await expect(POST(request)).rejects.toThrow();
    });
  });

  describe("Streaming chat", () => {
    it("should return SSE stream with content for streaming requests", async () => {
      // Mock streaming response with proper OpenRouter chunk format
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          const encoder = new TextEncoder();
          const now = Math.floor(Date.now() / 1000);
          const stream = new ReadableStream({
            start(controller) {
              // Send chunks with full OpenRouter format
              const chunks = [
                {
                  id: "gen-123",
                  object: "chat.completion.chunk",
                  created: now,
                  model: "anthropic/claude-sonnet-4",
                  choices: [
                    {
                      delta: { content: "Hello" },
                      index: 0,
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "gen-123",
                  object: "chat.completion.chunk",
                  created: now,
                  model: "anthropic/claude-sonnet-4",
                  choices: [
                    {
                      delta: { content: " there!" },
                      index: 0,
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "gen-123",
                  object: "chat.completion.chunk",
                  created: now,
                  model: "anthropic/claude-sonnet-4",
                  choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
                },
              ];
              for (const chunk of chunks) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                );
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });

          return new HttpResponse(stream, {
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "test-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Verify stream content
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullContent += decoder.decode(value, { stream: true });
      }

      // Verify we received content chunks
      expect(fullContent).toContain('data: {"content":"Hello"}');
      expect(fullContent).toContain('data: {"content":" there!"}');
      expect(fullContent).toContain("data: [DONE]");
    });
  });

  describe("Message roles", () => {
    it("should accept user, assistant, and system roles", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json({
            id: "gen-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "anthropic/claude-sonnet-4",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Response",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          });
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openrouter-token": "test-token",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4",
          messages: [
            { role: "system", content: "You are a helpful assistant" },
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
            { role: "user", content: "How are you?" },
          ],
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });
  });
});
