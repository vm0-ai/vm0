import { optionalEnv } from "../../lib/env";
import {
  getVercelSandboxClient,
  VERCEL_SANDBOX_SMOKE_RUNTIME,
  VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
} from "../external/vercel-sandbox";
import {
  sandboxOperation,
  type CreateSandboxOptions,
  type SandboxCleanupResult,
  type SandboxCommandResult,
  type SandboxError,
  type SandboxHandle,
} from "../external/sandbox";
import {
  CLI_AUTH_TOOLCHAIN_SNAPSHOT_ID_ENV,
  cliAuthStripeInstallScript,
  cliAuthStripeVersionScript,
} from "./cli-auth-toolchain.service";

const NODE_SMOKE_COMMAND = Object.freeze({
  cmd: "node",
  args: ["--version"] as const,
});
const STRIPE_SMOKE_COMMAND = Object.freeze({
  cmd: "stripe",
  args: ["--version"] as const,
});
const SMOKE_OUTPUT_LIMIT_BYTES = 4 * 1024;

export type VercelSandboxSmokePhase = "create" | "run" | "cleanup";
export type VercelSandboxSmokeCheckName = "node" | "cli-auth-stripe";

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
  readonly cmd: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VercelSandboxSmokeSandbox {
  readonly id: string;
  readonly runtime: typeof VERCEL_SANDBOX_SMOKE_RUNTIME;
}

export interface VercelSandboxSmokeCheck {
  readonly name: VercelSandboxSmokeCheckName;
  readonly sandbox: VercelSandboxSmokeSandbox;
  readonly command: VercelSandboxSmokeCommand;
  readonly cleanup: { readonly status: "stopped" };
}

type SmokeCheckDefinition = {
  readonly name: VercelSandboxSmokeCheckName;
  readonly createOptions: CreateSandboxOptions;
  readonly runCommand: {
    readonly cmd: string;
    readonly args: readonly string[];
  };
  readonly displayCommand: {
    readonly cmd: string;
    readonly args: readonly string[];
  };
};

type SmokeCheckResult =
  | { readonly ok: true; readonly check: VercelSandboxSmokeCheck }
  | {
      readonly ok: false;
      readonly checkName: VercelSandboxSmokeCheckName;
      readonly phase: VercelSandboxSmokePhase;
      readonly error: VercelSandboxSmokeError;
      readonly sandbox?: VercelSandboxSmokeSandbox;
      readonly command?: VercelSandboxSmokeCommand;
      readonly cleanup?: VercelSandboxSmokeCleanup;
    };

export type VercelSandboxSmokeResult =
  | {
      readonly ok: true;
      readonly checks: readonly VercelSandboxSmokeCheck[];
    }
  | {
      readonly ok: false;
      readonly checkName: VercelSandboxSmokeCheckName;
      readonly phase: VercelSandboxSmokePhase;
      readonly error: VercelSandboxSmokeError;
      readonly checks: readonly VercelSandboxSmokeCheck[];
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
  definition: SmokeCheckDefinition,
  result: SandboxCommandResult & { readonly exitCode: number },
): VercelSandboxSmokeCommand {
  return {
    cmd: definition.displayCommand.cmd,
    args: definition.displayCommand.args,
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

function cliAuthStripeSmokeDefinition(): SmokeCheckDefinition {
  const snapshotId = optionalEnv(CLI_AUTH_TOOLCHAIN_SNAPSHOT_ID_ENV);
  if (snapshotId) {
    return {
      name: "cli-auth-stripe",
      createOptions: {
        source: { type: "snapshot", snapshotId },
        timeoutMs: VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
      },
      runCommand: {
        cmd: "sh",
        args: ["-lc", cliAuthStripeVersionScript()],
      },
      displayCommand: STRIPE_SMOKE_COMMAND,
    };
  }

  return {
    name: "cli-auth-stripe",
    createOptions: {
      runtime: VERCEL_SANDBOX_SMOKE_RUNTIME,
      timeoutMs: VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
    },
    runCommand: {
      cmd: "sh",
      args: [
        "-lc",
        `${cliAuthStripeInstallScript()}
${cliAuthStripeVersionScript()}`,
      ],
    },
    displayCommand: STRIPE_SMOKE_COMMAND,
  };
}

async function runSmokeCheck(
  definition: SmokeCheckDefinition,
  signal: AbortSignal,
): Promise<SmokeCheckResult> {
  const client = getVercelSandboxClient();
  const createResult = await sandboxOperation("create", () => {
    return client.create({
      ...definition.createOptions,
      signal,
    });
  });

  if (!createResult.ok) {
    return {
      ok: false,
      checkName: definition.name,
      phase: "create",
      error: smokeError(createResult.error),
    };
  }

  const sandbox = createResult.value;
  let command: VercelSandboxSmokeCommand | undefined;
  let runError: VercelSandboxSmokeError | undefined;

  const runResult = await sandboxOperation("run", () => {
    return client.runCommand(sandbox, {
      cmd: definition.runCommand.cmd,
      args: definition.runCommand.args,
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
      command = commandInfo(definition, {
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
      checkName: definition.name,
      phase: "run",
      error: runError,
      sandbox: sandboxPayload,
      cleanup,
    };
  }

  if (!command) {
    return {
      ok: false,
      checkName: definition.name,
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
      checkName: definition.name,
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
      checkName: definition.name,
      phase: "cleanup",
      error: cleanup.error,
      sandbox: sandboxPayload,
      command,
      cleanup,
    };
  }

  return {
    ok: true,
    check: {
      name: definition.name,
      sandbox: sandboxPayload,
      command,
      cleanup,
    },
  };
}

export async function runVercelSandboxSmoke(
  signal: AbortSignal,
): Promise<VercelSandboxSmokeResult> {
  const checks: VercelSandboxSmokeCheck[] = [];
  const definitions: readonly SmokeCheckDefinition[] = [
    {
      name: "node",
      createOptions: {
        runtime: VERCEL_SANDBOX_SMOKE_RUNTIME,
        timeoutMs: VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
      },
      runCommand: NODE_SMOKE_COMMAND,
      displayCommand: NODE_SMOKE_COMMAND,
    },
    cliAuthStripeSmokeDefinition(),
  ];

  for (const definition of definitions) {
    const result = await runSmokeCheck(definition, signal);
    if (!result.ok) {
      return {
        ok: false,
        checkName: result.checkName,
        phase: result.phase,
        error: result.error,
        checks,
        ...(result.sandbox ? { sandbox: result.sandbox } : {}),
        ...(result.command ? { command: result.command } : {}),
        ...(result.cleanup ? { cleanup: result.cleanup } : {}),
      };
    }
    checks.push(result.check);
  }

  return {
    ok: true,
    checks,
  };
}
