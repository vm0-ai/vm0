import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { resolvePiAgentModel, runPiAgentPrompt } from "./agent-loop";
import { runPiAgentSession } from "./session";
import type { PiAgentModelConfig } from "./types";

const CODEX_ACCOUNT_ID_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_PLACEHOLDER_ACCOUNT_ID = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

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

function responsesTextSse(text: string): string {
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

describe("Pi Codex subscription provider", () => {
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

  it("preserves OpenAI-compatible routing for existing providers", () => {
    const model = resolvePiAgentModel({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "unused-for-resolution",
      model: "gpt-5.5",
    });
    expect(model).not.toBeNull();
    expect(model?.api).toBe("openai-completions");
    expect(model?.provider).toBe("openai");
  });

  it("streams a Codex subscription turn with the real ChatGPT JWT", async () => {
    const accessToken = codexJwt("ws_acct_pi_sandbox_real");
    let requestUrl: string | undefined;
    let requestHeaders: Headers | undefined;
    server.use(
      http.post(`${CODEX_BASE_URL}/codex/responses`, ({ request }) => {
        requestUrl = request.url;
        requestHeaders = new Headers(request.headers);
        return sseResponse(responsesTextSse("edge answer"));
      }),
    );
    const env = new NodeExecutionEnv({ cwd: "/home/user/workspace" });
    try {
      const messages = await runPiAgentPrompt(
        {
          model: {
            provider: "codex",
            baseUrl: CODEX_BASE_URL,
            apiKey: accessToken,
            model: "gpt-5.5",
          },
          systemPrompt: "You are a test Pi agent.",
          prompt: "say hello",
          executionEnv: env,
          onEvent() {},
        },
        new AbortController().signal,
      );
      expect(requestUrl).toBe(`${CODEX_BASE_URL}/codex/responses`);
      expect(requestHeaders?.get("authorization")).toBe(
        `Bearer ${accessToken}`,
      );
      expect(requestHeaders?.get("chatgpt-account-id")).toBe(
        "ws_acct_pi_sandbox_real",
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
    let requestHeaders: Headers | undefined;
    server.use(
      http.post(`${CODEX_BASE_URL}/codex/responses`, ({ request }) => {
        requestHeaders = new Headers(request.headers);
        return sseResponse(responsesTextSse("sandbox answer"));
      }),
    );
    const env = new NodeExecutionEnv({ cwd: "/home/user/workspace" });
    try {
      await runPiAgentPrompt(
        {
          model: {
            provider: "codex",
            baseUrl: CODEX_BASE_URL,
            apiKey: "chatgpt-token-CoffeeSafeLocal-not-a-jwt",
            model: "gpt-5.5",
          },
          systemPrompt: "You are a test Pi agent.",
          prompt: "run in the sandbox",
          executionEnv: env,
          onEvent() {},
        },
        new AbortController().signal,
      );
      const authorization = requestHeaders?.get("authorization");
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

describe("Pi DeepSeek provider", () => {
  it("resolves DeepSeek models through the Responses API", () => {
    const model = resolvePiAgentModel({
      provider: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      apiKey: "unused-for-resolution",
      model: "deepseek-v4-flash",
    });
    expect(model).not.toBeNull();
    expect(model?.api).toBe("openai-responses");
    expect(model?.provider).toBe("deepseek");
    expect(model?.baseUrl).toBe(DEEPSEEK_BASE_URL);
  });

  it("streams through the native Responses endpoint with the DeepSeek key", async () => {
    const apiKey = "sk-deepseek-pi-responses";
    let requestBody: unknown;
    let requestHeaders: Headers | undefined;
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        requestBody = await request.json();
        requestHeaders = new Headers(request.headers);
        return sseResponse(responsesTextSse("deepseek answer"));
      }),
    );
    const env = new NodeExecutionEnv({ cwd: "/home/user/workspace" });
    try {
      const messages = await runPiAgentPrompt(
        {
          model: {
            provider: "deepseek",
            baseUrl: DEEPSEEK_BASE_URL,
            apiKey,
            model: "deepseek-v4-flash",
          },
          systemPrompt: "You are a test Pi agent.",
          prompt: "say hello",
          executionEnv: env,
          onEvent() {},
        },
        new AbortController().signal,
      );
      expect(requestHeaders?.get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(requestHeaders?.get("chatgpt-account-id")).toBeNull();
      expect(requestBody).toMatchObject({
        model: "deepseek-v4-flash",
        input: [
          { role: "developer", content: "You are a test Pi agent." },
          {
            role: "user",
            content: [{ type: "input_text", text: "say hello" }],
          },
        ],
        stream: true,
        store: false,
      });
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
      expect(text).toContain("deepseek answer");
    } finally {
      await env.cleanup();
    }
  });

  it("resumes native SQLite history from the checkpointed database file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vm0-pi-session-"));
    const originalDatabase = join(root, "original.sqlite");
    const restoredDatabase = join(root, "restored.sqlite");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const requestBodies: unknown[] = [];
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        requestBodies.push(await request.json());
        return sseResponse(
          responsesTextSse(
            requestBodies.length === 1 ? "first answer" : "second answer",
          ),
        );
      }),
    );
    const firstEnv = new NodeExecutionEnv({ cwd: root });
    const secondEnv = new NodeExecutionEnv({ cwd: root });
    const model: PiAgentModelConfig = {
      provider: "deepseek",
      baseUrl: DEEPSEEK_BASE_URL,
      apiKey: "sk-deepseek-pi-session",
      model: "deepseek-v4-flash",
    };

    try {
      await runPiAgentSession(
        {
          sessionId,
          databasePath: originalDatabase,
          model,
          systemPrompt: "You are a persistent Pi agent.",
          prompt: "first prompt",
          executionEnv: firstEnv,
        },
        new AbortController().signal,
      );
      await copyFile(originalDatabase, restoredDatabase);
      const resumed = await runPiAgentSession(
        {
          sessionId,
          databasePath: restoredDatabase,
          model,
          systemPrompt: "You are a persistent Pi agent.",
          prompt: "second prompt",
          executionEnv: secondEnv,
        },
        new AbortController().signal,
      );

      expect(resumed.finalAssistantMessage?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "second answer",
          }),
        ]),
      );
      expect(JSON.stringify(requestBodies[1])).toContain("first prompt");
      expect(JSON.stringify(requestBodies[1])).toContain("first answer");
      expect(JSON.stringify(requestBodies[1])).toContain("second prompt");
    } finally {
      await firstEnv.cleanup();
      await secondEnv.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
