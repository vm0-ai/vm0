import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  piModelConfigSchema,
  runSkillSnapshotSchema,
  type RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import { piTranscriptResponseSchema } from "@vm0/api-contracts/contracts/webhooks";
import {
  NodeExecutionEnv,
  parsePiAgentMessages,
  runPiAgentResume,
  type ExecutionEnv,
  type PiAgentEvent,
  type PiAgentMessage,
  type PiAgentModelConfig,
} from "@vm0/pi-agent-runtime/node";
import { z } from "zod";

const RUN_ID_ENV = "VM0_RUN_ID";
const PI_SYSTEM_PROMPT_ENV = "VM0_PI_SYSTEM_PROMPT";
const PI_MODEL_CONFIG_ENV = "VM0_PI_MODEL_CONFIG";
const RUN_SKILL_SNAPSHOT_ENV = "VM0_RUN_SKILL_SNAPSHOT";

export const DEFAULT_PI_STANDBY_TTL_SECONDS = 300;

type PiTranscript = z.infer<typeof piTranscriptResponseSchema>;

const standbyControlSchema = z
  .object({ type: z.literal("pi-handoff") })
  .strict();
const releaseControlSchema = z
  .object({
    type: z.literal("pi-standby-release"),
    reason: z.string().optional(),
  })
  .strict();
const transcriptFrameSchema = z
  .object({
    type: z.literal("pi-transcript"),
    requestId: z.string().min(1),
    transcript: piTranscriptResponseSchema,
  })
  .strict();
const messageAckFrameSchema = z
  .object({
    type: z.literal("pi-message-ack"),
    messageId: z.string().min(1),
    status: z.number().int(),
    error: z.string().optional(),
  })
  .strict();
const inboundFrameSchema = z.discriminatedUnion("type", [
  standbyControlSchema,
  releaseControlSchema,
  transcriptFrameSchema,
  messageAckFrameSchema,
]);

type InboundFrame = z.infer<typeof inboundFrameSchema>;

