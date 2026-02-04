import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeToAgent, keywordMatch, type RouteResult } from "../router";

// Mock the llm-service
vi.mock("../../llm/llm-service", () => ({
  chat: vi.fn(),
}));

// Mock the env
vi.mock("../../../env", () => ({
  env: vi.fn(() => ({
    OPENROUTER_API_KEY: undefined,
  })),
}));

import { chat } from "../../llm/llm-service";
import { env } from "../../../env";

const mockedChat = vi.mocked(chat);
const mockedEnv = vi.mocked(env);

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
    mockedEnv.mockReturnValue({
      OPENROUTER_API_KEY: undefined,
    } as ReturnType<typeof env>);
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
    // LLM should not be called when keyword matching succeeds
    expect(mockedChat).not.toHaveBeenCalled();
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
      mockedChat.mockResolvedValueOnce({
        content: "AGENT:agent-a",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await routeToAgent("hello there", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({
        type: "matched",
        agentName: "agent-a",
      });
      expect(mockedChat).toHaveBeenCalledOnce();
    });

    it("returns not_request when LLM returns NOT_REQUEST", async () => {
      mockedChat.mockResolvedValueOnce({
        content: "NOT_REQUEST",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await routeToAgent("hi", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "not_request" });
    });

    it("returns ambiguous when LLM returns AMBIGUOUS", async () => {
      mockedChat.mockResolvedValueOnce({
        content: "AMBIGUOUS",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("returns ambiguous when LLM returns unknown agent", async () => {
      mockedChat.mockResolvedValueOnce({
        content: "AGENT:unknown-agent",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("returns ambiguous when LLM returns invalid response", async () => {
      mockedChat.mockResolvedValueOnce({
        content: "I think you should use agent-a",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("returns ambiguous when LLM call fails", async () => {
      mockedChat.mockRejectedValueOnce(new Error("API error"));

      const result = await routeToAgent("help me", [
        { agentName: "agent-a", description: "A friendly helper" },
        { agentName: "agent-b", description: "Another friendly helper" },
      ]);

      expect(result).toEqual<RouteResult>({ type: "ambiguous" });
    });

    it("passes context to LLM when provided", async () => {
      mockedChat.mockResolvedValueOnce({
        content: "AGENT:agent-a",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      await routeToAgent(
        "help me with this",
        [
          { agentName: "agent-a", description: "A friendly helper" },
          { agentName: "agent-b", description: "Another friendly helper" },
        ],
        "Previous conversation about code review",
      );

      expect(mockedChat).toHaveBeenCalledWith(
        "test-api-key",
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              content: expect.stringContaining(
                "Previous conversation about code review",
              ),
            }),
          ]),
        }),
      );
    });

    it("matches agent name case-insensitively", async () => {
      mockedChat.mockResolvedValueOnce({
        content: "AGENT:Agent-A",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

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
