import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveNativeHelperPath } from "./native-helper-path";
import type {
  DesktopRecorderErrorCode,
  DesktopRecorderNativeStatus,
  DesktopRecorderPrepareRequest,
  DesktopRecorderPrepareResult,
  DesktopRecorderRecording,
  DesktopRecorderCapabilities,
  DesktopRecorderSource,
  DesktopRecorderSourceKind,
  DesktopRecorderWindowPreview,
  RecorderNativeBackend,
} from "./desktop-recorder-types";

const HELPER_NAME = "screen-recorder-helper";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * `recorder.stop` waits on the helper draining the capture stream and then
 * finalizing the movie, which for a long recording takes well past the
 * ordinary request budget. Timing it out at the ordinary budget abandoned the
 * finalize while it was still running, and left the controller believing the
 * capture was still open.
 */
const DEFAULT_STOP_TIMEOUT_MS = 60_000;

class DesktopRecorderHelperError extends Error {
  constructor(
    readonly code: DesktopRecorderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopRecorderHelperError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(result: Record<string, unknown>, key: string): string {
  const value = result[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new DesktopRecorderHelperError(
    "capture_failed",
    `Screen recorder helper returned an invalid ${key}`,
  );
}

function requiredNumber(result: Record<string, unknown>, key: string): number {
  const value = result[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new DesktopRecorderHelperError(
    "capture_failed",
    `Screen recorder helper returned an invalid ${key}`,
  );
}

function requiredBoolean(
  result: Record<string, unknown>,
  key: string,
): boolean {
  const value = result[key];
  if (typeof value === "boolean") {
    return value;
  }
  throw new DesktopRecorderHelperError(
    "capture_failed",
    `Screen recorder helper returned an invalid ${key}`,
  );
}

function optionalString(
  result: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = result[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCode(value: unknown): DesktopRecorderErrorCode {
  if (
    value === "capture_failed" ||
    value === "helper_unavailable" ||
    value === "permission_denied" ||
    value === "source_lost"
  ) {
    return value;
  }
  return "capture_failed";
}

function sourceKind(value: unknown): DesktopRecorderSourceKind {
  if (value === "display" || value === "window") {
    return value;
  }
  throw new DesktopRecorderHelperError(
    "capture_failed",
    "Screen recorder helper returned an invalid source kind",
  );
}

/**
 * Reads one stdout line as a correlated response frame, or `null` when it is
 * not one.
 *
 * Anything the helper writes to stdout that is not a frame — a framework
 * diagnostic, a partial line left by an abnormal exit — is dropped rather than
 * thrown. This runs inside the `stdout` data handler, so throwing here would
 * take down the Electron main process instead of the one request involved, and
 * every request already has its own timeout to fall back on.
 */
function parseResponseLine(
  line: string,
): (Record<string, unknown> & { readonly id: string }) | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string") {
    return null;
  }
  return { ...parsed, id: parsed.id };
}

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Line-protocol client for the native screen recorder helper.
 *
 * Deliberately different from `ComputerUseNativeRuntimeClient` in one respect:
 * a timed-out request never kills the helper. The Computer Use client kills and
 * respawns on timeout because its commands are stateless captures; here the
 * process owns an in-flight `SCStream` and `AVAssetWriter`, so killing it would
 * destroy the recording the user is making. A slow command fails on its own.
 */
/** How much of the helper's stderr is kept for the message of an abrupt exit. */
const STDERR_TAIL_LIMIT = 2_000;

class RecorderHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private requestCounter = 0;
  private closed = false;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly helperPath: string,
    private readonly requestTimeoutMs: number,
  ) {}

  request(
    kind: string,
    payload: Record<string, unknown> = {},
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(
        new DesktopRecorderHelperError(
          "helper_unavailable",
          "Screen recorder helper is closed",
        ),
      );
    }
    const child = this.ensureChild();
    const id = `recorder_${(this.requestCounter += 1).toString()}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new DesktopRecorderHelperError(
              "capture_failed",
              `Screen recorder helper timed out running ${kind}`,
            ),
          );
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ id, kind, payload })}\n`,
        (writeError) => {
          if (writeError && this.pending.delete(id)) {
            clearTimeout(timer);
            reject(
              new DesktopRecorderHelperError(
                "helper_unavailable",
                `Unable to write to screen recorder helper: ${writeError.message}`,
              ),
            );
          }
        },
      );
    });
  }

  dispose(): void {
    this.closed = true;
    this.rejectAll(
      new DesktopRecorderHelperError(
        "helper_unavailable",
        "Screen recorder helper was closed",
      ),
    );
    this.child?.kill();
    this.child = null;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const child = spawn(this.helperPath, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stdoutBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.drainStdout();
    });
    // The helper's own diagnostics — and the crash report when it dies — come
    // out here. Left unread they went nowhere, so a helper that exited
    // mid-capture was indistinguishable from one that was closed on purpose.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      console.warn("[screen-recorder-helper]", chunk.trimEnd());
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.child = null;
      }
      this.rejectAll(
        new DesktopRecorderHelperError(
          "helper_unavailable",
          `Screen recorder helper failed to start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      const how =
        signal !== null
          ? `with signal ${signal}`
          : `with code ${String(code ?? "unknown")}`;
      const tail = this.stderrTail.trim();
      this.rejectAll(
        new DesktopRecorderHelperError(
          "helper_unavailable",
          `Screen recorder helper exited ${how}${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
    return child;
  }

  private drainStdout(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.settleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private settleLine(line: string): void {
    const parsed = parseResponseLine(line);
    if (!parsed) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    this.pending.delete(parsed.id);
    if (parsed.status === "succeeded") {
      pending.resolve(isRecord(parsed.result) ? parsed.result : {});
      return;
    }
    const failure = isRecord(parsed.error) ? parsed.error : {};
    pending.reject(
      new DesktopRecorderHelperError(
        errorCode(failure.code),
        typeof failure.message === "string"
          ? failure.message
          : "Screen recording failed",
      ),
    );
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function toSources(
  result: Record<string, unknown>,
): readonly DesktopRecorderSource[] {
  const value = result.sources;
  if (!Array.isArray(value)) {
    throw new DesktopRecorderHelperError(
      "capture_failed",
      "Screen recorder helper returned invalid sources",
    );
  }
  const sources = value.map((entry) => {
    if (!isRecord(entry)) {
      throw new DesktopRecorderHelperError(
        "capture_failed",
        "Screen recorder helper returned an invalid source entry",
      );
    }
    const appName = optionalString(entry, "appName");
    const bundleId = optionalString(entry, "bundleId");
    return {
      id: requiredString(entry, "id"),
      kind: sourceKind(entry.kind),
      title: requiredString(entry, "title"),
      ...(appName ? { appName } : {}),
      ...(bundleId ? { bundleId } : {}),
    };
  });
  return sources;
}

function toRecording(
  result: Record<string, unknown>,
): DesktopRecorderRecording {
  const failure = isRecord(result.failure) ? result.failure : null;
  return {
    videoPath: requiredString(result, "videoPath"),
    clickTrackPath: requiredString(result, "clickTrackPath"),
    durationMs: requiredNumber(result, "durationMs"),
    sizeBytes: requiredNumber(result, "sizeBytes"),
    width: requiredNumber(result, "width"),
    height: requiredNumber(result, "height"),
    ...(failure
      ? {
          failure: {
            code: errorCode(failure.code),
            message:
              typeof failure.message === "string"
                ? failure.message
                : "Screen recording failed",
          },
        }
      : {}),
  };
}

function toNativeStatus(
  result: Record<string, unknown>,
): DesktopRecorderNativeStatus {
  const status = result.status;
  if (
    status !== "failed" &&
    status !== "paused" &&
    status !== "ready" &&
    status !== "recording" &&
    status !== "stopped"
  ) {
    throw new DesktopRecorderHelperError(
      "capture_failed",
      "Screen recorder helper returned an invalid status",
    );
  }
  const failure = isRecord(result.error) ? result.error : null;
  return {
    status,
    elapsedMs: requiredNumber(result, "elapsedMs"),
    ...(failure
      ? {
          error: {
            code: errorCode(failure.code),
            message:
              typeof failure.message === "string"
                ? failure.message
                : "Screen recording failed",
          },
        }
      : {}),
  };
}

export function createRecorderNativeBackend(
  options: {
    readonly helperPath?: string;
    readonly requestTimeoutMs?: number;
    readonly stopTimeoutMs?: number;
  } = {},
): RecorderNativeBackend {
  const client = new RecorderHelperClient(
    options.helperPath ?? resolveNativeHelperPath(HELPER_NAME),
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  return {
    dispose: () => {
      client.dispose();
    },
    getCapabilities: async (): Promise<DesktopRecorderCapabilities> => {
      const result = await client.request("recorder.capabilities");
      return {
        supportsMicrophone: requiredBoolean(result, "supportsMicrophone"),
      };
    },
    listSources: async () =>
      toSources(await client.request("recorder.sources")),
    prepare: async (
      request: DesktopRecorderPrepareRequest,
    ): Promise<DesktopRecorderPrepareResult> => {
      const result = await client.request("recorder.prepare", {
        sourceId: request.sourceId,
        sourceKind: request.sourceKind,
        systemAudio: request.systemAudio,
        microphone: request.microphone,
        ...(request.area ? { area: request.area } : {}),
      });
      const geometry = isRecord(result.geometry) ? result.geometry : {};
      return {
        sessionId: requiredString(result, "sessionId"),
        width: requiredNumber(result, "width"),
        height: requiredNumber(result, "height"),
        geometry: {
          originX: requiredNumber(geometry, "originX"),
          originY: requiredNumber(geometry, "originY"),
          widthPoints: requiredNumber(geometry, "widthPoints"),
          heightPoints: requiredNumber(geometry, "heightPoints"),
          scale: requiredNumber(geometry, "scale"),
        },
      };
    },
    requestScreenRecordingPermission: async () => {
      const result = await client.request("recorder.requestPermission");
      return requiredBoolean(result, "granted");
    },
    listWindowPreviews: async () => {
      const result = await client.request("recorder.windowPreviews");
      const value = result.previews;
      if (!Array.isArray(value)) {
        throw new DesktopRecorderHelperError(
          "capture_failed",
          "Screen recorder helper returned invalid window previews",
        );
      }
      return value.map((entry): DesktopRecorderWindowPreview => {
        if (!isRecord(entry)) {
          throw new DesktopRecorderHelperError(
            "capture_failed",
            "Screen recorder helper returned an invalid window preview",
          );
        }
        return {
          id: requiredString(entry, "id"),
          previewDataUrl: requiredString(entry, "previewDataUrl"),
        };
      });
    },
    start: async (sessionId: string, outputPath: string) => {
      await client.request("recorder.start", { sessionId, outputPath });
    },
    pause: async (sessionId: string) => {
      await client.request("recorder.pause", { sessionId });
    },
    resume: async (sessionId: string) => {
      await client.request("recorder.resume", { sessionId });
    },
    discard: async (sessionId: string) => {
      await client.request("recorder.discard", { sessionId });
    },
    stop: async (sessionId: string) =>
      toRecording(
        await client.request("recorder.stop", { sessionId }, stopTimeoutMs),
      ),
    getStatus: async (sessionId: string) =>
      toNativeStatus(await client.request("recorder.state", { sessionId })),
  };
}
