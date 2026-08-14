import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  CANONICAL_PI_SESSION_DATABASE_PATH,
  piLaunchPayloadSchema,
  piModelConfigSchema,
  type PiLaunchPayload,
} from "@okouai/api-contracts/contracts/runners";
import {
  createPiNodeExecutionEnv as createNodeExecutionEnv,
  preparePiLaunchPrompt,
  runPiAgentSession,
  type ExecutionEnv,
  type PiAgentModelConfig,
  type PiAssistantMessage,
} from "@okouai/pi-agent-runtime/node";
import { z } from "zod";

const RUN_ID_ENV = "OKOU_RUN_ID";
const PI_SESSION_ID_ENV = "OKOU_PI_SESSION_ID";
const PI_LAUNCH_PAYLOAD_FILE_ENV = "OKOU_PI_LAUNCH_PAYLOAD_FILE";
const PI_MODEL_CONFIG_ENV = "OKOU_PI_MODEL_CONFIG";

const userFrameSchema = z
  .object({
    type: z.literal("user"),
    message: z.object({
      role: z.literal("user"),
      content: z.string().min(1),
    }),
  })
  .passthrough();

export interface PiAgentLoopIo {
  read(): Promise<unknown | null>;
  write(frame: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface PiSandboxAgentConfig {
  readonly runId: string;
  readonly sessionId: string;
  readonly launchPayload: PiLaunchPayload;
  readonly model: PiAgentModelConfig;
  readonly databasePath: string;
}

type PiSessionRunner = typeof runPiAgentSession;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required for Pi execution`);
  }
  return value;
}

function parseJsonEnv(env: NodeJS.ProcessEnv, name: string): unknown {
  const value = requiredEnv(env, name);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
}

async function readLaunchPayload(
  env: NodeJS.ProcessEnv,
): Promise<PiLaunchPayload> {
  const path = requiredEnv(env, PI_LAUNCH_PAYLOAD_FILE_ENV);
  const raw = await readFile(path, "utf8");
  return piLaunchPayloadSchema.parse(JSON.parse(raw) as unknown);
}

/**
 * Resolve immutable Pi runtime inputs injected by guest-agent.
 *
 * Prompt-sized inputs arrive through the private launch payload file rather
 * than the child environment, so this reads that file before the first turn.
 */
export async function piSandboxAgentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiSandboxAgentConfig> {
  const runId = requiredEnv(env, RUN_ID_ENV);
  const parsedModel = piModelConfigSchema.parse(
    parseJsonEnv(env, PI_MODEL_CONFIG_ENV),
  );
  const { apiKeyEnv, ...model } = parsedModel;
  const apiKey = requiredEnv(env, apiKeyEnv);
  return {
    runId,
    sessionId: requiredEnv(env, PI_SESSION_ID_ENV),
    launchPayload: await readLaunchPayload(env),
    model: { ...model, apiKey },
    databasePath: CANONICAL_PI_SESSION_DATABASE_PATH,
  };
}

function assistantText(message: PiAssistantMessage): string {
  return message.content
    .flatMap((block) => {
      return block.type === "text" && block.text.trim().length > 0
        ? [block.text]
        : [];
    })
    .join("\n\n");
}

function assistantMessageId(
  config: PiSandboxAgentConfig,
  message: PiAssistantMessage,
): string {
  return (
    message.responseId ??
    `${config.runId}:${message.timestamp}:${message.model}`
  );
}

async function emitAssistantMessage(
  io: PiAgentLoopIo,
  config: PiSandboxAgentConfig,
  message: PiAssistantMessage,
): Promise<void> {
  const text = assistantText(message);
  if (text.length === 0) {
    return;
  }
  await io.write({
    type: "assistant",
    message: {
      id: assistantMessageId(config, message),
      role: "assistant",
      content: [{ type: "text", text }],
      model: message.model,
      usage: {
        input_tokens: message.usage.input,
        output_tokens: message.usage.output,
        cache_read_input_tokens: message.usage.cacheRead,
        cache_creation_input_tokens: message.usage.cacheWrite,
      },
    },
  });
}

/** Run one sandbox-owned Pi turn and persist every native message to SQLite. */
export async function runPiSandboxAgentLoop(
  args: {
    readonly io: PiAgentLoopIo;
    readonly config: PiSandboxAgentConfig;
    readonly executionEnv: ExecutionEnv;
    readonly runSession?: PiSessionRunner;
  },
  signal: AbortSignal,
): Promise<number> {
  const input = await args.io.read();
  if (input === null) {
    throw new Error("Pi agent loop input closed before the user prompt");
  }
  const frame = userFrameSchema.parse(input);
  await args.io.write({
    type: "system",
    subtype: "init",
    session_id: args.config.sessionId,
  });

  const startedAt = Date.now();
  const launchPrompt = await preparePiLaunchPrompt(
    args.executionEnv,
    {
      launchConfig: args.config.launchPayload.launchConfig,
      appendSystemPrompt: args.config.launchPayload.appendSystemPrompt,
      prompt: frame.message.content,
    },
    signal,
  );
  if (launchPrompt.diagnostics.length > 0) {
    process.stderr.write(
      `Pi run Skill catalog contains diagnostics: ${JSON.stringify(launchPrompt.diagnostics)}\n`,
    );
  }
  const runSession = args.runSession ?? runPiAgentSession;
  const result = await runSession(
    {
      sessionId: args.config.sessionId,
      databasePath: args.config.databasePath,
      model: args.config.model,
      systemPrompt: launchPrompt.systemPrompt,
      prompt: launchPrompt.prompt,
      executionEnv: args.executionEnv,
      async onAssistantMessage(message) {
        await emitAssistantMessage(args.io, args.config, message);
      },
    },
    signal,
  );
  const finalMessage = result.finalAssistantMessage;
  const failed =
    finalMessage?.stopReason === "error" ||
    finalMessage?.stopReason === "aborted";
  const text = finalMessage ? assistantText(finalMessage) : "";
  const error = failed
    ? (finalMessage.errorMessage ?? `Pi model turn ${finalMessage.stopReason}`)
    : undefined;
  await args.io.write({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    result: error ?? text,
    session_id: args.config.sessionId,
    duration_ms: Math.max(0, Date.now() - startedAt),
  });
  return failed ? 1 : 0;
}

export class StdioPiAgentLoopIo implements PiAgentLoopIo {
  readonly #readline: Interface;
  readonly #iterator: AsyncIterableIterator<string>;
  readonly #output: Writable;

  constructor(input: Readable, output: Writable) {
    this.#readline = createInterface({ input, crlfDelay: Infinity });
    this.#iterator = this.#readline[Symbol.asyncIterator]();
    this.#output = output;
  }

  async read(): Promise<unknown | null> {
    const next = await this.#iterator.next();
    if (next.done) {
      return null;
    }
    return JSON.parse(next.value) as unknown;
  }

  async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
    if (!this.#output.write(`${JSON.stringify(frame)}\n`)) {
      await once(this.#output, "drain");
    }
  }

  close(): void {
    this.#readline.close();
  }
}

export async function createPiNodeExecutionEnv(): Promise<ExecutionEnv> {
  return createNodeExecutionEnv({
    cwd: process.cwd(),
    shellEnv: process.env,
  });
}
