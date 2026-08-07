import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeExecutionEnv,
  resolvePiAgentModel,
  runPiAgentPrompt,
} from "./node";

const CODEX_ACCOUNT_ID_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_PLACEHOLDER_ACCOUNT_ID = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function codexJwt(accountId: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      [CODEX_ACCOUNT_ID_CLAIM_PATH]: { chatgpt_account_id: accountId },
    }),
  );
  return `${header}.${payload}.signature`;
}

function codexTextSse(text: string): string {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_pi_test",
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_pi_test",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_pi_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_pi_test",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_pi_test",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
        },
      },
    },
  ];
  return events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe("Pi Codex subscription provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves Codex subscription models from the Pi catalog", () => {
    const model = resolvePiAgentModel({
      provider: "codex",
      baseUrl: CODEX_BASE_URL,
      apiKey: "unused-for-resolution",
      model: "gpt-5.5",
    });
    expect(model).not.toBeNull();
    expect(model?.api).toBe("openai-codex-responses");
    expect(model?.provider).toBe("codex");
    expect(model?.baseUrl).toBe(CODEX_BASE_URL);
    expect(model?.compat).toBeDefined();
  });

  it("streams a Codex subscription turn with the real ChatGPT JWT", async () => {
    const accessToken = codexJwt("ws_acct_pi_edge_real");
    const fetchMock = vi.fn(
      async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
        return sseResponse(codexTextSse("edge answer"));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = new NodeExecutionEnv({ cwd: "/home/user/workspace" });
    try {
      const messages = await runPiAgentPrompt({
        model: {
          provider: "codex",
          baseUrl: CODEX_BASE_URL,
          apiKey: accessToken,
          model: "gpt-5.5",
        },
        systemPrompt: "You are a test Pi agent.",
        prompt: "say hello",
        executionEnv: env,
        signal: new AbortController().signal,
        onEvent() {},
      });
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const requestUrl = firstCall?.[0];
      const init = firstCall?.[1];
      expect(requestUrl).toBe(`${CODEX_BASE_URL}/codex/responses`);
      expect(requestHeaders(init).get("authorization")).toBe(
        `Bearer ${accessToken}`,
      );
      expect(requestHeaders(init).get("chatgpt-account-id")).toBe(
        "ws_acct_pi_edge_real",
      );
      const text = messages
        .filter((message) => {
          return message.role === "assistant";
        })
        .flatMap((message) => {
          return message.content
            .filter((block) => {
              return block.type === "text";
            })
            .map((block) => {
              return (block as { text: string }).text;
            });
        })
        .join("");
      expect(text).toContain("edge answer");
    } finally {
      await env.cleanup();
    }
  });

  it("synthesizes a JWT-shaped key for the sandbox placeholder", async () => {
    const fetchMock = vi.fn(
      async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
        return sseResponse(codexTextSse("sandbox answer"));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = new NodeExecutionEnv({ cwd: "/home/user/workspace" });
    try {
      await runPiAgentPrompt({
        model: {
          provider: "codex",
          baseUrl: CODEX_BASE_URL,
          apiKey: "chatgpt-token-CoffeeSafeLocal-not-a-jwt",
          model: "gpt-5.5",
        },
        systemPrompt: "You are a test Pi agent.",
        prompt: "run in the sandbox",
        executionEnv: env,
        signal: new AbortController().signal,
        onEvent() {},
      });
      const init = fetchMock.mock.calls[0]?.[1];
      const authorization = requestHeaders(init).get("authorization");
      expect(authorization).toBeDefined();
      const token = authorization?.slice("Bearer ".length) ?? "";
      const payloadPart = token.split(".")[1] ?? "";
      const payload = JSON.parse(
        Buffer.from(payloadPart, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const auth = payload[CODEX_ACCOUNT_ID_CLAIM_PATH] as {
        chatgpt_account_id?: unknown;
      };
      expect(auth.chatgpt_account_id).toBe(CODEX_PLACEHOLDER_ACCOUNT_ID);
    } finally {
      await env.cleanup();
    }
  });
});
