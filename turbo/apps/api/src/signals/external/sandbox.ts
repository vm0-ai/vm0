import { Writable } from "node:stream";

import { timeout } from "signal-timers";

import { testOverride } from "../../lib/singleton";

export const DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_SANDBOX_FILE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_SANDBOX_CLEANUP_TIMEOUT_MS = 15 * 1000;

export interface SandboxHandle {
  readonly sandboxId: string;
}

export interface SandboxCommandHandle {
  readonly sandboxId: string;
  readonly commandId: string;
}

export interface SandboxResources {
  readonly vcpus: number;
}

interface SandboxNetworkTransformer {
  readonly headers?: Readonly<Record<string, string>>;
}

interface SandboxNetworkPolicyRule {
  readonly transform?: readonly SandboxNetworkTransformer[];
}

export type SandboxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      readonly allow?:
        | readonly string[]
        | Readonly<Record<string, readonly SandboxNetworkPolicyRule[]>>;
      readonly subnets?: {
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
      };
    };

export interface CreateSandboxOptions {
  readonly runtime?: string;
  readonly timeoutMs?: number;
  readonly resources?: SandboxResources;
  readonly ports?: readonly number[];
  readonly env?: Readonly<Record<string, string>>;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly signal?: AbortSignal;
}

export interface SandboxOperationOptions {
  readonly signal?: AbortSignal;
}

export interface RunSandboxCommandOptions {
  readonly cmd: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly detached?: boolean;
  readonly outputLimitBytes?: number;
  readonly signal?: AbortSignal;
}

export interface ReadSandboxFileOptions {
  readonly path: string;
  readonly cwd?: string;
  readonly limitBytes?: number;
  readonly signal?: AbortSignal;
}

export interface UpdateSandboxNetworkPolicyOptions {
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly signal?: AbortSignal;
}

export interface ExtendSandboxTimeoutOptions {
  readonly durationMs: number;
  readonly signal?: AbortSignal;
}

export interface StopSandboxOptions {
  readonly blocking?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface BoundedTextOutput {
  readonly text: string;
  readonly bytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
}

export interface SandboxCommandResult {
  readonly sandboxId: string;
  readonly commandId: string;
  readonly detached: boolean;
  readonly exitCode: number | null;
  readonly stdout: BoundedTextOutput;
  readonly stderr: BoundedTextOutput;
}

export type SandboxFileReadResult =
  | {
      readonly status: "missing";
    }
  | {
      readonly status: "ok";
      readonly data: Buffer;
      readonly bytes: number;
      readonly limitBytes: number;
      readonly truncated: false;
    }
  | {
      readonly status: "too_large";
      readonly data: Buffer;
      readonly bytes: number;
      readonly limitBytes: number;
      readonly truncated: true;
    };

export type SandboxErrorPhase =
  | "create"
  | "get"
  | "run"
  | "read"
  | "network"
  | "extend-timeout"
  | "stop";

export interface SandboxError {
  readonly phase: SandboxErrorPhase;
  readonly name: string;
  readonly message: string;
}

type SandboxOperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SandboxError };

export type SandboxCleanupResult =
  | {
      readonly status: "stopped";
    }
  | {
      readonly status: "failed";
      readonly error: SandboxError;
    };

export interface SandboxClient {
  readonly create: (options?: CreateSandboxOptions) => Promise<SandboxHandle>;
  readonly get: (
    sandboxId: string,
    options?: SandboxOperationOptions,
  ) => Promise<SandboxHandle>;
  readonly runCommand: (
    handle: SandboxHandle,
    options: RunSandboxCommandOptions,
  ) => Promise<SandboxCommandResult>;
  readonly getCommand?: (
    handle: SandboxHandle,
    commandId: string,
    options?: SandboxOperationOptions,
  ) => Promise<SandboxCommandHandle>;
  readonly waitCommand?: (
    command: SandboxCommandHandle,
    options?: SandboxOperationOptions,
  ) => Promise<SandboxCommandResult>;
  readonly readFile: (
    handle: SandboxHandle,
    options: ReadSandboxFileOptions,
  ) => Promise<SandboxFileReadResult>;
  readonly updateNetworkPolicy: (
    handle: SandboxHandle,
    options: UpdateSandboxNetworkPolicyOptions,
  ) => Promise<void>;
  readonly extendTimeout: (
    handle: SandboxHandle,
    options: ExtendSandboxTimeoutOptions,
  ) => Promise<void>;
  readonly stop: (
    handle: SandboxHandle,
    options?: StopSandboxOptions,
  ) => Promise<SandboxCleanupResult>;
}

