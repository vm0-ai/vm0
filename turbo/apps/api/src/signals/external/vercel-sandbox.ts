import { singleton } from "../../lib/singleton";
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
} from "./sandbox";

type VercelSandboxSdk = typeof import("@vercel/sandbox");
type VercelNetworkPolicy = import("@vercel/sandbox").NetworkPolicy;

export const VERCEL_SANDBOX_SMOKE_RUNTIME = "node24";
export const VERCEL_SANDBOX_SMOKE_TIMEOUT_MS = 60 * 1000;

const getVercelSandboxClass = singleton(
  async (): Promise<VercelSandboxSdk["Sandbox"]> => {
    // The SDK is only needed by sandbox-backed flows; keep normal API route init light.
    const sdk = await import("@vercel/sandbox");
    return sdk.Sandbox;
  },
);

async function getSandbox(
  handle: SandboxHandle,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<VercelSandboxSdk["Sandbox"]["get"]>>> {
  const Sandbox = await getVercelSandboxClass();
  return Sandbox.get({ sandboxId: handle.sandboxId, signal });
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

function createRealVercelSandboxClient(): SandboxClient {
  return {
    create(options = {}): Promise<SandboxHandle> {
      return vercelSandboxOperation("create", async () => {
        const Sandbox = await getVercelSandboxClass();
        const sandbox = await Sandbox.create({
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
          const command = await sandbox.runCommand({
            cmd: options.cmd,
            args: options.args ? [...options.args] : undefined,
            cwd: options.cwd,
            env: options.env ? { ...options.env } : undefined,
            detached: true,
            signal: options.signal,
          });

          return {
            sandboxId: handle.sandboxId,
            commandId: command.cmdId,
            detached: true,
            exitCode: command.exitCode,
            stdout: emptyBoundedTextOutput(outputLimitBytes),
            stderr: emptyBoundedTextOutput(outputLimitBytes),
          };
        }

        const stdout = createBoundedTextCollector(outputLimitBytes);
        const stderr = createBoundedTextCollector(outputLimitBytes);
        const command = await sandbox.runCommand({
          cmd: options.cmd,
          args: options.args ? [...options.args] : undefined,
          cwd: options.cwd,
          env: options.env ? { ...options.env } : undefined,
          stdout: stdout.writable,
          stderr: stderr.writable,
          signal: options.signal,
        });

        return {
          sandboxId: handle.sandboxId,
          commandId: command.cmdId,
          detached: false,
          exitCode: command.exitCode,
          stdout: stdout.output(),
          stderr: stderr.output(),
        };
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
