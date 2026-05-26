import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  AccessibilityAppStateSnapshot,
  ComputerUseCommandFailure,
  ComputerUseMouseButton,
} from "./computer-use-accessibility";
import type { ComputerUsePermissionState } from "./computer-use-types";

type ComputerUseNativeErrorCode = ComputerUseCommandFailure["error"]["code"];

export interface ComputerUseNativeKeyModifier {
  readonly keyCode: number;
  readonly flag: number;
}

export interface ComputerUseNativePressKeyRequest {
  readonly app: string;
  readonly keyCode: number;
  readonly modifiers: readonly ComputerUseNativeKeyModifier[];
  readonly flags: number;
  readonly normalizedKey: string;
}

export interface ComputerUseNativeBackend {
  readonly getPermissions: () => Promise<ComputerUsePermissionState>;
  readonly requestAccessibilityPermission: () => Promise<ComputerUsePermissionState>;
  readonly listApps: () => Promise<readonly string[]>;
  readonly getAppState: (
    app: string,
    snapshotId: string,
  ) => Promise<AccessibilityAppStateSnapshot>;
  readonly openApp: (app: string) => Promise<void>;
  readonly clickElement: (args: {
    readonly app: string;
    readonly elementId: string;
    readonly button: ComputerUseMouseButton;
    readonly clickCount: number;
  }) => Promise<void>;
  readonly clickPoint: (args: {
    readonly app: string;
    readonly x: number;
    readonly y: number;
    readonly button: ComputerUseMouseButton;
    readonly clickCount: number;
  }) => Promise<void>;
  readonly setElementValue: (args: {
    readonly app: string;
    readonly elementId: string;
    readonly value: string;
  }) => Promise<void>;
  readonly performElementAction: (args: {
    readonly app: string;
    readonly elementId: string;
    readonly action: string;
  }) => Promise<void>;
  readonly typeText: (args: {
    readonly app: string;
    readonly text: string;
  }) => Promise<{ readonly role?: string; readonly description?: string }>;
  readonly pressKey: (args: ComputerUseNativePressKeyRequest) => Promise<void>;
  readonly scrollElement: (args: {
    readonly app: string;
    readonly elementId: string;
    readonly direction: string;
    readonly pages: number;
  }) => Promise<void>;
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

export function createComputerUseNativeBackend(
  options: RunComputerUseHelperOptions = {},
): ComputerUseNativeBackend {
  const run = async (
    request: ComputerUseNativeRequest,
  ): Promise<Record<string, unknown>> => {
    return await runComputerUseHelper(request, options);
  };

  return {
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
      await run({ kind: "app.open", app });
    },
    clickElement: async (args) => {
      await run({ kind: "element.click", ...args });
    },
    clickPoint: async (args) => {
      await run({ kind: "element.click_point", ...args });
    },
    setElementValue: async (args) => {
      await run({ kind: "element.set_value", ...args });
    },
    performElementAction: async (args) => {
      await run({ kind: "element.perform_action", ...args });
    },
    typeText: async (args) => {
      const result = await run({ kind: "keyboard.type_text", ...args });
      return {
        role: resultOptionalString(result, "role"),
        description: resultOptionalString(result, "description"),
      };
    },
    pressKey: async (args) => {
      await run({ kind: "keyboard.press_key", ...args });
    },
    scrollElement: async (args) => {
      await run({ kind: "element.scroll", ...args });
    },
  };
}
