import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";

import {
  piSandboxAgentConfigFromEnv,
  type PiSandboxAgentConfig,
} from "./pi-agent-loop";

const RUN_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RPC_FIXTURE = fileURLToPath(
  new URL("../test/fixtures/pi-agent-loop-rpc-host.ts", import.meta.url),
);
const TSX_IMPORT = import.meta.resolve("tsx");
const CONFIG: PiSandboxAgentConfig = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  launchPayload: {
    schemaVersion: 1,
    appendSystemPrompt: "exact immutable Pi append prompt",
    launchConfig: {
      schemaVersion: 2,
      apiFirstTurn: {
        schemaVersion: 1,
        resourceSnapshotDigest: "a".repeat(64),
        manifestUrl: "https://handoff.example/manifest.json",
        sessionUrl: "https://handoff.example/session.jsonl",
        deadlineAt: 2_000_000_000_000,
        baseSession: { sessionId: SESSION_ID, sha256: null },
        sandboxEventSequenceStart: 1,
      },
    },
  },
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-flash",
    apiKey: "test-api-key",
  },
};

let launchPayloadDirectory = "";
let launchPayloadFile = "";

interface ProviderRequest {
  readonly body: unknown;
  respond(text: string): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function responsesTextSse(text: string, sequence: number): string {
  const responseId = `resp_pi_rpc_${sequence}`;
  const messageId = `msg_pi_rpc_${sequence}`;
  const events = [
    {
      type: "response.created",
      response: {
        id: responseId,
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
        id: messageId,
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
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
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

function writeSseResponse(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(body);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class ProviderHarness {
  readonly requests: ProviderRequest[] = [];
  readonly #waiters: Array<Deferred<ProviderRequest>> = [];
  readonly #server: Server;
  #nextRequestIndex = 0;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(): Promise<ProviderHarness> {
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as unknown;
        const sequence = harness.requests.length + 1;
        const providerRequest: ProviderRequest = {
          body,
          respond(text) {
            writeSseResponse(response, responsesTextSse(text, sequence));
          },
        };
        harness.#recordRequest(providerRequest);
      })().catch((error: unknown) => {
        response.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
    const harness = new ProviderHarness(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return harness;
  }

  get baseUrl(): string {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Pi provider test server has no TCP address");
    }
    return `http://127.0.0.1:${address.port}/`;
  }

  async nextRequest(): Promise<ProviderRequest> {
    const index = this.#nextRequestIndex;
    this.#nextRequestIndex += 1;
    const existing = this.requests[index];
    if (existing) {
      return existing;
    }
    const waiter = deferred<ProviderRequest>();
    this.#waiters.push(waiter);
    return await withTimeout(waiter.promise, "Pi provider request");
  }

  #recordRequest(request: ProviderRequest): void {
    this.requests.push(request);
    this.#waiters.shift()?.resolve(request);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

class RpcHost {
  readonly records: Array<Record<string, unknown>> = [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #iterator: AsyncIterableIterator<string>;
  #stderr = "";

  constructor(args: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionDir: string;
    readonly env: NodeJS.ProcessEnv;
  }) {
    this.#child = spawn(
      process.execPath,
      ["--import", TSX_IMPORT, RPC_FIXTURE, args.agentDir, args.sessionDir],
      {
        cwd: args.cwd,
        env: args.env,
        stdio: "pipe",
      },
    );
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#lines = createInterface({
      input: this.#child.stdout,
      crlfDelay: Infinity,
    });
    this.#iterator = this.#lines[Symbol.asyncIterator]();
  }

  send(command: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async waitFor(
    predicate: (record: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const next = await withTimeout(
        this.#iterator.next(),
        "Pi RPC stdout record",
      );
      if (next.done) {
        throw new Error(`Pi RPC host exited early: ${this.#stderr}`);
      }
      const record = JSON.parse(next.value) as Record<string, unknown>;
      this.records.push(record);
      if (predicate(record)) {
        return record;
      }
    }
  }

  async state(id: string): Promise<Record<string, unknown>> {
    this.send({ id, type: "get_state" });
    const response = await this.waitFor((record) => {
      return record.type === "response" && record.id === id;
    });
    return response.data as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    const [code, signal] = await withTimeout(
      once(this.#child, "exit") as Promise<
        [number | null, NodeJS.Signals | null]
      >,
      "Pi RPC host exit",
    );
    this.#lines.close();
    expect(signal).toBeNull();
    expect(code, this.#stderr).toBe(0);
  }

  async terminate(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await once(this.#child, "exit");
    }
    this.#lines.close();
  }
}

beforeEach(async () => {
  launchPayloadDirectory = await mkdtemp(join(tmpdir(), "vm0-pi-launch-"));
  launchPayloadFile = join(launchPayloadDirectory, "payload.json");
  await writeFile(launchPayloadFile, JSON.stringify(CONFIG.launchPayload));
});

afterEach(async () => {
  await rm(launchPayloadDirectory, { recursive: true, force: true });
});

function piEnv(runIdEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...runIdEnv,
    OKOU_PI_SESSION_ID: SESSION_ID,
    OKOU_PI_LAUNCH_PAYLOAD_FILE: launchPayloadFile,
    OKOU_PI_MODEL_CONFIG: JSON.stringify({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "DEEPSEEK_API_KEY",
    }),
    OPENAI_API_KEY: "test-api-key",
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("sandbox Pi agent loop", () => {
  it("resolves the Pi session, launch payload file, and model credential", async () => {
    await expect(
      piSandboxAgentConfigFromEnv(piEnv({ OKOU_RUN_ID: RUN_ID })),
    ).resolves.toEqual(CONFIG);
  });

  it("requires the run id", async () => {
    await expect(piSandboxAgentConfigFromEnv(piEnv({}))).rejects.toThrowError(
      "OKOU_RUN_ID is required for Pi execution",
    );
  });

  it("requires the private launch payload file", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    delete env.OKOU_PI_LAUNCH_PAYLOAD_FILE;
    await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrowError(
      "OKOU_PI_LAUNCH_PAYLOAD_FILE is required for Pi execution",
    );
  });

  it("rejects a launch payload without the required handoff slot", async () => {
    await writeFile(
      launchPayloadFile,
      JSON.stringify({
        schemaVersion: 1,
        appendSystemPrompt: null,
        launchConfig: { schemaVersion: 2 },
      }),
    );

    await expect(
      piSandboxAgentConfigFromEnv(piEnv({ OKOU_RUN_ID: RUN_ID })),
    ).rejects.toThrow();
  });

  it("does not echo malformed model config", async () => {
    const invalidModelConfig = "credential-like-model-config{";
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = invalidModelConfig;

    try {
      await piSandboxAgentConfigFromEnv(env);
      throw new Error("Expected malformed Pi model config to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("OKOU_PI_MODEL_CONFIG must contain valid JSON");
      expect(message).not.toContain(invalidModelConfig);
    }
  });

  it("restores API H1, executes its pending tool, and continues without replaying the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "vm0-pi-handoff-rpc-"));
    const agentDir = join(root, ".pi", "agent");
    const sessionDir = join(agentDir, "sessions", "--test--");
    const sourceFile = join(root, "handoff-source.txt");
    const prompt = "read the handoff source exactly once";
    const provider = await ProviderHarness.start();
    const memory = MemoryPiSession.create({ cwd: root, id: SESSION_ID });
    memory.prepareModelTurn({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-responses",
      provider: "deepseek",
      baseUrl: provider.baseUrl,
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        max: "max",
      },
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
    memory.appendMessage({ role: "user", content: prompt, timestamp: 1 });
    memory.appendMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "API-first reasoning preserved for the tool handoff",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_api_handoff",
            content: [
              {
                type: "reasoning_text",
                text: "API-first reasoning preserved for the tool handoff",
              },
            ],
            summary: [],
          }),
        },
        {
          type: "toolCall",
          id: "api-read-call",
          name: "read",
          arguments: { path: sourceFile },
        },
      ],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    const h1 = memory.toJsonl();
    const manifest = {
      schemaVersion: 2,
      outcome: "handoff",
      baseSession: { sessionId: SESSION_ID, sha256: null },
      session: {
        sessionId: SESSION_ID,
        sha256: createHash("sha256").update(h1).digest("hex"),
        rawSize: Buffer.byteLength(h1),
      },
      sandboxEventSequenceStart: 4,
    };
    const handoffServer = createServer((request, response) => {
      if (request.url === "/manifest.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(manifest));
        return;
      }
      if (request.url === "/session.jsonl") {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "content-length": String(Buffer.byteLength(h1)),
        });
        response.end(h1);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    let host: RpcHost | undefined;

    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(sourceFile, "tool output from the sandbox filesystem");
      await new Promise<void>((resolve, reject) => {
        handoffServer.once("error", reject);
        handoffServer.listen(0, "127.0.0.1", () => {
          handoffServer.off("error", reject);
          resolve();
        });
      });
      const address = handoffServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Pi handoff test server has no TCP address");
      }
      const handoffBaseUrl = `http://127.0.0.1:${address.port}`;
      const payloadFile = join(root, "launch-payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          schemaVersion: 1,
          appendSystemPrompt: null,
          launchConfig: {
            schemaVersion: 2,
            apiFirstTurn: {
              schemaVersion: 1,
              resourceSnapshotDigest: "a".repeat(64),
              manifestUrl: `${handoffBaseUrl}/manifest.json`,
              sessionUrl: `${handoffBaseUrl}/session.jsonl`,
              deadlineAt: Date.now() + 10_000,
              baseSession: { sessionId: SESSION_ID, sha256: null },
              sandboxEventSequenceStart: 1,
            },
          },
        }),
        { mode: 0o600 },
      );
      const env = {
        ...process.env,
        OKOU_RUN_ID: RUN_ID,
        OKOU_PI_SESSION_ID: SESSION_ID,
        OKOU_PI_LAUNCH_PAYLOAD_FILE: payloadFile,
        OKOU_PI_MODEL_CONFIG: JSON.stringify({
          provider: "deepseek",
          baseUrl: provider.baseUrl,
          model: "deepseek-v4-flash",
          apiKeyEnv: "OPENAI_API_KEY",
          credentialSecretName: "DEEPSEEK_API_KEY",
        }),
        OPENAI_API_KEY: "pi-handoff-test-key",
      };

      host = new RpcHost({ cwd: root, agentDir, sessionDir, env });
      const state = await host.state("handoff-state");
      expect(host.records[0]).toStrictEqual({
        type: "vm0_pi_api_first_turn_boundary",
        schemaVersion: 1,
        sandboxEventSequenceStart: 4,
      });
      expect(state).toMatchObject({
        sessionId: SESSION_ID,
        messageCount: 2,
      });
      expect(String(state.sessionFile)).toContain("api-first-turn-");

      host.send({ id: "handoff", type: "prompt", message: prompt });
      const continuationRequest = await provider.nextRequest();
      const continuationBody = JSON.stringify(continuationRequest.body);
      expect(continuationBody).toContain(
        "tool output from the sandbox filesystem",
      );
      expect(continuationBody).toContain("rs_api_handoff");
      expect(continuationBody).toContain("reasoning_text");
      expect(occurrences(continuationBody, prompt)).toBe(1);
      continuationRequest.respond("handoff continuation complete");
      await host.waitFor((record) => {
        return record.type === "agent_settled";
      });
      await host.close();
      host = undefined;

      expect(provider.requests).toHaveLength(1);
      const persisted = await readFile(String(state.sessionFile), "utf8");
      expect(occurrences(persisted, prompt)).toBe(1);
      expect(persisted).toContain("api-read-call");
      expect(persisted).toContain("handoff continuation complete");
    } finally {
      await host?.terminate();
      await provider.close();
      await new Promise<void>((resolve, reject) => {
        handoffServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
