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
import { createPiNodeExecutionEnv as createNodeExecutionEnv } from "@vm0/pi-agent-runtime/node";
import {
  parsePiAgentMessages,
  runPiAgentResume,
  type ExecutionEnv,
  type PiAgentMessage,
  type PiAgentModelConfig,
} from "@vm0/pi-agent-runtime";
import { z } from "zod";

const RUN_ID_ENV = "VM0_RUN_ID";
const PI_SYSTEM_PROMPT_ENV = "VM0_PI_SYSTEM_PROMPT";
const PI_MODEL_CONFIG_ENV = "VM0_PI_MODEL_CONFIG";
const RUN_SKILL_SNAPSHOT_ENV = "VM0_RUN_SKILL_SNAPSHOT";

export const DEFAULT_PI_STANDBY_TTL_SECONDS = 300;
const DEFAULT_PI_STANDBY_POLL_INTERVAL_MS = 10_000;

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

async function readFrame(
  io: PiAgentLoopIo,
  signal: AbortSignal,
): Promise<InboundFrame> {
  const frame = await io.read();
  signal.throwIfAborted();
  if (frame === null) {
    throw new Error("Pi agent loop control input closed");
  }
  return inboundFrameSchema.parse(frame);
}

class PiInboundReader {
  readonly #io: PiAgentLoopIo;
  #pending: Promise<InboundFrame> | undefined;

  constructor(io: PiAgentLoopIo) {
    this.#io = io;
  }

  async read(signal: AbortSignal): Promise<InboundFrame> {
    this.#pending ??= readFrame(this.#io, signal);
    try {
      const frame = await this.#pending;
      signal.throwIfAborted();
      return frame;
    } finally {
      this.#pending = undefined;
    }
  }