export interface PiAgentLoopIo {
  read(): Promise<unknown | null>;
  write(frame: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface PiStandbyAgentConfig {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly model: PiAgentModelConfig;
  readonly skillSnapshot: RunSkillSnapshot;
}

export type PiAgentResume = typeof runPiAgentResume;

class PiTranscriptConflict extends Error {}
class PiStandbyReleased extends Error {}

interface TranscriptTail {
  readonly version: number;
  lastOrdinal: number;
  nextSequence: number;
  lastAcknowledgedSequence: number | undefined;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required for Pi standby`);
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

/** Resolve the immutable Pi runtime inputs injected by guest-agent. */
export function piStandbyAgentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PiStandbyAgentConfig {
  const parsedModel = piModelConfigSchema.parse(
    parseJsonEnv(env, PI_MODEL_CONFIG_ENV),
  );
  const { apiKeyEnv, ...model } = parsedModel;
  const apiKey = requiredEnv(env, apiKeyEnv);
  return {
    runId: requiredEnv(env, RUN_ID_ENV),
    systemPrompt: requiredEnv(env, PI_SYSTEM_PROMPT_ENV),
    model: { ...model, apiKey },
    skillSnapshot: runSkillSnapshotSchema.parse(
      parseJsonEnv(env, RUN_SKILL_SNAPSHOT_ENV),
    ),
  };
}

function systemPromptDigest(systemPrompt: string): string {
  return `sha256:${createHash("sha256").update(systemPrompt).digest("hex")}`;
}

function transcriptTail(
  transcript: PiTranscript,
  runId: string,
): TranscriptTail {
  let lastRunSequence = 0;
  for (const message of transcript.messages) {
    if (message.runId === runId) {
      lastRunSequence = Math.max(
        lastRunSequence,
        message.runEventSequenceNumber,
      );
    }
  }
  return {
    version: transcript.version,
    lastOrdinal: transcript.lastOrdinal,
    nextSequence: lastRunSequence + 1,
    lastAcknowledgedSequence:
      lastRunSequence === 0 ? undefined : lastRunSequence,
  };
}

async function readFrame(io: PiAgentLoopIo): Promise<InboundFrame> {
  const frame = await io.read();
  if (frame === null) {
    throw new Error("Pi agent loop control input closed");
  }
  return inboundFrameSchema.parse(frame);
}

async function readInitialFrame(
  io: PiAgentLoopIo,
  standbyTtlSeconds: number,
): Promise<InboundFrame | null> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      resolve(null);
    }, standbyTtlSeconds * 1000);
  });
  const frame = await Promise.race([readFrame(io), timedOut]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return frame;
}

async function requestTranscript(
  io: PiAgentLoopIo,
  requestNumber: number,
): Promise<PiTranscript> {
  const requestId = `transcript-${requestNumber}`;
  await io.write({ type: "pi-transcript-read", requestId });
  const frame = await readFrame(io);
  if (frame.type === "pi-standby-release") {
    throw new PiStandbyReleased(frame.reason);
  }
  if (frame.type !== "pi-transcript" || frame.requestId !== requestId) {
    throw new Error(`Expected Pi transcript response for ${requestId}`);
  }
  return frame.transcript;
}

function messageFailure(message: PiAgentMessage): string | undefined {
  if (
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted")
  ) {
    return undefined;
  }
  return message.errorMessage ?? `Pi model turn ${message.stopReason}`;
}

async function acknowledgeMessage(
  io: PiAgentLoopIo,
  config: PiStandbyAgentConfig,
  tail: TranscriptTail,
  message: PiAgentMessage,
): Promise<void> {
  const sequenceNumber = tail.nextSequence;
  const messageId = `${config.runId}/${sequenceNumber}`;
  await io.write({
    type: "pi-message",
    event: {
      type: "pi.message.completed",
      sequenceNumber,
      messageId,
      expectedVersion: tail.version,
      expectedLastOrdinal: tail.lastOrdinal,
      message,
    },
  });
  const frame = await readFrame(io);
  if (frame.type === "pi-standby-release") {
    throw new PiStandbyReleased(frame.reason);
  }
  if (frame.type !== "pi-message-ack" || frame.messageId !== messageId) {
    throw new Error(`Expected acknowledgement for Pi message ${messageId}`);
  }
  if (frame.status === 409) {
    throw new PiTranscriptConflict(frame.error);
  }
  if (frame.status !== 200) {
    throw new Error(
      frame.error ?? `Pi message ${messageId} failed with ${frame.status}`,
    );
  }
  tail.lastOrdinal += 1;
  tail.nextSequence += 1;
  tail.lastAcknowledgedSequence = sequenceNumber;
}

async function resumeFromTranscript(args: {
  readonly io: PiAgentLoopIo;
  readonly config: PiStandbyAgentConfig;
  readonly transcript: PiTranscript;
  readonly executionEnv: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly resume: PiAgentResume;
}): Promise<{
  readonly failure: string | undefined;
  readonly lastAcknowledgedSequence: number | undefined;
}> {
  const messages = parsePiAgentMessages(
    args.transcript.messages.map((message) => {
      return message.payload;
    }),
  );
  const tail = transcriptTail(args.transcript, args.config.runId);
  let failure: string | undefined;
  await args.resume({
    model: args.config.model,
    systemPrompt: args.config.systemPrompt,
    messages,
    executionEnv: args.executionEnv,
    signal: args.signal,
    async onEvent(event: PiAgentEvent) {
      if (event.type !== "message_end") {
        return;
      }
      await acknowledgeMessage(args.io, args.config, tail, event.message);
      failure ??= messageFailure(event.message);
    },
  });
  return {
    failure,
    lastAcknowledgedSequence: tail.lastAcknowledgedSequence,
  };
}

/** Run the internal one-shot Pi standby protocol used by guest-agent. */
export async function runPiStandbyAgentLoop(args: {
  readonly io: PiAgentLoopIo;
  readonly config: PiStandbyAgentConfig;
  readonly executionEnv: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly standbyTtlSeconds?: number;
  readonly resume?: PiAgentResume;
}): Promise<void> {
  const promptDigest = systemPromptDigest(args.config.systemPrompt);
  await args.io.write({
    type: "pi-ready",
    runId: args.config.runId,
    systemPromptDigest: promptDigest,
    skillSnapshotDigest: args.config.skillSnapshot.digest,
  });
  const initialFrame = await readInitialFrame(
    args.io,
    args.standbyTtlSeconds ?? DEFAULT_PI_STANDBY_TTL_SECONDS,
  );
  if (initialFrame === null) {
    await args.io.write({ type: "pi-released", reason: "ttl" });
    return;
  }
  if (initialFrame.type === "pi-standby-release") {
    await args.io.write({
      type: "pi-released",
      reason: initialFrame.reason ?? "api-complete",
    });
    return;
  }
  if (initialFrame.type !== "pi-handoff") {
    throw new Error("Pi standby expected a handoff or release control");
  }

  let requestNumber = 0;
  while (!args.signal.aborted) {
    requestNumber += 1;
    const transcript = await requestTranscript(args.io, requestNumber);
    try {
      const result = await resumeFromTranscript({
        io: args.io,
        config: args.config,
        transcript,
        executionEnv: args.executionEnv,
        signal: args.signal,
        resume: args.resume ?? runPiAgentResume,
      });
      await args.io.write({
        type: "pi-complete",
        exitCode: result.failure === undefined ? 0 : 1,
        ...(result.failure === undefined ? {} : { error: result.failure }),
        ...(result.lastAcknowledgedSequence === undefined
          ? {}
          : { lastEventSequence: result.lastAcknowledgedSequence }),
        systemPromptDigest: promptDigest,
        skillSnapshotDigest: args.config.skillSnapshot.digest,
      });
      return;
    } catch (error) {
      if (error instanceof PiTranscriptConflict) {
        await args.io.write({ type: "pi-transcript-conflict" });
        continue;
      }
      if (error instanceof PiStandbyReleased) {
        await args.io.write({ type: "pi-released", reason: "api-complete" });
        return;
      }
      throw error;
    }
  }
  args.signal.throwIfAborted();
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

export function createPiNodeExecutionEnv(): NodeExecutionEnv {
  return new NodeExecutionEnv({
    cwd: process.cwd(),
    shellEnv: process.env,
  });
}
