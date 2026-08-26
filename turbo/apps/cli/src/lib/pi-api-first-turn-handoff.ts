import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  piApiFirstTurnManifestSchema,
  type PiApiFirstTurnConfig,
  type PiApiFirstTurnManifest,
} from "@okouai/api-contracts/contracts/runners";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";

const MANIFEST_MAX_BYTES = 16 * 1024;
const INITIAL_POLL_DELAY_MS = 100;
const MAX_POLL_DELAY_MS = 500;

type PiApiFirstTurnHandoffErrorCode =
  | "PI_HANDOFF_BASE_SESSION_MISMATCH"
  | "PI_HANDOFF_H1_DOWNLOAD_FAILED"
  | "PI_HANDOFF_H1_HASH_MISMATCH"
  | "PI_HANDOFF_H1_INVALID"
  | "PI_HANDOFF_H1_LATE"
  | "PI_HANDOFF_H1_TOO_LARGE"
  | "PI_HANDOFF_H1_WRITE_FAILED"
  | "PI_HANDOFF_MANIFEST_INVALID"
  | "PI_HANDOFF_MANIFEST_TIMEOUT"
  | "PI_HANDOFF_SEQUENCE_MISMATCH"
  | "PI_HANDOFF_SESSION_MISMATCH";

class PiApiFirstTurnHandoffError extends Error {
  readonly code: PiApiFirstTurnHandoffErrorCode;

  constructor(
    code: PiApiFirstTurnHandoffErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options);
    this.name = "PiApiFirstTurnHandoffError";
    this.code = code;
  }
}

interface PiApiFirstTurnHandoff {
  readonly sessionFile: string;
  readonly sandboxEventSequenceStart: number;
}

