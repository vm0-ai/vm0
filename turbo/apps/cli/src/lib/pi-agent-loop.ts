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
  createPiNodeExecutionEnv as createNodeExecutionEnv,
  parsePiAgentMessages,
  piMessageRequiresSandbox,
  runPiAgentResume,
  type ExecutionEnv,
  type PiAgentMessage,
  type PiAgentModelConfig,
} from "@vm0/pi-agent-runtime/node";
import { z } from "zod";

const RUN_ID_ENV = "VM0_RUN_ID";
const PI_SYSTEM_PROMPT_ENV = "VM0_PI_SYSTEM_PROMPT";
const PI_MODEL_CONFIG_ENV = "VM0_PI_MODEL_CONFIG";
const RUN_SKILL_SNAPSHOT_ENV = "VM0_RUN_SKILL_SNAPSHOT";

export const DEFAULT_PI_STANDBY_TTL_SECONDS = 300;
const DEFAULT_PI_TRANSCRIPT_POLL_INTERVAL_MS = 10_000;

type PiTranscriptPage = z.infer<typeof piTranscriptResponseSchema>;
type PiTranscriptMessage = PiTranscriptPage["messages"][number];

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

interface TranscriptTail {
  nextSequence: number;
  lastAcknowledgedSequence: number | undefined;
}

interface FollowedTranscript {
  lastOrdinal: number;
  readonly messages: PiTranscriptMessage[];
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
  transcript: FollowedTranscript,
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

class InboundFrames {
  readonly #io: PiAgentLoopIo;
  #pending: Promise<InboundFrame> | undefined;

  constructor(io: PiAgentLoopIo) {
    this.#io = io;
  }

  #next(): Promise<InboundFrame> {
    this.#pending ??= readFrame(this.#io);
    return this.#pending;
  }

  async read(): Promise<InboundFrame> {
    const pending = this.#next();
    const frame = await pending;
    if (this.#pending === pending) {
      this.#pending = undefined;
    }
    return frame;
  }

  async readWithin(timeoutMs: number): Promise<InboundFrame | null> {
    const pending = this.#next();
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        resolve(null);
      }, timeoutMs);
    });
    try {
      const frame = await Promise.race([pending, timedOut]);
      if (frame !== null && this.#pending === pending) {
        this.#pending = undefined;
      }
      return frame;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

function standbyTimeout(): Error {
  return new Error("Pi standby timed out waiting for a persisted tool call");
}

async function readBeforeDeadline(
  frames: InboundFrames,
  deadline: number,
): Promise<InboundFrame> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw standbyTimeout();
  }
  const frame = await frames.readWithin(remainingMs);
  if (frame === null) {
    throw standbyTimeout();
  }
  return frame;
}

type TranscriptRequestResult =
  | { readonly kind: "page"; readonly page: PiTranscriptPage }
  | { readonly kind: "release"; readonly reason: string | undefined };

async function requestTranscript(
  io: PiAgentLoopIo,
  frames: InboundFrames,
  requestNumber: number,
  afterOrdinal: number,
  deadline: number,
): Promise<TranscriptRequestResult> {
  const requestId = `transcript-${requestNumber}`;
  await io.write({
    type: "pi-transcript-read",
    requestId,
    afterOrdinal,
  });
  while (true) {
    const frame = await readBeforeDeadline(frames, deadline);
    if (frame.type === "pi-standby-release") {
      return { kind: "release", reason: frame.reason };
    }
    if (frame.type === "pi-handoff") {
      continue;
    }
    if (frame.type !== "pi-transcript" || frame.requestId !== requestId) {
      throw new Error(`Expected Pi transcript response for ${requestId}`);
    }
    return { kind: "page", page: frame.transcript };
  }
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
  frames: InboundFrames,
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
      message,
    },
  });
  while (true) {
    const frame = await frames.read();
    if (frame.type === "pi-handoff" || frame.type === "pi-standby-release") {
      continue;
    }
    if (frame.type !== "pi-message-ack" || frame.messageId !== messageId) {
      throw new Error(`Expected acknowledgement for Pi message ${messageId}`);
    }
    if (frame.status !== 200) {
      throw new Error(
        frame.error ?? `Pi message ${messageId} failed with ${frame.status}`,
      );
    }
    break;
  }
  tail.nextSequence += 1;
  tail.lastAcknowledgedSequence = sequenceNumber;
}

