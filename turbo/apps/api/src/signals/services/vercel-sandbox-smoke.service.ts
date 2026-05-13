import { timeout } from "signal-timers";

import {
  getVercelSandboxClient,
  getVercelSandboxSmokeCleanupTimeoutMs,
  VERCEL_SANDBOX_SMOKE_RUNTIME,
  VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
  type VercelSandboxCommandResult,
  type VercelSandboxInstance,
} from "../external/vercel-sandbox";

const SMOKE_COMMAND = Object.freeze({
  cmd: "node",
  args: ["--version"] as const,
});

type SandboxOperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export type VercelSandboxSmokePhase = "create" | "run" | "cleanup";

export interface VercelSandboxSmokeError {
  readonly message: string;
  readonly name: string;
}

export type VercelSandboxSmokeCleanup =
  | {
      readonly status: "stopped";
    }
  | {
      readonly status: "failed";
      readonly error: VercelSandboxSmokeError;
    };

export interface VercelSandboxSmokeCommand {
  readonly cmd: typeof SMOKE_COMMAND.cmd;
  readonly args: typeof SMOKE_COMMAND.args;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VercelSandboxSmokeSandbox {
  readonly id: string;
  readonly runtime: typeof VERCEL_SANDBOX_SMOKE_RUNTIME;
}

export type VercelSandboxSmokeResult =
  | {
      readonly ok: true;
      readonly sandbox: VercelSandboxSmokeSandbox;
      readonly command: VercelSandboxSmokeCommand;
      readonly cleanup: { readonly status: "stopped" };
    }
  | {
      readonly ok: false;
      readonly phase: VercelSandboxSmokePhase;
      readonly error: VercelSandboxSmokeError;
      readonly sandbox?: VercelSandboxSmokeSandbox;
      readonly command?: VercelSandboxSmokeCommand;
      readonly cleanup?: VercelSandboxSmokeCleanup;
    };

function redactErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /(["']?\b[\w.-]*(?:token|secret|password)[\w.-]*\b["']?\s*[:=]\s*)(["']?)[^"',}&\s]+(["']?)/gi,
      "$1$2[redacted]$3",
    )
    .slice(0, 1000);
}

function smokeError(error: unknown): VercelSandboxSmokeError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactErrorMessage(error.message),
    };
  }

  return {
    name: "Error",
    message: redactErrorMessage(String(error)),
  };
}

function sandboxInfo(
  sandbox: VercelSandboxInstance,
): VercelSandboxSmokeSandbox {
  return {
    id: sandbox.id,
    runtime: VERCEL_SANDBOX_SMOKE_RUNTIME,
  };
}

function commandInfo(
  result: VercelSandboxCommandResult,
): VercelSandboxSmokeCommand {
  return {
    cmd: SMOKE_COMMAND.cmd,
    args: SMOKE_COMMAND.args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sandboxOperation<T>(
  fn: () => Promise<T>,
): Promise<SandboxOperationResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        return { ok: true, value } as const;
      },
      (error: unknown) => {
        return { ok: false, error } as const;
      },
    );
}

function cleanupTimeoutError(): Error {
  const error = new Error("Vercel Sandbox cleanup timed out");
  error.name = "AbortError";
  return error;
}

function canceledCleanupTimeoutResult(
  signal: AbortSignal,
): SandboxOperationResult<void> {
  return {
    ok: false,
    error:
      signal.reason ?? new Error("Vercel Sandbox cleanup timeout canceled"),
  };
}

function cleanupTimeoutResult(
  cleanupController: AbortController,
): SandboxOperationResult<void> {
  const error = cleanupTimeoutError();
  cleanupController.abort(error);

  return { ok: false, error };
}

function cleanupTimeoutOperation(
  cleanupController: AbortController,
  cleanupTimeoutSignal: AbortSignal,
): Promise<SandboxOperationResult<void>> {
  return new Promise((resolve) => {
    let settled = false;
    function finish(result: SandboxOperationResult<void>) {
      if (settled) {
        return;
      }
      settled = true;
      cleanupTimeoutSignal.removeEventListener("abort", onAbort);
      resolve(result);
    }
    function onAbort() {
      finish(canceledCleanupTimeoutResult(cleanupTimeoutSignal));
    }

    cleanupTimeoutSignal.addEventListener("abort", onAbort, { once: true });
    timeout(
      () => {
        finish(cleanupTimeoutResult(cleanupController));
      },
      getVercelSandboxSmokeCleanupTimeoutMs(),
      { signal: cleanupTimeoutSignal },
    );
  });
}

async function stopSandbox(
  sandbox: VercelSandboxInstance,
): Promise<VercelSandboxSmokeCleanup> {
  const cleanupController = new AbortController();
  const cleanupTimeoutController = new AbortController();
  const stopResultPromise = sandboxOperation(() => {
    return sandbox.stop({ signal: cleanupController.signal });
  });
  const cleanupTimeoutResultPromise = cleanupTimeoutOperation(
    cleanupController,
    cleanupTimeoutController.signal,
  );

  const stopResult = await Promise.race([
    stopResultPromise,
    cleanupTimeoutResultPromise,
  ]).finally(() => {
    cleanupTimeoutController.abort();
  });

  if (stopResult.ok) {
    return { status: "stopped" };
  }

  return {
    status: "failed",
    error: smokeError(stopResult.error),
  };
}

export async function runVercelSandboxSmoke(
  signal: AbortSignal,
): Promise<VercelSandboxSmokeResult> {
  const client = getVercelSandboxClient();
  const createResult = await sandboxOperation(() => {
    return client.create({
      runtime: VERCEL_SANDBOX_SMOKE_RUNTIME,
      timeoutMs: VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
      signal,
    });
  });

  if (!createResult.ok) {
    return {
      ok: false,
      phase: "create",
      error: smokeError(createResult.error),
    };
  }

  const sandbox = createResult.value;
  let command: VercelSandboxSmokeCommand | undefined;
  let runError: VercelSandboxSmokeError | undefined;

  const runResult = await sandboxOperation(() => {
    return sandbox.runCommand({
      cmd: SMOKE_COMMAND.cmd,
      args: SMOKE_COMMAND.args,
      signal,
    });
  });

  if (runResult.ok) {
    command = commandInfo(runResult.value);
  } else {
    runError = smokeError(runResult.error);
  }

  const cleanup = await stopSandbox(sandbox);
  const sandboxPayload = sandboxInfo(sandbox);

  if (runError) {
    return {
      ok: false,
      phase: "run",
      error: runError,
      sandbox: sandboxPayload,
      cleanup,
    };
  }

  if (!command) {
    return {
      ok: false,
      phase: "run",
      error: {
        name: "Error",
        message: "Smoke command did not produce a result",
      },
      sandbox: sandboxPayload,
      cleanup,
    };
  }

  if (command.exitCode !== 0) {
    return {
      ok: false,
      phase: "run",
      error: {
        name: "Error",
        message: `Smoke command exited with code ${command.exitCode}`,
      },
      sandbox: sandboxPayload,
      command,
      cleanup,
    };
  }

  if (cleanup.status === "failed") {
    return {
      ok: false,
      phase: "cleanup",
      error: cleanup.error,
      sandbox: sandboxPayload,
      command,
      cleanup,
    };
  }

  return {
    ok: true,
    sandbox: sandboxPayload,
    command,
    cleanup,
  };
}
