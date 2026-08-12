import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  resolvePiAgentModel,
  runPiAgentPrompt,
  runPiAgentResume,
} from "./agent-loop";

const CODEX_ACCOUNT_ID_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_PLACEHOLDER_ACCOUNT_ID = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
const DEEPSEEK_RESPONSES_URL = "https://api.deepseek.com/responses";
const server = setupServer();

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function responsesToolSse(args: {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}): string {
  const serializedArguments = JSON.stringify(args.arguments);
  const functionItem = {
    type: "function_call",
    id: `fc_${args.id}`,
    call_id: args.id,
    name: args.name,
    arguments: serializedArguments,
    status: "completed",
  };
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_pi_tool_test",
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionItem, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: serializedArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: serializedArguments,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: functionItem,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_pi_tool_test",
        object: "response",
        status: "completed",
        output: [functionItem],
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

function assistantToolMessage(args: {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", ...args }],
    api: "openai-responses",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function isDeadlineCallback(value: unknown): value is () => void {
  return typeof value === "function";
}

function fireScheduledDeadline(
  call: readonly unknown[] | undefined,
  expectedTimeoutMs: number,
): void {
  if (!call) {
    throw new Error("Expected a scheduled Pi tool deadline");
  }
  const [callback, timeoutMs] = call;
  if (!isDeadlineCallback(callback)) {
    throw new Error("Expected the Pi tool deadline callback");
  }
  callback();
  expect(timeoutMs).toBe(expectedTimeoutMs);
}

function waitForAbort(controller: AbortController): Promise<void> {
  if (controller.signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

class LaterBashExecutionEnv extends NodeExecutionEnv {
  readonly started = new AbortController();
  readonly abortedCommands: string[] = [];

  override exec(
    command: string,
    options?: Parameters<NodeExecutionEnv["exec"]>[1],
  ): ReturnType<NodeExecutionEnv["exec"]> {
    if (command !== "never-finish") {
      return super.exec(command, options);
    }
    options?.abortSignal?.addEventListener(
      "abort",
      () => {
        this.abortedCommands.push(command);
      },
      { once: true },
    );
    this.started.abort();
    return new Promise<never>(() => {});
  }
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
    const accessToken = codexJwt("ws_acct_pi_edge_real");
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

  it("returns a structured timeout from a later Pi tool batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-later-timeout-"));
    const initialPath = join(root, "initial.txt");
    await writeFile(initialPath, "initial tool result\n");
    const env = new LaterBashExecutionEnv({ cwd: root });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const requestBodies: unknown[] = [];
    const events: AgentEvent[] = [];
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, async ({ request }) => {
        const body: unknown = await request.json();
        requestBodies.push(body);
        return sseResponse(
          requestBodies.length === 1
            ? responsesToolSse({
                id: "later-bash",
                name: "bash",
                arguments: { command: "never-finish", timeout: 60 },
              })
            : responsesTextSse("recovered after timeout"),
        );
      }),
    );

    try {
      const messagesPromise = runPiAgentResume(
        {
          model: {
            provider: "deepseek",
            baseUrl: DEEPSEEK_BASE_URL,
            apiKey: "sk-deepseek-pi-responses",
            model: "deepseek-v4-flash",
          },
          systemPrompt: "You are a test Pi agent.",
          messages: [
            assistantToolMessage({
              id: "initial-read|fc_initial-read",
              name: "read",
              arguments: { path: initialPath },
            }),
          ],
          executionEnv: env,
          onEvent(event) {
            events.push(event);
          },
        },
        new AbortController().signal,
      );

      await waitForAbort(env.started);
      const laterDeadline = timeoutSpy.mock.calls.find((call) => {
        return call[1] === 60_000;
      });
      fireScheduledDeadline(laterDeadline, 60_000);
      const messages = await messagesPromise;

      expect(requestBodies).toHaveLength(2);
      expect(JSON.stringify(requestBodies[0])).toContain(
        "Timeout in seconds (optional; default 600, maximum 1800)",
      );
      expect(JSON.stringify(requestBodies[1])).toContain(
        "Tool execution timed out after 60 seconds",
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "bash",
          isError: true,
          details: { code: "tool_timeout", timeoutMs: 60_000 },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "message_end",
          message: expect.objectContaining({
            role: "toolResult",
            toolName: "bash",
            isError: true,
            details: { code: "tool_timeout", timeoutMs: 60_000 },
          }),
        }),
      );
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "recovered after timeout" }],
      });
      expect(env.abortedCommands).toEqual(["never-finish"]);
    } finally {
      timeoutSpy.mockRestore();
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates parent cancellation from a later Pi tool batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-later-cancel-"));
    const initialPath = join(root, "initial.txt");
    await writeFile(initialPath, "initial tool result\n");
    const env = new LaterBashExecutionEnv({ cwd: root });
    const controller = new AbortController();
    server.use(
      http.post(DEEPSEEK_RESPONSES_URL, () => {
        return sseResponse(
          responsesToolSse({
            id: "later-bash-cancel",
            name: "bash",
            arguments: { command: "never-finish", timeout: 60 },
          }),
        );
      }),
    );

    try {
      const messagesPromise = runPiAgentResume(
        {
          model: {
            provider: "deepseek",
            baseUrl: DEEPSEEK_BASE_URL,
            apiKey: "sk-deepseek-pi-responses",
            model: "deepseek-v4-flash",
          },
          systemPrompt: "You are a test Pi agent.",
          messages: [
            assistantToolMessage({
              id: "initial-read|fc_initial-read",
              name: "read",
              arguments: { path: initialPath },
            }),
          ],
          executionEnv: env,
          onEvent() {},
        },
        controller.signal,
      );

      await waitForAbort(env.started);
      const reason = new Error("parent cancelled later Pi tool");
      reason.name = "AbortError";
      controller.abort(reason);

      await expect(messagesPromise).rejects.toBe(reason);
      expect(env.abortedCommands).toEqual(["never-finish"]);
    } finally {
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates parent cancellation while result persistence is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-persistence-cancel-"));
    const initialPath = join(root, "initial.txt");
    await writeFile(initialPath, "initial tool result\n");
    const env = new NodeExecutionEnv({ cwd: root });
    const controller = new AbortController();
    const persistenceStarted = new AbortController();

    try {
      const messagesPromise = runPiAgentResume(
        {
          model: {
            provider: "deepseek",
            baseUrl: DEEPSEEK_BASE_URL,
            apiKey: "sk-deepseek-pi-responses",
            model: "deepseek-v4-flash",
          },
          systemPrompt: "You are a test Pi agent.",
          messages: [
            assistantToolMessage({
              id: "initial-read|fc_initial-read",
              name: "read",
              arguments: { path: initialPath },
            }),
          ],
          executionEnv: env,
          onEvent(event) {
            if (
              event.type === "message_end" &&
              event.message.role === "toolResult"
            ) {
              persistenceStarted.abort();
              return new Promise<never>(() => {});
            }
          },
        },
        controller.signal,
      );

      await waitForAbort(persistenceStarted);
      const reason = new Error("parent cancelled pending persistence");
      reason.name = "AbortError";
      controller.abort(reason);

      await expect(messagesPromise).rejects.toBe(reason);
    } finally {
      await env.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
