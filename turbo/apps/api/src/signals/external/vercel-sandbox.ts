import { singleton, testOverride } from "../../lib/singleton";

type VercelSandboxSdk = typeof import("@vercel/sandbox");

export const VERCEL_SANDBOX_SMOKE_RUNTIME = "node24";
export const VERCEL_SANDBOX_SMOKE_TIMEOUT_MS = 60 * 1000;
const VERCEL_SANDBOX_SMOKE_CLEANUP_TIMEOUT_MS = 15 * 1000;

export interface VercelSandboxCommandOptions {
  readonly cmd: string;
  readonly args?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface VercelSandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VercelSandboxInstance {
  readonly id: string;
  readonly runCommand: (
    options: VercelSandboxCommandOptions,
  ) => Promise<VercelSandboxCommandResult>;
  readonly stop: (options?: { readonly signal?: AbortSignal }) => Promise<void>;
}

export interface CreateVercelSandboxOptions {
  readonly runtime?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface VercelSandboxClient {
  readonly create: (
    options?: CreateVercelSandboxOptions,
  ) => Promise<VercelSandboxInstance>;
}

const getVercelSandboxClass = singleton(
  async (): Promise<VercelSandboxSdk["Sandbox"]> => {
    // This SDK is only needed by the smoke route; keep normal API route init light.
    const sdk = await import("@vercel/sandbox");
    return sdk.Sandbox;
  },
);

function createRealVercelSandboxClient(): VercelSandboxClient {
  return {
    async create(options = {}): Promise<VercelSandboxInstance> {
      const Sandbox = await getVercelSandboxClass();
      const sandbox = await Sandbox.create({
        runtime: options.runtime ?? VERCEL_SANDBOX_SMOKE_RUNTIME,
        timeout: options.timeoutMs ?? VERCEL_SANDBOX_SMOKE_TIMEOUT_MS,
        signal: options.signal,
      });

      return {
        id: sandbox.sandboxId,
        async runCommand(
          commandOptions: VercelSandboxCommandOptions,
        ): Promise<VercelSandboxCommandResult> {
          const command = await sandbox.runCommand(
            commandOptions.cmd,
            [...(commandOptions.args ?? [])],
            { signal: commandOptions.signal },
          );
          const [stdout, stderr] = await Promise.all([
            command.stdout({ signal: commandOptions.signal }),
            command.stderr({ signal: commandOptions.signal }),
          ]);

          return {
            exitCode: command.exitCode,
            stdout,
            stderr,
          };
        },
        async stop(options = {}): Promise<void> {
          await sandbox.stop({ blocking: true, signal: options.signal });
        },
      };
    },
  };
}

const {
  get: getMockedVercelSandboxClient,
  set: setMockedVercelSandboxClient,
  clear: clearMockedVercelSandboxClient,
} = testOverride<VercelSandboxClient | undefined>(() => {
  return undefined;
});

const {
  get: getMockedVercelSandboxCleanupTimeoutMs,
  set: setMockedVercelSandboxCleanupTimeoutMs,
  clear: clearMockedVercelSandboxCleanupTimeoutMs,
} = testOverride<number | undefined>(() => {
  return undefined;
});

export function getVercelSandboxClient(): VercelSandboxClient {
  return getMockedVercelSandboxClient() ?? createRealVercelSandboxClient();
}

export function getVercelSandboxSmokeCleanupTimeoutMs(): number {
  return (
    getMockedVercelSandboxCleanupTimeoutMs() ??
    VERCEL_SANDBOX_SMOKE_CLEANUP_TIMEOUT_MS
  );
}

export function mockVercelSandboxClient(client: VercelSandboxClient): void {
  setMockedVercelSandboxClient(client);
}

export function clearMockVercelSandboxClient(): void {
  clearMockedVercelSandboxClient();
}

export function mockVercelSandboxSmokeCleanupTimeoutMs(
  timeoutMs: number,
): void {
  setMockedVercelSandboxCleanupTimeoutMs(timeoutMs);
}

export function clearMockVercelSandboxSmokeCleanupTimeoutMs(): void {
  clearMockedVercelSandboxCleanupTimeoutMs();
}
