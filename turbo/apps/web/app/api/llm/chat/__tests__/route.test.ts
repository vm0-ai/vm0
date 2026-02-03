import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

// MSW server for mocking OpenRouter API
const server = setupServer();

beforeEach(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});

afterEach(() => {
  server.resetHandlers();
});

describe("POST /api/llm/chat", () => {
  describe("Authentication", () => {
    it("should return 401 when x-openrouter-token header is missing", async () => {
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

    it("should handle OpenRouter API errors", async () => {
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

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });

  describe("Streaming chat", () => {
    it("should return SSE stream for streaming requests", async () => {
      // Mock streaming response
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              // Send chunks
              const chunks = [
                { choices: [{ delta: { content: "Hello" }, index: 0 }] },
                { choices: [{ delta: { content: " there!" }, index: 0 }] },
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
