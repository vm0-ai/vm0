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
  type SandboxClient,
  type SandboxCommandResult,
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

function createRealVercelSandboxClient(): SandboxClient {
  return {
    async create(options = {}): Promise<SandboxHandle> {
      const Sandbox = await getVercelSandboxClass();
      const sandbox = await Sandbox.create({
        runtime: options.runtime,
        timeout: options.timeoutMs,
        resources: options.resources,
        ports: options.ports ? [...options.ports] : undefined,
        env: options.env ? { ...options.env } : undefined,
        networkPolicy: options.networkPolicy as VercelNetworkPolicy | undefined,
        signal: options.signal,
      });

      return { sandboxId: sandbox.sandboxId };
    },

    async get(sandboxId, options = {}): Promise<SandboxHandle> {
      const sandbox = await getSandbox({ sandboxId }, options.signal);
      return { sandboxId: sandbox.sandboxId };
    },

    async runCommand(handle, options): Promise<SandboxCommandResult> {
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
    },

    async readFile(handle, options): Promise<SandboxFileReadResult> {
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
    },

    async updateNetworkPolicy(handle, options): Promise<void> {
      const sandbox = await getSandbox(handle, options.signal);
      await sandbox.updateNetworkPolicy(
        options.networkPolicy as VercelNetworkPolicy,
        { signal: options.signal },
      );
    },

    async extendTimeout(handle, options): Promise<void> {
      const sandbox = await getSandbox(handle, options.signal);
      await sandbox.extendTimeout(options.durationMs, {
        signal: options.signal,
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