export interface HandoffRuntime {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

const defaultRuntime: HandoffRuntime = {
  fetch,
  now: Date.now,
  sleep(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

async function responseBufferWithMaxBytes(args: {
  readonly response: Response;
  readonly maxBytes: number;
  readonly code: "PI_HANDOFF_H1_TOO_LARGE" | "PI_HANDOFF_MANIFEST_INVALID";
  readonly readErrorCode:
    | "PI_HANDOFF_H1_DOWNLOAD_FAILED"
    | "PI_HANDOFF_MANIFEST_INVALID";
  readonly label: string;
}): Promise<Buffer> {
  const declaredLengthHeader = args.response.headers.get("content-length");
  const declaredLength =
    declaredLengthHeader === null ? undefined : Number(declaredLengthHeader);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > args.maxBytes
  ) {
    startBodyCancellation(args.response.body);
    throw new PiApiFirstTurnHandoffError(
      args.code,
      `${args.label} exceeds its size limit`,
    );
  }
  if (!args.response.body) {
    return Buffer.alloc(0);
  }
  const reader = args.response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, size);
      }
      size += value.byteLength;
      if (size > args.maxBytes) {
        startReaderCancellation(reader);
        throw new PiApiFirstTurnHandoffError(
          args.code,
          `${args.label} exceeds its size limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof PiApiFirstTurnHandoffError) {
      throw error;
    }
    throw new PiApiFirstTurnHandoffError(
      args.readErrorCode,
      `${args.label} body could not be read`,
      { cause: error },
    );
  }
}

function startBodyCancellation(body: ReadableStream<Uint8Array> | null): void {
  if (body) {
    void body.cancel().then(
      () => {},
      () => {},
    );
  }
}

function startReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  void reader.cancel().then(
    () => {},
    () => {},
  );
}

function manifestTimeout(cause?: unknown): PiApiFirstTurnHandoffError {
  return new PiApiFirstTurnHandoffError(
    "PI_HANDOFF_MANIFEST_TIMEOUT",
    "Pi API first-turn manifest did not arrive before the deadline",
    cause === undefined ? undefined : { cause },
  );
}

async function pollManifest(
  config: PiApiFirstTurnConfig,
  runtime: HandoffRuntime,
): Promise<PiApiFirstTurnManifest> {
  let delayMs = INITIAL_POLL_DELAY_MS;
  while (runtime.now() < config.deadlineAt) {
    const remainingMs = config.deadlineAt - runtime.now();
    let response: Response;
    try {
      response = await runtime.fetch(config.manifestUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      });
    } catch (error) {
      if (runtime.now() >= config.deadlineAt) {
        throw manifestTimeout(error);
      }
      await runtime.sleep(Math.min(delayMs, config.deadlineAt - runtime.now()));
      delayMs = Math.min(MAX_POLL_DELAY_MS, delayMs * 2);
      continue;
    }
    if (runtime.now() >= config.deadlineAt) {
      throw manifestTimeout();
    }
    if (response.ok) {
      const bytes = await responseBufferWithMaxBytes({
        response,
        maxBytes: MANIFEST_MAX_BYTES,
        code: "PI_HANDOFF_MANIFEST_INVALID",
        readErrorCode: "PI_HANDOFF_MANIFEST_INVALID",
        label: "Pi API first-turn manifest",
      });
      if (runtime.now() >= config.deadlineAt) {
        throw manifestTimeout();
      }
      try {
        return piApiFirstTurnManifestSchema.parse(
          JSON.parse(bytes.toString("utf8")) as unknown,
        );
      } catch (error) {
        throw new PiApiFirstTurnHandoffError(
          "PI_HANDOFF_MANIFEST_INVALID",
          "Pi API first-turn manifest is malformed or incompatible",
          { cause: error },
        );
      }
    }
    if (response.status !== 404 && response.status < 500) {
      throw new PiApiFirstTurnHandoffError(
        "PI_HANDOFF_MANIFEST_INVALID",
        `Pi API first-turn manifest returned ${response.status}`,
      );
    }
    const retryRemainingMs = config.deadlineAt - runtime.now();
    if (retryRemainingMs <= 0) {
      break;
    }
    await runtime.sleep(Math.min(delayMs, retryRemainingMs));
    delayMs = Math.min(MAX_POLL_DELAY_MS, delayMs * 2);
  }
  throw manifestTimeout();
}

function validateManifestIdentity(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
  readonly sessionId: string;
}): void {
  if (
    args.config.baseSession.sessionId !== args.sessionId ||
    args.manifest.session.sessionId !== args.sessionId
  ) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_SESSION_MISMATCH",
      "Pi API first-turn session id does not match the launch",
    );
  }
  if (
    args.manifest.baseSession.sessionId !== args.config.baseSession.sessionId ||
    args.manifest.baseSession.sha256 !== args.config.baseSession.sha256
  ) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_BASE_SESSION_MISMATCH",
      "Pi API first-turn manifest does not extend the configured H0",
    );
  }
}

function validatedSandboxEventSequenceStart(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
}): number {
  // API-written manifests and commit-addressed CLIs overlap across queued runs
  // and the two-hour runner drain. Remove v1 after #29618 is live on every Pi
  // runner, pre-v2 work has drained, and no retained rollback API emits v1;
  // tracked by #29612.
  if (args.manifest.schemaVersion === 2) {
    return args.manifest.sandboxEventSequenceStart;
  }
  if (args.config.sandboxEventSequenceStart !== 1) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_SEQUENCE_MISMATCH",
      "Pi API first-turn manifest boundary does not match the launch",
    );
  }
  return 1;
}

async function restoreSession(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly manifest: PiApiFirstTurnManifest;
  readonly runtime: HandoffRuntime;
  readonly sessionDir: string;
  readonly sessionId: string;
}): Promise<string> {
  validateManifestIdentity(args);
  let response: Response;
  try {
    response = await args.runtime.fetch(args.config.sessionUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(
        Math.max(1, args.config.deadlineAt - args.runtime.now()),
      ),
    });
  } catch (error) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_DOWNLOAD_FAILED",
      "Pi API first-turn H1 download failed",
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_DOWNLOAD_FAILED",
      `Pi API first-turn H1 returned ${response.status}`,
    );
  }
  const bytes = await responseBufferWithMaxBytes({
    response,
    maxBytes: PI_API_FIRST_TURN_SESSION_MAX_BYTES,
    code: "PI_HANDOFF_H1_TOO_LARGE",
    readErrorCode: "PI_HANDOFF_H1_DOWNLOAD_FAILED",
    label: "Pi API first-turn H1",
  });
  if (args.runtime.now() >= args.config.deadlineAt) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_LATE",
      "Pi API first-turn H1 arrived after the deadline",
    );
  }
  if (bytes.length !== args.manifest.session.rawSize) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_HASH_MISMATCH",
      "Pi API first-turn H1 size does not match the manifest",
    );
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== args.manifest.session.sha256) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_HASH_MISMATCH",
      "Pi API first-turn H1 hash does not match the manifest",
    );
  }

  let session: MemoryPiSession;
  try {
    const jsonl = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    session = MemoryPiSession.fromJsonl(jsonl);
  } catch (error) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_INVALID",
      "Pi API first-turn H1 is not a supported native Pi session",
      { cause: error },
    );
  }
  if (session.getSessionId() !== args.sessionId) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_SESSION_MISMATCH",
      "Pi API first-turn H1 session id does not match the launch",
    );
  }
  if (!session.hasPendingToolCalls()) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_INVALID",
      "Pi API first-turn H1 contains no pending Sandbox tool calls",
    );
  }

  const sessionFile = join(
    args.sessionDir,
    `api-first-turn-${args.sessionId}.jsonl`,
  );
  const temporaryFile = `${sessionFile}.${randomUUID()}.tmp`;
  try {
    await mkdir(args.sessionDir, { recursive: true });
    await writeFile(temporaryFile, bytes, { mode: 0o600 });
    await rename(temporaryFile, sessionFile);
  } catch (error) {
    throw new PiApiFirstTurnHandoffError(
      "PI_HANDOFF_H1_WRITE_FAILED",
      "Pi API first-turn H1 could not be installed atomically",
      { cause: error },
    );
  }
  return sessionFile;
}

/** Poll one shared deadline and restore the validated H1 checkpoint. */
export async function resolvePiApiFirstTurnHandoff(args: {
  readonly config: PiApiFirstTurnConfig;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly runtime?: HandoffRuntime;
}): Promise<PiApiFirstTurnHandoff> {
  const runtime = args.runtime ?? defaultRuntime;
  const manifest = await pollManifest(args.config, runtime);
  const sandboxEventSequenceStart = validatedSandboxEventSequenceStart({
    config: args.config,
    manifest,
  });
  return {
    sessionFile: await restoreSession({
      config: args.config,
      manifest,
      runtime,
      sessionDir: args.sessionDir,
      sessionId: args.sessionId,
    }),
    sandboxEventSequenceStart,
  };
}
