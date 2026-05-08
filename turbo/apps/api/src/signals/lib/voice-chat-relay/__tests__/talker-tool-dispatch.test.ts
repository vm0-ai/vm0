import { describe, it, expect } from "vitest";
import { dispatchTalkerTool } from "../talker-tool-dispatch";

const SESSION = "session_abc";
const CALL_ID = "call_xyz";
const TOKEN = "relay-token-stub";
const BASE_URL = "http://web.test";

interface FunctionCallOutputEvent {
  type: "conversation.item.create";
  item: { type: "function_call_output"; call_id: string; output: string };
}

interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetcher(response: { status: number; body?: unknown }) {
  const calls: CapturedFetch[] = [];
  const fetcher = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) {
        headers[k] = v;
      }
    }
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : init?.body,
    });
    return Promise.resolve(
      new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetcher, calls };
}

interface DispatchResult {
  fetchCalls: CapturedFetch[];
  outputs: FunctionCallOutputEvent[];
}

async function run(opts: {
  toolName: string;
  argumentsJson: string;
  response?: { status: number; body?: unknown };
}): Promise<DispatchResult> {
  const outputs: FunctionCallOutputEvent[] = [];
  const { fetcher, calls } = makeFetcher(opts.response ?? { status: 200 });
  await dispatchTalkerTool({
    voiceChatSessionId: SESSION,
    toolName: opts.toolName,
    callId: CALL_ID,
    argumentsJson: opts.argumentsJson,
    relayToken: TOKEN,
    webBaseUrl: BASE_URL,
    sendToOpenAi: (event) => {
      outputs.push(event);
    },
    fetcher: fetcher as unknown as typeof fetch,
  });
  return { fetchCalls: calls, outputs };
}

function output(result: DispatchResult): string {
  expect(result.outputs).toHaveLength(1);
  expect(result.outputs[0]?.type).toBe("conversation.item.create");
  expect(result.outputs[0]?.item.call_id).toBe(CALL_ID);
  return result.outputs[0]?.item.output ?? "";
}

describe("dispatchTalkerTool — local validation", () => {
  it("rejects an unknown tool name with no upstream call", async () => {
    const result = await run({
      toolName: "bogus_tool",
      argumentsJson: '{"prompt":"hi"}',
    });
    expect(result.fetchCalls).toHaveLength(0);
    expect(output(result)).toBe("Inform failed: invalid args.");
  });

  it("rejects unparseable arguments JSON with no upstream call", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: "not json",
    });
    expect(result.fetchCalls).toHaveLength(0);
    expect(output(result)).toBe("Inform failed: invalid args.");
  });

  it("rejects a non-string prompt with no upstream call", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":42}',
    });
    expect(result.fetchCalls).toHaveLength(0);
    expect(output(result)).toBe("Inform failed: invalid args.");
  });

  it("rejects a whitespace-only prompt with no upstream call", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":"   "}',
    });
    expect(result.fetchCalls).toHaveLength(0);
    expect(output(result)).toBe("Inform failed: empty prompt.");
  });
});

describe("dispatchTalkerTool — happy path", () => {
  it("posts to the internal /tasks route and emits the success voice text", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":"summarize latest deploys"}',
    });
    expect(result.fetchCalls).toHaveLength(1);
    const call = result.fetchCalls[0]!;
    expect(call.url).toBe(
      `${BASE_URL}/api/internal/voice-chat/relay/${SESSION}/tasks`,
    );
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toStrictEqual({
      prompt: "summarize latest deploys",
      callId: CALL_ID,
    });
    expect(output(result)).toBe(
      "Slow brain informed: 'summarize latest deploys'. It will decide what to do and report back.",
    );
  });

  it("truncates long prompts with an ellipsis in the voice text", async () => {
    const longPrompt = "a".repeat(200);
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: JSON.stringify({ prompt: longPrompt }),
    });
    const out = output(result);
    expect(out).toMatch(/Slow brain informed: '.*…'/);
    // 60-char limit minus 1 for the ellipsis = 59 'a' chars + '…'.
    expect(out).toContain("a".repeat(59) + "…");
  });

  it("works for any name in SESSION_TOOL_NAMES, not just inform_slow_brain", async () => {
    const result = await run({
      toolName: "feel_confused",
      argumentsJson: '{"prompt":"what did the user mean?"}',
    });
    expect(result.fetchCalls).toHaveLength(1);
    expect(output(result)).toContain("Slow brain informed:");
  });
});

describe("dispatchTalkerTool — upstream failure mapping", () => {
  it("maps 400 'NO_AGENT' to 'Slow brain not available for this session.'", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":"hi"}',
      response: {
        status: 400,
        body: {
          error: {
            message: "Session has no agent; cannot spawn task",
            code: "NO_AGENT",
          },
        },
      },
    });
    expect(output(result)).toBe("Slow brain not available for this session.");
  });

  it("maps 400 with a generic BAD_REQUEST code to the catch-all retry voice text", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":"hi"}',
      response: {
        status: 400,
        body: {
          error: { message: "Invalid request body", code: "BAD_REQUEST" },
        },
      },
    });
    expect(output(result)).toBe(
      "Failed to reach the slow brain. Please try again or rephrase.",
    );
  });

  it("maps generic 4xx to the catch-all retry voice text", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":"hi"}',
      response: {
        status: 401,
        body: { error: { message: "unauthorized" } },
      },
    });
    expect(output(result)).toBe(
      "Failed to reach the slow brain. Please try again or rephrase.",
    );
  });

  it("maps 5xx to the catch-all retry voice text", async () => {
    const result = await run({
      toolName: "inform_slow_brain",
      argumentsJson: '{"prompt":"hi"}',
      response: { status: 500 },
    });
    expect(output(result)).toBe(
      "Failed to reach the slow brain. Please try again or rephrase.",
    );
  });
});
