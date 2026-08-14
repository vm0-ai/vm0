import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createInterface, type Interface } from "node:readline";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_PI_SESSION_DATABASE_PATH,
  PI_SKILLS_ROOT,
} from "@okouai/api-contracts/contracts/runners";
import {
  createNodeSqliteFactory,
  SqliteSessionRepository,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPiNodeExecutionEnv,
  piSandboxAgentConfigFromEnv,
  type PiSandboxAgentConfig,
} from "./pi-agent-loop";

const RUN_ID = "00000000-0000-4000-8000-000000000123";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SHA256_ZERO = `sha256:${"0".repeat(64)}`;
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
      schemaVersion: 1,
      agentName: "Sandbox Test Agent",
      skillSnapshot: {
        schemaVersion: 1,
        policyVersion: 1,
        root: PI_SKILLS_ROOT,
        digest: `sha256:${"0".repeat(64)}`,
        entries: [],
      },
      agentInstructionsPath: null,
      memory: null,
    },
  },
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/",
    model: "deepseek-v4-flash",
    apiKey: "test-api-key",
  },
  databasePath: CANONICAL_PI_SESSION_DATABASE_PATH,
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

class RpcHost {
  readonly records: Array<Record<string, unknown>> = [];
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: Interface;
  readonly #iterator: AsyncIterableIterator<string>;
  #stderr = "";

