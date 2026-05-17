import { optionalEnv } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import { onRejection } from "../utils";
import {
  createBoundedTextCollector,
  DEFAULT_SANDBOX_FILE_LIMIT_BYTES,
  DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
  emptyBoundedTextOutput,
  getMockSandboxClient,
  getSandboxCleanupTimeoutMs,
  normalizeSandboxLimitBytes,
  readStreamToBoundedBuffer,
  sandboxCleanupOperation,
  sandboxErrorToException,
  sandboxOperation,
  type SandboxClient,
  type SandboxCommandResult,
  type SandboxErrorPhase,
  type SandboxFileReadResult,
  type SandboxHandle,
  type RunSandboxCommandOptions,
} from "./sandbox";

type VercelSandboxSdk = typeof import("@vercel/sandbox");
type VercelNetworkPolicy = import("@vercel/sandbox").NetworkPolicy;
type VercelCommandLog = {
  readonly stream: string;
  readonly data: string;
};
type VercelCommandLike = {
  readonly cmdId: string;
  readonly exitCode: number | null;
  readonly wait: (params?: {
    readonly signal?: AbortSignal;
  }) => Promise<VercelCommandLike>;
  readonly logs: (params?: {
    readonly signal?: AbortSignal;
  }) => VercelCommandLogStream;
};
type VercelCommandLogStream = AsyncIterable<VercelCommandLog> & {
  readonly close?: () => void;
};
type VercelSandboxCredentials = {
  readonly teamId: string;
  readonly projectId: string;
  readonly token: string;
};
type VercelSandboxInstance = Awaited<ReturnType<typeof getSandbox>>;
type VercelCommandOutput = Awaited<ReturnType<typeof collectVercelCommandLogs>>;

export const VERCEL_SANDBOX_SMOKE_RUNTIME = "node24";
export const VERCEL_SANDBOX_SMOKE_TIMEOUT_MS = 60 * 1000;

const VERCEL_SANDBOX_ACCESS_TOKEN_ENV_NAMES = [
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID_API",
  "VERCEL_TOKEN",
] as const;

const getVercelSandboxClass = singleton(
  async (): Promise<VercelSandboxSdk["Sandbox"]> => {
    // The SDK is only needed by sandbox-backed flows; keep normal API route init light.
    const sdk = await import("@vercel/sandbox");
    return sdk.Sandbox;
  },
);

function isVercelOidcRuntime(): boolean {
  return Boolean(
    optionalEnv("VERCEL_OIDC_TOKEN") ||
    optionalEnv("VERCEL") ||
    optionalEnv("VERCEL_ENV") ||
    optionalEnv("VERCEL_URL"),
  );
}

export function getVercelSandboxCredentials():
  | VercelSandboxCredentials
  | undefined {
  // In deployed Vercel runtimes, let the SDK resolve and refresh OIDC tokens.
  if (isVercelOidcRuntime()) {
    return undefined;
  }

  const teamId = optionalEnv("VERCEL_TEAM_ID");
  const projectId = optionalEnv("VERCEL_PROJECT_ID_API");
  const token = optionalEnv("VERCEL_TOKEN");
  const values = {
    VERCEL_TEAM_ID: teamId,
    VERCEL_PROJECT_ID_API: projectId,
    VERCEL_TOKEN: token,
  };
  const missing = VERCEL_SANDBOX_ACCESS_TOKEN_ENV_NAMES.filter((name) => {
    return !values[name];
  });

  if (missing.length === VERCEL_SANDBOX_ACCESS_TOKEN_ENV_NAMES.length) {
    return undefined;
  }
  if (!teamId || !projectId || !token) {
    throw new Error(
      `Missing Vercel Sandbox access-token environment variables: ${missing.join(
        ", ",
      )}`,
    );
  }

  return {
    teamId,
    projectId,
    token,
  };
}

