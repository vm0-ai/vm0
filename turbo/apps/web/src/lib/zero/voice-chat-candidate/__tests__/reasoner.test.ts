import { describe, it, expect, vi, afterEach } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("callReasoner", () => {
  it("returns null and does not fetch when OPENROUTER_API_KEY is missing", async () => {
    // Env is not stubbed — key is absent by default in tests.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner(emptyParams());

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("returns null when the fetch is aborted by the 30s timeout", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();
    vi.useFakeTimers();

    const fetchStub = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    const { callReasoner } = await import("../reasoner");

    const promise = callReasoner(emptyParams());

    await vi.advanceTimersByTimeAsync(31_000);

    expect(await promise).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("returns null when fetch throws a network error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const fetchStub = vi.fn(() => {
      return Promise.reject(new TypeError("network down"));
    });
    vi.stubGlobal("fetch", fetchStub);

    const { callReasoner } = await import("../reasoner");

    const result = await callReasoner(emptyParams());

    expect(result).toBeNull();
  });
});
