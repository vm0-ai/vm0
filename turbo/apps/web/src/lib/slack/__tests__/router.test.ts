import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-helpers";
import { routeToAgent, keywordMatch, type RouteResult } from "../router";

// Ensure Axiom logger is disabled in tests by unsetting AXIOM_TOKEN
vi.hoisted(() => {
  vi.stubEnv("AXIOM_TOKEN", "");
});

// Mock external dependencies
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

// Mock the env
vi.mock("../../../env", () => ({
  env: vi.fn(() => ({
    OPENROUTER_API_KEY: undefined,
  })),
}));

import { env } from "../../../env";

const mockedEnv = vi.mocked(env);
const context = testContext();

/**
 * Helper to create OpenRouter chat completion response
 */
function createOpenRouterResponse(content: string) {
  return {
    id: "gen-123",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "google/gemma-3-4b-it:free",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

describe("keywordMatch", () => {
  it("returns null for empty bindings", () => {
    const result = keywordMatch("hello", []);
    expect(result).toBeNull();
  });

  it("returns agent when its name is mentioned in the message", () => {
    const result = keywordMatch("can the coder help me with this?", [
      { agentName: "coder", description: "Writes code" },
      { agentName: "reviewer", description: "Reviews code" },
    ]);
    expect(result).toBe("coder");
  });

  it("returns agent when description keywords match the message", () => {
    const result = keywordMatch("I need help writing python code", [
      {
        agentName: "agent-a",
        description: "Writes code and helps with programming",
      },
      { agentName: "agent-b", description: "Manages tasks and schedules" },
    ]);
    expect(result).toBe("agent-a");
  });

  it("returns null when routing is ambiguous", () => {
    const result = keywordMatch("hello there", [
      { agentName: "agent-a", description: "A friendly helper" },
      { agentName: "agent-b", description: "Another friendly helper" },
    ]);
    expect(result).toBeNull();
  });

  it("returns null when no descriptions match", () => {
    const result = keywordMatch("fix the bug in the login page", [
      { agentName: "weather-bot", description: "Provides weather forecasts" },
      { agentName: "news-bot", description: "Delivers daily news" },
    ]);
    expect(result).toBeNull();
  });

  it("prefers agent name match over description match", () => {
    const result = keywordMatch("use the writer to help", [
      { agentName: "writer", description: "Helps with reading" },
      { agentName: "reader", description: "Helps with writing and editing" },
    ]);
    expect(result).toBe("writer");
  });

  it("handles agents with null descriptions", () => {
    const result = keywordMatch("hello coder", [
      { agentName: "coder", description: null },
      { agentName: "other", description: null },
    ]);
    expect(result).toBe("coder");
  });

  it("matches hyphenated agent names", () => {
    const result = keywordMatch("ask code helper for assistance", [
      { agentName: "code-helper", description: "Helps with code" },
      { agentName: "task-manager", description: "Manages tasks" },
    ]);
    expect(result).toBe("code-helper");
  });

  it("matches underscored agent names", () => {
    const result = keywordMatch("use the code assistant", [
      { agentName: "code_assistant", description: "Helps with code" },
      { agentName: "task_manager", description: "Manages tasks" },
    ]);
    expect(result).toBe("code_assistant");
  });
});

describe("routeToAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    context.setupMocks();
    server.listen({ onUnhandledRequest: "bypass" });
    mockedEnv.mockReturnValue({
      OPENROUTER_API_KEY: undefined,
    } as ReturnType<typeof env>);
  });

  afterEach(() => {
    server.resetHandlers();
    server.close();
  });

  it("returns ambiguous for empty bindings", async () => {
    const result = await routeToAgent("hello", []);
    expect(result).toEqual<RouteResult>({ type: "ambiguous" });
  });

  it("returns matched with the only agent when there is just one binding", async () => {
    const result = await routeToAgent("hello", [
      { agentName: "my-agent", description: "A test agent" },
    ]);
    expect(result).toEqual<RouteResult>({
      type: "matched",
      agentName: "my-agent",
    });
  });

  it("returns matched when keyword matching succeeds", async () => {
    const result = await routeToAgent("can the coder help me with this?", [
      { agentName: "coder", description: "Writes code" },
      { agentName: "reviewer", description: "Reviews code" },
    ]);
    expect(result).toEqual<RouteResult>({
      type: "matched",
      agentName: "coder",
    });
  });

  it("returns ambiguous when keyword matching fails and no API key", async () => {
    const result = await routeToAgent("hello there", [
      { agentName: "agent-a", description: "A friendly helper" },
      { agentName: "agent-b", description: "Another friendly helper" },
    ]);
    expect(result).toEqual<RouteResult>({ type: "ambiguous" });
  });

  describe("with LLM routing", () => {
    beforeEach(() => {
      mockedEnv.mockReturnValue({
        OPENROUTER_API_KEY: "test-api-key",
      } as ReturnType<typeof env>);
    });

    it("calls LLM when keyword matching is ambiguous", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(createOpenRouterResponse("AGENT:agent-a"));
        }),
      );

      const result = await routeToAgent("hello there", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({
        type: "matched",
        agentName: "agent-a",
      });
    });

    it("returns not_request when LLM returns NOT_REQUEST", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(createOpenRouterResponse("NOT_REQUEST"));
        }),
      );

      const result = await routeToAgent("hi", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "not_request" });
    });

    it("returns ambiguous when LLM returns AMBIGUOUS", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(createOpenRouterResponse("AMBIGUOUS"));
        }),
      );

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("returns ambiguous when LLM returns unknown agent", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(
            createOpenRouterResponse("AGENT:unknown-agent"),
          );
        }),
      );

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("returns ambiguous when LLM returns invalid response", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(
            createOpenRouterResponse("I think you should use agent-a"),
          );
        }),
      );

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("returns ambiguous when LLM call fails", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(
            { error: { message: "API error" } },
            { status: 500 },
          );
        }),
      );

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("passes context to LLM when provided", async () => {
      let capturedBody: unknown = null;

      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json(createOpenRouterResponse("AGENT:agent-a"));
          },
        ),
      );

      await routeToAgent(
        "help me with this",
        [
          { agentName: "agent-a", description: "A friendly helper" },
          { agentName: "agent-b", description: "Another friendly helper" },
        ],
        "Previous conversation about code review",
      );

      expect(capturedBody).toBeDefined();
      const body = capturedBody as {
        messages: { role: string; content: string }[];
      };
      const userMessage = body.messages.find((m) => m.role === "user");
      expect(userMessage?.content).toContain(
        "Previous conversation about code review",
      );
    });

    it("matches agent name case-insensitively", async () => {
      server.use(
        http.post("https://openrouter.ai/api/v1/chat/completions", () => {
          return HttpResponse.json(createOpenRouterResponse("AGENT:Agent-A"));
        }),
      );

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({
        type: "matched",
        agentName: "agent-a",
      });
    });
  });
});