async function getSandbox(
  handle: SandboxHandle,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<VercelSandboxSdk["Sandbox"]["get"]>>> {
  const Sandbox = await getVercelSandboxClass();
  return Sandbox.get({
    ...getVercelSandboxCredentials(),
    sandboxId: handle.sandboxId,
    signal,
  });
}

async function vercelSandboxOperation<T>(
  phase: SandboxErrorPhase,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await sandboxOperation(phase, operation);
  if (result.ok) {
    return result.value;
  }

  throw sandboxErrorToException(result.error);
}

async function collectVercelCommandLogs(
  logs: AsyncIterable<VercelCommandLog>,
  outputLimitBytes: number,
  signal?: AbortSignal,
) {
  const stdout = createBoundedTextCollector(outputLimitBytes);
  const stderr = createBoundedTextCollector(outputLimitBytes);

  for await (const log of logs) {
    signal?.throwIfAborted();
    if (log.stream === "stdout") {
      stdout.writable.write(log.data);
      continue;
    }
    if (log.stream === "stderr") {
      stderr.writable.write(log.data);
    }
  }

  return {
    stdout: stdout.output(),
    stderr: stderr.output(),
  };
}

function closeVercelCommandLogs(logs: VercelCommandLogStream): void {
  logs.close?.();
}

function getVercelRunCommandParams(options: RunSandboxCommandOptions) {
  return {
    cmd: options.cmd,
    args: options.args ? [...options.args] : undefined,
    cwd: options.cwd,
    env: options.env ? { ...options.env } : undefined,
    detached: true as const,
    signal: options.signal,
  };
}

async function runDetachedVercelCommand(
  handle: SandboxHandle,
  sandbox: VercelSandboxInstance,
  options: RunSandboxCommandOptions,
  outputLimitBytes: number,
): Promise<SandboxCommandResult> {
  const command = await sandbox.runCommand(getVercelRunCommandParams(options));

  return {
    sandboxId: handle.sandboxId,
    commandId: command.cmdId,
    detached: true,
    exitCode: command.exitCode,
    stdout: emptyBoundedTextOutput(outputLimitBytes),
    stderr: emptyBoundedTextOutput(outputLimitBytes),
  };
}

async function waitForVercelCommandWithLogs(
  command: VercelCommandLike,
  outputLimitBytes: number,
  signal?: AbortSignal,
): Promise<{
  readonly command: VercelCommandLike;
  readonly output: VercelCommandOutput;
}> {
  const commandController = new AbortController();
  const commandSignal = signal
    ? AbortSignal.any([signal, commandController.signal])
    : commandController.signal;
  const logs = command.logs({ signal: commandSignal });

  const outputPromise = collectVercelCommandLogs(
    logs,
    outputLimitBytes,
    commandSignal,
  );
  const waitPromise = command.wait({ signal: commandSignal });
  const [finishedCommand, output] = await onRejection(
    Promise.all([waitPromise, outputPromise]),
    (error) => {
      commandController.abort(error);
      closeVercelCommandLogs(logs);
    },
  );
  return { command: finishedCommand, output };
}

async function runForegroundVercelCommand(
  handle: SandboxHandle,
  sandbox: VercelSandboxInstance,
  options: RunSandboxCommandOptions,
  outputLimitBytes: number,
): Promise<SandboxCommandResult> {
  const command = await sandbox.runCommand(getVercelRunCommandParams(options));
  const { command: finishedCommand, output } =
    await waitForVercelCommandWithLogs(
      command,
      outputLimitBytes,
      options.signal,
    );

  return {
    sandboxId: handle.sandboxId,
    commandId: finishedCommand.cmdId,
    detached: false,
    exitCode: finishedCommand.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
  };
}

function createRealVercelSandboxClient(): SandboxClient {
  return {
    create(options = {}): Promise<SandboxHandle> {
      return vercelSandboxOperation("create", async () => {
        const Sandbox = await getVercelSandboxClass();
        const sandbox = await Sandbox.create({
          ...getVercelSandboxCredentials(),
          runtime: options.runtime,
          timeout: options.timeoutMs,
          resources: options.resources,
          ports: options.ports ? [...options.ports] : undefined,
          env: options.env ? { ...options.env } : undefined,
          networkPolicy: options.networkPolicy as
            | VercelNetworkPolicy
            | undefined,
          signal: options.signal,
        });

        return { sandboxId: sandbox.sandboxId };
      });
    },

    get(sandboxId, options = {}): Promise<SandboxHandle> {
      return vercelSandboxOperation("get", async () => {
        const sandbox = await getSandbox({ sandboxId }, options.signal);
        return { sandboxId: sandbox.sandboxId };
      });
    },

    runCommand(handle, options): Promise<SandboxCommandResult> {
      return vercelSandboxOperation("run", async () => {
        const outputLimitBytes = normalizeSandboxLimitBytes(
          options.outputLimitBytes,
          DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
        );
        const sandbox = await getSandbox(handle, options.signal);

        if (options.detached) {
          return runDetachedVercelCommand(
            handle,
            sandbox,
            options,
            outputLimitBytes,
          );
        }

        return runForegroundVercelCommand(
          handle,
          sandbox,
          options,
          outputLimitBytes,
        );
      });
    },

    readFile(handle, options): Promise<SandboxFileReadResult> {
      return vercelSandboxOperation("read", async () => {
        const limitBytes = normalizeSandboxLimitBytes(
          options.limitBytes,
          DEFAULT_SANDBOX_FILE_LIMIT_BYTES,
        );
        const sandbox = await getSandbox(handle, options.signal);
        const stream = await sandbox.readFile(
          { path: options.path, cwd: options.cwd },
          { signal: options.signal },
        );
        if (!stream) {
          return { status: "missing" };
        }

        return readStreamToBoundedBuffer(stream, limitBytes, options.signal);
      });
    },

    updateNetworkPolicy(handle, options): Promise<void> {
      return vercelSandboxOperation("network", async () => {
        const sandbox = await getSandbox(handle, options.signal);
        await sandbox.updateNetworkPolicy(
          options.networkPolicy as VercelNetworkPolicy,
          { signal: options.signal },
        );
      });
    },

    extendTimeout(handle, options): Promise<void> {
      return vercelSandboxOperation("extend-timeout", async () => {
        const sandbox = await getSandbox(handle, options.signal);
        await sandbox.extendTimeout(options.durationMs, {
          signal: options.signal,
        });
      });
    },

    stop(handle, options = {}) {
      return sandboxCleanupOperation({
        timeoutMs: options.timeoutMs ?? getSandboxCleanupTimeoutMs(),
        signal: options.signal,
        operation: async (signal) => {
          const sandbox = await getSandbox(handle, signal);
          await sandbox.stop({
            blocking: options.blocking ?? true,
            signal,
          });
        },
      });
    },
  };
}

export function getVercelSandboxClient(): SandboxClient {
  return getMockSandboxClient() ?? createRealVercelSandboxClient();
}