const {
  get: getMockedSandboxClient,
  set: setMockedSandboxClient,
  clear: clearMockedSandboxClient,
} = testOverride<SandboxClient | undefined>(() => {
  return undefined;
});

const {
  get: getMockedSandboxCleanupTimeoutMs,
  set: setMockedSandboxCleanupTimeoutMs,
  clear: clearMockedSandboxCleanupTimeoutMs,
} = testOverride<number | undefined>(() => {
  return undefined;
});

export function getMockSandboxClient(): SandboxClient | undefined {
  return getMockedSandboxClient();
}

export function mockSandboxClient(client: SandboxClient): void {
  setMockedSandboxClient(client);
}

export function clearMockSandboxClient(): void {
  clearMockedSandboxClient();
}

export function getSandboxCleanupTimeoutMs(): number | undefined {
  return getMockedSandboxCleanupTimeoutMs();
}

export function mockSandboxCleanupTimeoutMs(timeoutMs: number): void {
  setMockedSandboxCleanupTimeoutMs(timeoutMs);
}

export function clearMockSandboxCleanupTimeoutMs(): void {
  clearMockedSandboxCleanupTimeoutMs();
}

export function normalizeSandboxLimitBytes(
  limitBytes: number | undefined,
  defaultLimitBytes: number,
): number {
  if (limitBytes === undefined) {
    return defaultLimitBytes;
  }
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
    throw new RangeError("Sandbox byte limit must be a non-negative integer");
  }
  return limitBytes;
}

export function emptyBoundedTextOutput(limitBytes: number): BoundedTextOutput {
  return {
    text: "",
    bytes: 0,
    limitBytes,
    truncated: false,
  };
}

class BoundedTextWritable extends Writable {
  readonly #chunks: Buffer[] = [];
  readonly #limitBytes: number;
  #bytes = 0;
  #storedBytes = 0;
  #truncated = false;

  constructor(limitBytes: number) {
    super();
    this.#limitBytes = limitBytes;
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), encoding);
    this.#bytes += buffer.length;

    const remainingBytes = this.#limitBytes - this.#storedBytes;
    if (remainingBytes > 0) {
      const stored = buffer.subarray(0, remainingBytes);
      this.#chunks.push(stored);
      this.#storedBytes += stored.length;
    }
    if (buffer.length > remainingBytes) {
      this.#truncated = true;
    }

    callback();
  }

  output(): BoundedTextOutput {
    return {
      text: Buffer.concat(this.#chunks, this.#storedBytes).toString("utf8"),
      bytes: this.#bytes,
      limitBytes: this.#limitBytes,
      truncated: this.#truncated,
    };
  }
}

interface BoundedTextCollector {
  readonly writable: Writable;
  readonly output: () => BoundedTextOutput;
}

export function createBoundedTextCollector(
  limitBytes: number,
): BoundedTextCollector {
  const writable = new BoundedTextWritable(limitBytes);
  return {
    writable,
    output() {
      return writable.output();
    },
  };
}

function bufferFromStreamChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk));
}

function stopReadableStream(stream: NodeJS.ReadableStream): void {
  const destroy = (
    stream as NodeJS.ReadableStream & {
      destroy?: (error?: Error) => void;
    }
  ).destroy;
  if (destroy) {
    destroy.call(stream);
    return;
  }
  stream.pause();
}

