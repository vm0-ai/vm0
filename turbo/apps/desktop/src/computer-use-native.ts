import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AccessibilityAppStateSnapshot,
  ComputerUseCommandFailure,
  ComputerUseCoordinateBounds,
  ComputerUseMouseButton,
} from "./computer-use-accessibility";
import type { ComputerUsePermissionState } from "./computer-use-types";

type ComputerUseNativeErrorCode = ComputerUseCommandFailure["error"]["code"];

export interface ComputerUseNativeClickPointRequest {
  readonly app: string;
  readonly snapshotId: string;
  readonly x: number;
  readonly y: number;
  readonly screenshotSource: "window" | "screen";
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
  readonly windowId?: number;
  readonly windowFrame?: ComputerUseCoordinateBounds;
  readonly button: ComputerUseMouseButton;
  readonly clickCount: number;
}

export type ComputerUseNativeActionResult = Record<string, unknown>;

export type ComputerUseNativeClickPointResult =
  ComputerUseNativeActionResult & {
    readonly screenX: number;
    readonly screenY: number;
  };

export type ComputerUseNativePressKeyResult = ComputerUseNativeActionResult & {
  readonly normalizedKey: string;
};

export type ComputerUseNativeTypeTextResult = ComputerUseNativeActionResult & {
  readonly role?: string;
  readonly description?: string;
};

export interface ComputerUseNativeBackend {
  readonly dispose: () => void;
  readonly getPermissions: () => Promise<ComputerUsePermissionState>;
  readonly requestAccessibilityPermission: () => Promise<ComputerUsePermissionState>;
  readonly listApps: () => Promise<readonly string[]>;
  readonly getAppState: (
    app: string,
    snapshotId: string,
  ) => Promise<AccessibilityAppStateSnapshot>;
  readonly openApp: (app: string) => Promise<ComputerUseNativeActionResult>;
  readonly clickElement: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly button: ComputerUseMouseButton;
    readonly clickCount: number;
  }) => Promise<ComputerUseNativeActionResult>;
  readonly clickPoint: (
    args: ComputerUseNativeClickPointRequest,
  ) => Promise<ComputerUseNativeClickPointResult>;
  readonly setElementValue: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly value: string;
  }) => Promise<ComputerUseNativeActionResult>;
  readonly performElementAction: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly action: string;
  }) => Promise<ComputerUseNativeActionResult>;
  readonly typeText: (args: {
    readonly app: string;
    readonly text: string;
  }) => Promise<ComputerUseNativeTypeTextResult>;
  readonly pressKey: (args: {
    readonly app: string;
    readonly key: string;
  }) => Promise<ComputerUseNativePressKeyResult>;
  readonly scrollElement: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly direction: string;
    readonly pages: number;
  }) => Promise<ComputerUseNativeActionResult>;
}

type ComputerUseNativeRequest = Record<string, unknown> & {
  readonly kind: string;
};

interface ComputerUseNativeSuccessResponse {
  readonly status: "succeeded";
  readonly result?: unknown;
}

interface ComputerUseNativeFailureResponse {
  readonly status: "failed";
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

type ComputerUseNativeResponse =
  | ComputerUseNativeSuccessResponse
  | ComputerUseNativeFailureResponse;

interface ResolveComputerUseHelperPathOptions {
  readonly appRoot?: string;
  readonly resourcesPath?: string;
  readonly exists?: (candidate: string) => boolean;
}

interface RunComputerUseHelperOptions {
  readonly helperPath?: string;
  readonly mode?: "serve" | "oneshot";
}

export class ComputerUseNativeHelperError extends Error {
  constructor(
    readonly code: ComputerUseNativeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseNativeHelperError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseErrorCode(value: unknown): ComputerUseNativeErrorCode {
  if (
    value === "permission_denied" ||
    value === "accessibility_unavailable" ||
    value === "screen_recording_unavailable" ||
    value === "app_not_found" ||
    value === "app_open_failed" ||
    value === "unsupported_command"
  ) {
    return value;
  }
  return "accessibility_unavailable";
}

function responseErrorMessage(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "Native Computer Use helper failed";
}

function parseHelperResponse(output: string): ComputerUseNativeResponse {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed)) {
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Native Computer Use helper returned a non-object response",
    );
  }

