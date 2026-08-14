import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    launchConfig: { schemaVersion: 2 },
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
    }),
    OPENAI_API_KEY: "test-api-key",
  };
}

function toolNames(body: unknown): string[] {
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }
    const candidate = tool as {
      name?: unknown;
      function?: { name?: unknown };
    };
    const name = candidate.name ?? candidate.function?.name;
    return typeof name === "string" ? [name] : [];
  });
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

  it("uses official discovery, tools, steer, compaction defaults, and JSONL resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "vm0-pi-rpc-host-"));
    const agentDir = join(root, ".pi", "agent");
    const sessionDir = join(agentDir, "sessions", "--test--");
    const skillName = "rpc-integration";
    const skillDirectory = join(agentDir, "skills", skillName);
    const provider = await ProviderHarness.start();
    let host: RpcHost | undefined;
    let resumedHost: RpcHost | undefined;

    try {
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(
        join(agentDir, "AGENTS.md"),
        "Mounted official Pi agent instructions.",
      );
      await writeFile(
        join(skillDirectory, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: Mounted official Pi integration skill.\n---\nRead the official Pi skill body before answering.\n`,
      );
      const payloadFile = join(root, "launch-payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          schemaVersion: 1,
          appendSystemPrompt: "Mounted official Pi append prompt.",
          launchConfig: { schemaVersion: 2 },
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
        }),
        OPENAI_API_KEY: "pi-rpc-test-key",
      };

      host = new RpcHost({ cwd: root, agentDir, sessionDir, env });
      const initialState = await host.state("initial-state");
      expect(initialState).toMatchObject({
        sessionId: SESSION_ID,
        autoCompactionEnabled: true,
        messageCount: 0,
      });
      const sessionFile = initialState.sessionFile;
      expect(typeof sessionFile).toBe("string");
      expect(String(sessionFile).startsWith(`${sessionDir}/`)).toBe(true);
      expect(String(sessionFile)).toContain(SESSION_ID);
      expect(String(sessionFile).endsWith(".jsonl")).toBe(true);

      host.send({
        id: "initial",
        type: "prompt",
        message: `/skill:${skillName} complete the initial turn`,
      });
      await host.waitFor((record) => {
        return record.type === "response" && record.id === "initial";
      });
      const initialRequest = await provider.nextRequest();

      host.send({
        id: "steer",
        type: "steer",
        message: "steer this official turn",
      });
      const steerResponse = await host.waitFor((record) => {
        return record.type === "response" && record.id === "steer";
      });
      expect(steerResponse).toMatchObject({
        command: "steer",
        success: true,
      });
      initialRequest.respond("first official answer");
      const steeredRequest = await provider.nextRequest();
      steeredRequest.respond("steered official answer");
      await host.waitFor((record) => {
        return record.type === "agent_settled";
      });
      await host.close();
      host = undefined;

      const initialBody = JSON.stringify(initialRequest.body);
      expect(initialBody).toContain("Mounted official Pi append prompt.");
      expect(initialBody).toContain("Mounted official Pi agent instructions.");
      expect(initialBody).toContain("Mounted official Pi integration skill.");
      expect(initialBody).toContain(
        "Read the official Pi skill body before answering.",
      );
      expect(toolNames(initialRequest.body).sort()).toEqual(
        ["bash", "edit", "read", "write"].sort(),
      );
      expect(JSON.stringify(steeredRequest.body)).toContain(
        "steer this official turn",
      );

      const persisted = await readFile(String(sessionFile), "utf8");
      const entries = persisted
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      expect(entries[0]).toMatchObject({
        type: "session",
        id: SESSION_ID,
        cwd: root,
      });
      expect(persisted).toContain("complete the initial turn");
      expect(persisted).toContain("steer this official turn");
      expect(persisted).toContain("steered official answer");

      resumedHost = new RpcHost({ cwd: root, agentDir, sessionDir, env });
      const resumedState = await resumedHost.state("resumed-state");
      expect(resumedState.sessionFile).toBe(sessionFile);
      expect(Number(resumedState.messageCount)).toBeGreaterThan(0);
      expect(resumedState.autoCompactionEnabled).toBe(true);
      await resumedHost.close();
      resumedHost = undefined;
    } finally {
      await host?.terminate();
      await resumedHost?.terminate();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
