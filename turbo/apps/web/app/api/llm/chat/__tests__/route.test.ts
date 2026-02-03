import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { testContext } from "../../../../../src/__tests__/test-helpers";

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

const context = testContext();

describe("POST /api/llm/chat", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("Validation", () => {
    it("should return 400 when messages is empty", async () => {
      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json({
            id: "gen-123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "google/gemma-3-4b-it:free",
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.content).toBe("Hello! How can I help you today?");
      expect(data.model).toBe("google/gemma-3-4b-it:free");
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
            { error: { message: "Rate limit exceeded" } },
            { status: 429 },
          );
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      await expect(POST(request)).rejects.toThrow();
    });
  });

  describe("Streaming chat", () => {
    it("should return SSE stream with content for streaming requests", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          const encoder = new TextEncoder();
          const now = Math.floor(Date.now() / 1000);
          const stream = new ReadableStream({
            start(controller) {
              const chunks = [
                {
                  id: "gen-123",
                  object: "chat.completion.chunk",
                  created: now,
                  model: "google/gemma-3-4b-it:free",
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
                  model: "google/gemma-3-4b-it:free",
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
                  model: "google/gemma-3-4b-it:free",
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
            headers: { "Content-Type": "text/event-stream" },
          });
        }),
      );

      const request = createTestRequest("http://localhost:3000/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullContent += decoder.decode(value, { stream: true });
      }

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
            model: "google/gemma-3-4b-it:free",
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