  async readUntil(
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<InboundFrame | null> {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    this.#pending ??= readFrame(this.#io, signal);
    type Outcome =
      | { readonly kind: "frame"; readonly frame: InboundFrame }
      | { readonly kind: "timeout" };
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<Outcome>((resolve) => {
      timeout = setTimeout(() => {
        resolve({ kind: "timeout" });
      }, remainingMs);
    });
    try {
      const outcome = await Promise.race([
        this.#pending.then((frame): Outcome => {
          return { kind: "frame", frame };
        }),
        timedOut,
      ]);
      signal.throwIfAborted();
      if (outcome.kind === "timeout") {
        return null;
      }
      this.#pending = undefined;
      return outcome.frame;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

async function requestTranscript(
  io: PiAgentLoopIo,
  reader: PiInboundReader,
  requestNumber: number,
  current: PiTranscript | undefined,
  signal: AbortSignal,
  deadlineMs?: number,
): Promise<PiTranscript | null> {
  const requestId = `transcript-${requestNumber}`;
  await io.write({
    type: "pi-transcript-read",
    requestId,
    ...(current === undefined
      ? {}
      : { version: current.version, afterOrdinal: current.lastOrdinal }),
  });
  signal.throwIfAborted();
  while (true) {
    const frame =
      deadlineMs === undefined
        ? await reader.read(signal)
        : await reader.readUntil(deadlineMs, signal);
    signal.throwIfAborted();
    if (frame === null) {
      return null;
    }
    if (frame.type === "pi-standby-release") {
      throw new PiStandbyReleased(frame.reason);
    }
    if (frame.type === "pi-handoff") {
      continue;
    }
    if (frame.type !== "pi-transcript" || frame.requestId !== requestId) {
      throw new Error(`Expected Pi transcript response for ${requestId}`);
    }
    return frame.transcript;
  }
}

function mergeTranscript(
  current: PiTranscript | undefined,
  incoming: PiTranscript,
): PiTranscript {
  if (current === undefined) {
    return incoming;
  }
  if (current.version !== incoming.version) {
    throw new Error("Pi transcript version changed during standby");
  }
  if (incoming.lastOrdinal < current.lastOrdinal) {
    throw new Error("Pi transcript tail moved backwards during standby");
  }
  const messagesByOrdinal = new Map(
    current.messages.map((message) => {
      return [message.ordinal, message] as const;
    }),
  );
  for (const message of incoming.messages) {
    messagesByOrdinal.set(message.ordinal, message);
  }
  return {
    version: incoming.version,
    lastOrdinal: incoming.lastOrdinal,
    messages: [...messagesByOrdinal.values()]
      .filter((message) => {
        return message.ordinal <= incoming.lastOrdinal;
      })
      .sort((left, right) => {
        return left.ordinal - right.ordinal;
      }),
    handoff: incoming.handoff,
  };
}

function hasDurableHandoff(transcript: PiTranscript, runId: string): boolean {
  const handoff = transcript.handoff;
  if (handoff === null) {
    return false;
  }
  if (
    handoff.runId !== runId ||
    handoff.transcriptVersion !== transcript.version ||
    handoff.afterOrdinal !== transcript.lastOrdinal
  ) {
    throw new Error("Pi handoff marker does not match the transcript tail");
  }
  const boundary = transcript.messages.find((message) => {
    return message.ordinal === handoff.afterOrdinal;
  });
  if (
    boundary?.runId !== runId ||
    boundary.messageId !== handoff.messageId ||
    boundary.role !== "assistant"
  ) {
    throw new Error(
      "Pi handoff marker does not identify its assistant message",
    );
  }
  return true;
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
  reader: PiInboundReader,
  config: PiStandbyAgentConfig,
  tail: TranscriptTail,
  message: PiAgentMessage,
  signal: AbortSignal,
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
  signal.throwIfAborted();
  const frame = await reader.read(signal);
  signal.throwIfAborted();
  if (frame.type === "pi-standby-release") {
    throw new PiStandbyReleased(frame.reason);
  }
  if (frame.type !== "pi-message-ack" || frame.messageId !== messageId) {
    throw new Error(`Expected acknowledgement for Pi message ${messageId}`);
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

async function resumeFromTranscript(
  args: {
    readonly io: PiAgentLoopIo;
    readonly reader: PiInboundReader;
    readonly config: PiStandbyAgentConfig;
    readonly transcript: PiTranscript;
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
          args.reader,
          args.config,
          tail,
          message,
          signal,
        );
        signal.throwIfAborted();
        failure ??= messageFailure(message);
      },
    },
    signal,
  );
  signal.throwIfAborted();
  return {
    failure,
    lastAcknowledgedSequence: tail.lastAcknowledgedSequence,
  };
}

interface DurableHandoffReady {
  readonly transcript: PiTranscript;
}

async function waitForDurableHandoff(
  args: {
    readonly io: PiAgentLoopIo;
    readonly reader: PiInboundReader;
    readonly runId: string;
    readonly expiresAt: number;
    readonly pollIntervalMs: number;
  },
  signal: AbortSignal,
): Promise<DurableHandoffReady | null> {
  let requestNumber = 0;
  let transcript: PiTranscript | undefined;
  while (true) {
    signal.throwIfAborted();
    requestNumber += 1;
    const read = await requestTranscript(
      args.io,
      args.reader,
      requestNumber,
      transcript,
      signal,
      args.expiresAt,
    );
    signal.throwIfAborted();
    if (read === null) {
      return null;
    }
    transcript = mergeTranscript(transcript, read);
    if (hasDurableHandoff(transcript, args.runId)) {
      return { transcript };
    }

    const nextPollAt = Math.min(
      Date.now() + args.pollIntervalMs,
      args.expiresAt,
    );
    const frame = await args.reader.readUntil(nextPollAt, signal);
    signal.throwIfAborted();
    if (frame === null) {
      if (Date.now() >= args.expiresAt) {
        return null;
      }
      continue;
    }
    if (frame.type === "pi-standby-release") {
      throw new PiStandbyReleased(frame.reason);
    }
    if (frame.type !== "pi-handoff") {
      throw new Error("Pi standby received an unexpected idle frame");
    }
  }
}

/** Run the internal one-shot Pi standby protocol used by guest-agent. */
export async function runPiStandbyAgentLoop(
  args: {
    readonly io: PiAgentLoopIo;
    readonly config: PiStandbyAgentConfig;
    readonly executionEnv: ExecutionEnv;
    readonly standbyTtlSeconds?: number;
    readonly standbyPollIntervalMs?: number;
    readonly resume?: PiAgentResume;
  },
  signal: AbortSignal,
): Promise<void> {
  const promptDigest = systemPromptDigest(args.config.systemPrompt);
  const reader = new PiInboundReader(args.io);
  const pollIntervalMs =
    args.standbyPollIntervalMs ?? DEFAULT_PI_STANDBY_POLL_INTERVAL_MS;
  await args.io.write({
    type: "pi-ready",
    runId: args.config.runId,
    systemPromptDigest: promptDigest,
    skillSnapshotDigest: args.config.skillSnapshot.digest,
  });
  signal.throwIfAborted();
  const expiresAt =
    Date.now() +
    (args.standbyTtlSeconds ?? DEFAULT_PI_STANDBY_TTL_SECONDS) * 1000;
  try {
    const handoff = await waitForDurableHandoff(
      {
        io: args.io,
        reader,
        runId: args.config.runId,
        expiresAt,
        pollIntervalMs,
      },
      signal,
    );
    signal.throwIfAborted();
    if (handoff === null) {
      await args.io.write({ type: "pi-released", reason: "ttl" });
      signal.throwIfAborted();
      return;
    }
    const result = await resumeFromTranscript(
      {
        io: args.io,
        reader,
        config: args.config,
        transcript: handoff.transcript,
        executionEnv: args.executionEnv,
        resume: args.resume ?? runPiAgentResume,
      },
      signal,
    );
    signal.throwIfAborted();
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
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof PiStandbyReleased) {
      await args.io.write({ type: "pi-released", reason: "api-complete" });
      signal.throwIfAborted();
      return;
    }
    throw error;
  }
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
