import {
  getVercelSandboxClient,
  VERCEL_SANDBOX_SMOKE_RUNTIME,
  VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
} from "../external/vercel-sandbox";
import {
  sandboxOperation,
  type SandboxCleanupResult,
  type SandboxCommandResult,
  type SandboxError,
  type SandboxHandle,
} from "../external/sandbox";

const SMOKE_COMMAND = Object.freeze({
  cmd: "node",
  args: ["--version"] as const,
});
const SMOKE_OUTPUT_LIMIT_BYTES = 1024;

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

function smokeError(error: SandboxError): VercelSandboxSmokeError {
  return {
    name: error.name,
    message: error.message,
  };
}

function sandboxInfo(sandbox: SandboxHandle): VercelSandboxSmokeSandbox {
  return {
    id: sandbox.sandboxId,
    runtime: VERCEL_SANDBOX_SMOKE_RUNTIME,
  };
}

function commandInfo(
  result: SandboxCommandResult & { readonly exitCode: number },
): VercelSandboxSmokeCommand {
  return {
    cmd: SMOKE_COMMAND.cmd,
    args: SMOKE_COMMAND.args,
    exitCode: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

function smokeCleanup(
  cleanup: SandboxCleanupResult,
): VercelSandboxSmokeCleanup {
  if (cleanup.status === "stopped") {
    return { status: "stopped" };
  }

  return {
    status: "failed",
    error: smokeError(cleanup.error),
  };
}

export async function runVercelSandboxSmoke(
  signal: AbortSignal,
): Promise<VercelSandboxSmokeResult> {
  const client = getVercelSandboxClient();
  const createResult = await sandboxOperation("create", () => {
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

  const runResult = await sandboxOperation("run", () => {
    return client.runCommand(sandbox, {
      cmd: SMOKE_COMMAND.cmd,
      args: SMOKE_COMMAND.args,
      outputLimitBytes: SMOKE_OUTPUT_LIMIT_BYTES,
      signal,
    });
  });

  if (runResult.ok) {
    if (runResult.value.exitCode === null) {
      runError = {
        name: "Error",
        message: "Smoke command did not produce an exit code",
      };
    } else {
      command = commandInfo({
        ...runResult.value,
        exitCode: runResult.value.exitCode,
      });
    }
  } else {
    runError = smokeError(runResult.error);
  }

  const cleanup = smokeCleanup(await client.stop(sandbox));
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