export function readStreamToBoundedBuffer(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
  signal?: AbortSignal,
): Promise<Exclude<SandboxFileReadResult, { readonly status: "missing" }>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let storedBytes = 0;
    let settled = false;
    let truncated = false;

    function cleanup() {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }

    function result():
      | Extract<SandboxFileReadResult, { readonly status: "ok" }>
      | Extract<SandboxFileReadResult, { readonly status: "too_large" }> {
      const data = Buffer.concat(chunks, storedBytes);
      if (truncated) {
        return {
          status: "too_large",
          data,
          bytes,
          limitBytes,
          truncated: true,
        };
      }
      return {
        status: "ok",
        data,
        bytes,
        limitBytes,
        truncated: false,
      };
    }

    function finish(
      value:
        | Exclude<SandboxFileReadResult, { readonly status: "missing" }>
        | undefined,
      error?: unknown,
    ) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve(value ?? result());
    }

    function onData(chunk: unknown) {
      const buffer = bufferFromStreamChunk(chunk);
      bytes += buffer.length;

      const remainingBytes = limitBytes - storedBytes;
      if (remainingBytes > 0) {
        const stored = buffer.subarray(0, remainingBytes);
        chunks.push(stored);
        storedBytes += stored.length;
      }
      if (buffer.length > remainingBytes) {
        truncated = true;
        stopReadableStream(stream);
        finish(result());
      }
    }

    function onEnd() {
      finish(result());
    }

    function onError(error: unknown) {
      finish(undefined, error);
    }

    function onAbort() {
      const reason = signal?.reason ?? new Error("Sandbox file read aborted");
      stopReadableStream(stream);
      finish(undefined, reason);
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function redactSandboxMessage(message: string): string {
  return message
    .replace(
      /(["']?\b[\w.-]*(?:token|secret|password|authorization|api[_-]?key|key)[\w.-]*\b["']?\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi,
      "$1$2[redacted]$2",
    )
    .replace(
      /(["']?\b[\w.-]*(?:token|secret|password|authorization|api[_-]?key|key)[\w.-]*\b["']?\s*[:=]\s*)Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?\b[\w.-]*(?:token|secret|password|authorization|api[_-]?key|key)[\w.-]*\b["']?\s*[:=]\s*)[^"',}&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

export function sandboxError(
  phase: SandboxErrorPhase,
  error: unknown,
): SandboxError {
  if (error instanceof Error) {
    return {
      phase,
      name: error.name,
      message: redactSandboxMessage(error.message),
    };
  }
  return {
    phase,
    name: "Error",
    message: redactSandboxMessage(String(error)),
  };
}

export function sandboxErrorToException(error: SandboxError): Error {
  const exception = new Error(error.message);
  exception.name = error.name;
  return exception;
}

export function sandboxOperation<T>(
  phase: SandboxErrorPhase,
  fn: () => Promise<T>,
): Promise<SandboxOperationResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        return { ok: true, value } as const;
      },
      (error: unknown) => {
        return { ok: false, error: sandboxError(phase, error) } as const;
      },
    );
}

function cleanupTimeoutError(): Error {
  const error = new Error("Sandbox cleanup timed out");
  error.name = "AbortError";
  return error;
}

export async function sandboxCleanupOperation(args: {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly operation: (signal: AbortSignal) => Promise<void>;
}): Promise<SandboxCleanupResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_SANDBOX_CLEANUP_TIMEOUT_MS;
  const cleanupController = new AbortController();
  const timeoutController = new AbortController();

  if (args.signal?.aborted) {
    return {
      status: "failed",
      error: sandboxError(
        "stop",
        args.signal.reason ?? new Error("Sandbox cleanup aborted"),
      ),
    };
  }

  const timeoutResultPromise = new Promise<SandboxOperationResult<void>>(
    (resolve) => {
      let settled = false;
      function finish(error: unknown, abortOperation: boolean) {
        if (settled) {
          return;
        }
        settled = true;
        args.signal?.removeEventListener("abort", onAbort);
        timeoutController.signal.removeEventListener(
          "abort",
          onTimeoutCanceled,
        );
        if (abortOperation) {
          cleanupController.abort(error);
        }
        resolve({ ok: false, error: sandboxError("stop", error) });
      }
      function onAbort() {
        finish(
          args.signal?.reason ?? new Error("Sandbox cleanup aborted"),
          true,
        );
      }
      function onTimeoutCanceled() {
        finish(new Error("Sandbox cleanup timeout canceled"), false);
      }

      if (args.signal?.aborted) {
        onAbort();
        return;
      }

      args.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutController.signal.addEventListener("abort", onTimeoutCanceled, {
        once: true,
      });
      timeout(
        () => {
          finish(cleanupTimeoutError(), true);
        },
        timeoutMs,
        { signal: timeoutController.signal },
      );
    },
  );

  const operationResultPromise = sandboxOperation("stop", () => {
    return args.operation(cleanupController.signal);
  });

  const result = await Promise.race([
    operationResultPromise,
    timeoutResultPromise,
  ]).finally(() => {
    timeoutController.abort();
  });

  if (result.ok) {
    return { status: "stopped" };
  }

  return {
    status: "failed",
    error: result.error,
  };
}