  if (parsed.status === "succeeded") {
    return { status: "succeeded", result: parsed.result };
  }
  if (parsed.status === "failed") {
    return {
      status: "failed",
      error: isRecord(parsed.error) ? parsed.error : undefined,
    };
  }

  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    "Native Computer Use helper returned an invalid response status",
  );
}

function resultRecord(result: unknown, kind: string): Record<string, unknown> {
  if (isRecord(result)) {
    return result;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid result for ${kind}`,
  );
}

function resultStringArray(
  result: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = result[key];
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => {
      return typeof entry === "string";
    })
  ) {
    return value;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid ${key}`,
  );
}

function resultOptionalString(
  result: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = result[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function resultRequiredString(
  result: Record<string, unknown>,
  key: string,
): string {
  const value = result[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid ${key}`,
  );
}

function resultRequiredNumber(
  result: Record<string, unknown>,
  key: string,
): number {
  const value = result[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid ${key}`,
  );
}

function resultPermissions(
  result: Record<string, unknown>,
): ComputerUsePermissionState {
  if (
    typeof result.accessibility === "boolean" &&
    typeof result.screenRecording === "boolean"
  ) {
    return {
      accessibility: result.accessibility,
      screenRecording: result.screenRecording,
    };
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    "Native Computer Use helper returned invalid permissions",
  );
}

function helperPathCandidates(
  options: ResolveComputerUseHelperPathOptions,
): readonly [string, string, string] {
  const appRoot = options.appRoot ?? path.resolve(__dirname, "..");
  const resourcesPath =
    options.resourcesPath ?? process.resourcesPath ?? appRoot;
  return [
    path.join(resourcesPath, "native", "computer-use-helper"),
    path.join(appRoot, "native", "dist", "native", "computer-use-helper"),
    path.join(
      appRoot,
      "native",
      "computer-use-helper",
      ".build",
      "release",
      "computer-use-helper",
    ),
  ];
}

export function resolveComputerUseHelperPath(
  options: ResolveComputerUseHelperPathOptions = {},
): string {
  const exists = options.exists ?? existsSync;
  const candidates = helperPathCandidates(options);
  const existing = candidates.find((candidate) => {
    return exists(candidate);
  });
  return existing ?? candidates[1];
}

async function runComputerUseHelper(
  request: ComputerUseNativeRequest,
  options: RunComputerUseHelperOptions = {},
): Promise<Record<string, unknown>> {
  const helperPath = options.helperPath ?? resolveComputerUseHelperPath();
  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(
        new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          `Unable to start native Computer Use helper: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new ComputerUseNativeHelperError(
            "accessibility_unavailable",
            stderr.trim() ||
              `Native Computer Use helper exited with status ${code ?? "null"}`,
          ),
        );
        return;
      }

      try {
        const response = parseHelperResponse(stdout.trim());
        if (response.status === "failed") {
          throw new ComputerUseNativeHelperError(
            responseErrorCode(response.error?.code),
            responseErrorMessage(response.error?.message),
          );
        }
        resolve(resultRecord(response.result ?? {}, request.kind));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

interface PendingRuntimeRequest {
  readonly kind: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

function runtimePayload(
  request: ComputerUseNativeRequest,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key !== "kind" && value !== undefined) {
      payload[key] = value;
    }
  }
  return payload;
}

class ComputerUseNativeRuntimeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private requestCounter = 0;
  private closed = false;
  private stderr = "";
  private readonly pending = new Map<string, PendingRuntimeRequest>();

  constructor(private readonly helperPath: string) {}

  request(request: ComputerUseNativeRequest): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(
        new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          "Native Computer Use runtime is closed",
        ),
      );
    }
    const child = this.ensureChild();
    const id = `desktop_${(this.requestCounter += 1).toString()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: request.kind, resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ id, kind: request.kind, payload: runtimePayload(request) })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(
              new ComputerUseNativeHelperError(
                "accessibility_unavailable",
                `Unable to write to native Computer Use runtime: ${error.message}`,
              ),
            );
          }
        },
      );
    });
  }

  dispose(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(
        new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          "Native Computer Use runtime was closed",
        ),
      );
    }
    this.pending.clear();
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

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdout(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.on("error", (error) => {
      this.rejectAll(
        new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          `Unable to start native Computer Use runtime: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      this.child = null;
      if (!this.closed) {
        this.rejectAll(
          new ComputerUseNativeHelperError(
            "accessibility_unavailable",
            this.stderr.trim() ||
              `Native Computer Use runtime exited with status ${code ?? "null"}`,
          ),
        );
      }
    });
    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleResponseLine(line);
      }
    }
  }

  private handleResponseLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed) || typeof parsed.id !== "string") {
        throw new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          "Native Computer Use runtime returned an uncorrelated response",
        );
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);
      const response = parseHelperResponse(line);
      if (response.status === "failed") {
        pending.reject(
          new ComputerUseNativeHelperError(
            responseErrorCode(response.error?.code),
            responseErrorMessage(response.error?.message),
          ),
        );
        return;
      }
      pending.resolve(resultRecord(response.result ?? {}, pending.kind));
    } catch (error) {
      const helperError =
        error instanceof Error
          ? error
          : new ComputerUseNativeHelperError(
              "accessibility_unavailable",
              String(error),
            );
      this.rejectAll(helperError);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createComputerUseNativeBackend(
  options: RunComputerUseHelperOptions = {},
): ComputerUseNativeBackend {
  const helperPath = options.helperPath ?? resolveComputerUseHelperPath();
  const runtime =
    options.mode === "oneshot"
      ? null
      : new ComputerUseNativeRuntimeClient(helperPath);
  const run = async (
    request: ComputerUseNativeRequest,
  ): Promise<Record<string, unknown>> => {
    return runtime
      ? await runtime.request(request)
      : await runComputerUseHelper(request, { ...options, helperPath });
  };

  return {
    dispose: () => {
      runtime?.dispose();
    },
    getPermissions: async () => {
      const result = await run({ kind: "permissions.state" });
      return resultPermissions(result);
    },
    requestAccessibilityPermission: async () => {
      const result = await run({ kind: "permissions.request_accessibility" });
      return resultPermissions(result);
    },
    listApps: async () => {
      const result = await run({ kind: "apps.list" });
      return resultStringArray(result, "apps");
    },
    getAppState: async (app, snapshotId) => {
      const result = await run({ kind: "app.state", app, snapshotId });
      return result as unknown as AccessibilityAppStateSnapshot;
    },
    openApp: async (app) => {
      return await run({ kind: "app.open", app });
    },
    clickElement: async (args) => {
      return await run({ kind: "element.click", ...args });
    },
    clickPoint: async (args) => {
      const result = await run({ kind: "element.click", ...args });
      return {
        ...result,
        screenX: resultRequiredNumber(result, "screenX"),
        screenY: resultRequiredNumber(result, "screenY"),
      };
    },
    setElementValue: async (args) => {
      return await run({ kind: "element.set_value", ...args });
    },
    performElementAction: async (args) => {
      return await run({ kind: "element.perform_action", ...args });
    },
    typeText: async (args) => {
      const result = await run({ kind: "keyboard.type_text", ...args });
      const role = resultOptionalString(result, "role");
      const description = resultOptionalString(result, "description");
      return {
        ...result,
        ...(role ? { role } : {}),
        ...(description ? { description } : {}),
      };
    },
    pressKey: async (args) => {
      const result = await run({ kind: "keyboard.press_key", ...args });
      return {
        ...result,
        normalizedKey: resultRequiredString(result, "normalizedKey"),
      };
    },
    scrollElement: async (args) => {
      return await run({ kind: "element.scroll", ...args });
    },
  };
}
