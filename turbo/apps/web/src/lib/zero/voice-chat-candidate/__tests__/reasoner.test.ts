import { describe, it, expect, vi } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";
import { reloadEnv } from "../../../../env";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function openRouterResponse(content: string | null) {
  return {
    choices: [{ message: { content } }],
  };
}

function emptyParams() {
  return {
    agentSystemPrompt: "",
    priorConversationSummary: null,
    transcript: [],
    tasks: [],
  };
}

describe("callReasoner", () => {
  it("returns null and does not fetch when OPENROUTER_API_KEY is missing", async () => {
    // Env is not stubbed — key is absent by default in tests.
    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner(emptyParams());

    expect(result).toBeNull();
  });

  it("parses the conversation section on a successful response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const payload = [
      "---CONVERSATION---",
      "User: backend eng",
      "Focus: reviewing PR",
    ].join("\n");

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse(payload));
    });
    server.use(handler.handler);

    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner({
      agentSystemPrompt: "be helpful",
      priorConversationSummary: "prior",
      transcript: [
        {
          seq: 1,
          role: "user",
          content: "hi",
          createdAt: new Date().toISOString(),
        },
      ],
      tasks: [],
    });

    expect(result).not.toBeNull();
    expect(result?.conversationSummary).toContain("User: backend eng");
    expect(result?.conversationSummary).toContain("Focus: reviewing PR");
    expect(handler.mocked).toHaveBeenCalledTimes(1);
  });

  it("returns null when the response is not OK", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.text("server down", { status: 500 });
    });
    server.use(handler.handler);

    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner(emptyParams());

    expect(result).toBeNull();
  });

  it("returns null when the response content is empty", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse(""));
    });
    server.use(handler.handler);

    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner(emptyParams());

    expect(result).toBeNull();
  });

  it("returns null when a network error occurs", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.error();
    });
    server.use(handler.handler);

    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner(emptyParams());

    expect(result).toBeNull();
  });
});