async function resumeFromTranscript(
  args: {
    readonly io: PiAgentLoopIo;
    readonly frames: InboundFrames;
    readonly config: PiStandbyAgentConfig;
    readonly transcript: FollowedTranscript;
    readonly executionEnv: ExecutionEnv;
    readonly resume: PiAgentResume;
  },
  signal: AbortSignal,
): Promise<{
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
  await args.resume(
    {
      model: args.config.model,
      systemPrompt: args.config.systemPrompt,
      messages,
      executionEnv: args.executionEnv,
      async onMessage(message: PiAgentMessage) {
        await acknowledgeMessage(
          args.io,
          args.frames,
          args.config,
          tail,
          message,
        );
        failure ??= messageFailure(message);
      },
    },
    signal,
  );
  return {
    failure,
    lastAcknowledgedSequence: tail.lastAcknowledgedSequence,
  };
}

function appendTranscriptPage(
  transcript: FollowedTranscript,
  page: PiTranscriptPage,
): void {
  transcript.messages.push(...page.messages);
  transcript.lastOrdinal = page.lastOrdinal;
}

function latestMessageRequiresSandbox(
  transcript: FollowedTranscript,
  runId: string,
): boolean {
  const latest = transcript.messages.at(-1);
  if (latest === undefined || latest.runId !== runId) {
    return false;
  }
  const [message] = parsePiAgentMessages([latest.payload]);
  return message !== undefined && piMessageRequiresSandbox(message);
}

/** Run the internal one-shot Pi standby protocol used by guest-agent. */
export async function runPiStandbyAgentLoop(
  args: {
    readonly io: PiAgentLoopIo;
    readonly config: PiStandbyAgentConfig;
    readonly executionEnv: ExecutionEnv;
    readonly standbyTtlSeconds?: number;
    readonly pollIntervalMs?: number;
    readonly resume?: PiAgentResume;
  },
  signal: AbortSignal,
): Promise<void> {
  const promptDigest = systemPromptDigest(args.config.systemPrompt);
  await args.io.write({
    type: "pi-ready",
    runId: args.config.runId,
    systemPromptDigest: promptDigest,
    skillSnapshotDigest: args.config.skillSnapshot.digest,
  });
  const frames = new InboundFrames(args.io);
  const deadline =
    Date.now() +
    (args.standbyTtlSeconds ?? DEFAULT_PI_STANDBY_TTL_SECONDS) * 1_000;
  const pollIntervalMs =
    args.pollIntervalMs ?? DEFAULT_PI_TRANSCRIPT_POLL_INTERVAL_MS;
  const transcript: FollowedTranscript = { lastOrdinal: 0, messages: [] };
  let requestNumber = 0;
  while (!signal.aborted) {
    requestNumber += 1;
    const result = await requestTranscript(
      args.io,
      frames,
      requestNumber,
      transcript.lastOrdinal,
      deadline,
    );
    if (result.kind === "release") {
      await args.io.write({
        type: "pi-released",
        reason: result.reason ?? "api-complete",
      });
      return;
    }
    appendTranscriptPage(transcript, result.page);
    if (result.page.hasMore) {
      continue;
    }
    if (latestMessageRequiresSandbox(transcript, args.config.runId)) {
      const result = await resumeFromTranscript(
        {
          io: args.io,
          frames,
          config: args.config,
          transcript,
          executionEnv: args.executionEnv,
          resume: args.resume ?? runPiAgentResume,
        },
        signal,
      );
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
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw standbyTimeout();
    }
    const control = await frames.readWithin(
      Math.min(pollIntervalMs, remainingMs),
    );
    if (control === null) {
      if (Date.now() >= deadline) {
        throw standbyTimeout();
      }
      continue;
    }
    if (control.type === "pi-handoff") {
      continue;
    }
    if (control.type === "pi-standby-release") {
      await args.io.write({
        type: "pi-released",
        reason: control.reason ?? "api-complete",
      });
      return;
    }
    throw new Error("Pi standby expected a handoff or release control");
  }
  signal.throwIfAborted();
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

export function createPiNodeExecutionEnv(): ExecutionEnv {
  return createNodeExecutionEnv({
    cwd: process.cwd(),
    shellEnv: process.env,
  });
}