  constructor(args: {
    readonly cwd: string;
    readonly databasePath: string;
    readonly env: NodeJS.ProcessEnv;
  }) {
    this.#child = spawn(
      process.execPath,
      ["--import", TSX_IMPORT, RPC_FIXTURE, args.databasePath],
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

describe("sandbox Pi agent loop", () => {
  it("resolves the Pi session, launch payload file, and model credential", async () => {
    await expect(
      piSandboxAgentConfigFromEnv(
        piEnv({
          OKOU_RUN_ID: RUN_ID,
        }),
      ),
    ).resolves.toEqual(CONFIG);
  });

  it("uses the canonical name when the run id is missing", async () => {
    await expect(piSandboxAgentConfigFromEnv(piEnv({}))).rejects.toThrowError(
      "OKOU_RUN_ID is required for Pi execution",
    );
  });

  it("requires the launch payload file instead of an inline launch config", async () => {
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    delete env.OKOU_PI_LAUNCH_PAYLOAD_FILE;

    await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrowError(
      "OKOU_PI_LAUNCH_PAYLOAD_FILE is required for Pi execution",
    );
  });

  it("names the canonical variable without exposing invalid model config", async () => {
    const invalidModelConfig = "credential-like-model-config{";
    const env = piEnv({ OKOU_RUN_ID: RUN_ID });
    env.OKOU_PI_MODEL_CONFIG = invalidModelConfig;

    await expect(piSandboxAgentConfigFromEnv(env)).rejects.toThrowError(
      "OKOU_PI_MODEL_CONFIG must contain valid JSON",
    );
    try {
      await piSandboxAgentConfigFromEnv(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(invalidModelConfig);
    }
  });

  it("runs the official RPC host with mounted resources, steer, persistence, and EOF shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "vm0-pi-rpc-host-"));
    const sessionDirectory = join(root, "sessions");
    const databasePath = join(sessionDirectory, "sessions.sqlite");
    const instructionsPath = join(root, "AGENTS.md");
    const memoryDirectory = join(root, "memory");
    const memoryPath = join(memoryDirectory, "MEMORY.md");
    await mkdir(PI_SKILLS_ROOT, { recursive: true });
    const skillDirectory = await mkdtemp(join(PI_SKILLS_ROOT, "rpc-host-"));
    const skillName = basename(skillDirectory);
    const skillFile = join(skillDirectory, "SKILL.md");
    const provider = await ProviderHarness.start();
    let host: RpcHost | undefined;

    try {
      await mkdir(sessionDirectory, { recursive: true });
      await mkdir(memoryDirectory, { recursive: true });
      await writeFile(
        skillFile,
        `---\nname: ${skillName}\ndescription: Mounted RPC integration Skill.\n---\nRead the mounted RPC skill body before answering.\n`,
      );
      await writeFile(instructionsPath, "Mounted RPC agent instructions.");
      await writeFile(memoryPath, "Mounted RPC memory prefix.\n");
      const payloadFile = join(root, "launch-payload.json");
      await writeFile(
        payloadFile,
        JSON.stringify({
          schemaVersion: 1,
          appendSystemPrompt: "Mounted RPC append prompt.",
          launchConfig: {
            schemaVersion: 1,
            agentName: "RPC Integration Agent",
            skillSnapshot: {
              schemaVersion: 1,
              policyVersion: 1,
              root: PI_SKILLS_ROOT,
              digest: SHA256_ZERO,
              entries: [
                {
                  logicalDir: skillDirectory,
                  skillFile,
                  orgId: "org_rpc_test",
                  userId: "user_rpc_test",
                  storageName: skillName,
                  storageId: "storage_rpc_test",
                  versionId: "version_rpc_test",
                },
              ],
            },
            agentInstructionsPath: instructionsPath,
            memory: { directory: memoryDirectory, primaryFile: memoryPath },
          },
        }),
        { mode: 0o600 },
      );
      host = new RpcHost({
        cwd: root,
        databasePath,
        env: {
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
        },
      });

      host.send({ id: "state", type: "get_state" });
      const state = await host.waitFor((record) => {
        return record.type === "response" && record.id === "state";
      });
      expect(state).toMatchObject({
        command: "get_state",
        success: true,
        data: { sessionId: SESSION_ID },
      });

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
        type: "prompt",
        message: "steer this official turn",
        streamingBehavior: "steer",
      });
      const steerResponse = await host.waitFor((record) => {
        return record.type === "response" && record.id === "steer";
      });
      expect(steerResponse).toMatchObject({
        command: "prompt",
        success: true,
      });
      initialRequest.respond("first official answer");
      const steeredRequest = await provider.nextRequest();
      steeredRequest.respond("steered official answer");

      await host.waitFor((record) => {
        return record.type === "agent_settled";
      });
      expect(host.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message_end",
            message: expect.objectContaining({
              role: "assistant",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "text",
                  text: "steered official answer",
                }),
              ]),
            }),
          }),
        ]),
      );
      await host.close();
      host = undefined;

      const initialBody = JSON.stringify(initialRequest.body);
      expect(initialBody).toContain("Mounted RPC append prompt.");
      expect(initialBody).toContain("Mounted RPC agent instructions.");
      expect(initialBody).toContain("Mounted RPC memory prefix.");
      expect(initialBody).toContain("Mounted RPC integration Skill.");
      expect(initialBody).toContain(
        "Read the mounted RPC skill body before answering.",
      );
      expect(JSON.stringify(steeredRequest.body)).toContain(
        "steer this official turn",
      );

      const repositoryEnv = await createPiNodeExecutionEnv();
      const repository = new SqliteSessionRepository({
        env: repositoryEnv,
        sqlite: createNodeSqliteFactory(),
        databasePath,
      });
      try {
        const metadata = (await repository.list()).find((entry) => {
          return entry.id === SESSION_ID;
        });
        expect(metadata).toBeDefined();
        if (!metadata) {
          throw new Error("Pi RPC integration session was not persisted");
        }
        const session = await repository.open(metadata);
        const entries = await session.findEntriesOnBranch({
          type: "message",
          order: "oldestFirst",
        });
        const persisted = JSON.stringify(entries);
        expect(persisted).toContain("complete the initial turn");
        expect(persisted).toContain("steer this official turn");
        expect(persisted).toContain("steered official answer");
      } finally {
        await repository.close();
        await repositoryEnv.cleanup();
      }
    } finally {
      await host?.terminate();
      await provider.close();
      await rm(root, { recursive: true, force: true });
      await rm(skillDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
