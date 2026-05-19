import { spawn } from "node:child_process";
import type {
  DesktopLocalAgentBackend,
  DesktopLocalAgentBackendProbe,
  DesktopLocalAgentExecutionResult,
  DesktopLocalAgentPermissionMode,
} from "./desktop-local-agent-types";

const BACKEND_COMMANDS: ReadonlyArray<{
  readonly backend: DesktopLocalAgentBackend;
  readonly command: string;
}> = [
  { backend: "codex", command: "codex" },
  { backend: "claude-code", command: "claude" },
];

const MAX_OUTPUT_BYTES = 256 * 1024;

function firstLine(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((value) => {
      return value.trim();
    })
    .find((value) => {
      return value.length > 0;
    });
  return line?.slice(0, 120);
}

function appendLimited(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_OUTPUT_BYTES) {
    return next;
  }
  return next.slice(-MAX_OUTPUT_BYTES);
}

function unsupportedPermission(
  backend: DesktopLocalAgentBackend,
  mode: DesktopLocalAgentPermissionMode,
): Error {
  return new Error(`Unsupported ${backend} permission mode: ${mode}`);
}

function claudePermissionArgs(mode: DesktopLocalAgentPermissionMode): string[] {
  if (mode === "default") {
    return [];
  }
  if (
    mode === "acceptEdits" ||
    mode === "auto" ||
    mode === "bypassPermissions" ||
    mode === "dontAsk" ||
    mode === "plan"
  ) {
    return ["--permission-mode", mode];
  }
  throw unsupportedPermission("claude-code", mode);
}

function codexPermissionArgs(mode: DesktopLocalAgentPermissionMode): string[] {
  if (mode === "default") {
    return [];
  }
  if (
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "danger-full-access"
  ) {
    return ["--sandbox", mode];
  }
  if (mode === "bypassPermissions") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  throw unsupportedPermission("codex", mode);
}

export function defaultPermissionMode(
  backend: DesktopLocalAgentBackend,
): DesktopLocalAgentPermissionMode {
  return backend === "codex" ? "workspace-write" : "default";
}

function executionCommand(params: {
  readonly backend: DesktopLocalAgentBackend;
  readonly prompt: string;
  readonly permissionMode: DesktopLocalAgentPermissionMode;
}): { readonly command: string; readonly args: readonly string[] } {
  if (params.backend === "claude-code") {
    return {
      command: "claude",
      args: [
        "-p",
        ...claudePermissionArgs(params.permissionMode),
        params.prompt,
      ],
    };
  }
  return {
    command: "codex",
    args: [
      "exec",
      ...codexPermissionArgs(params.permissionMode),
      params.prompt,
    ],
  };
}

function probeBackend(
  backend: DesktopLocalAgentBackend,
  command: string,
): Promise<DesktopLocalAgentBackendProbe> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const finish = (probe: DesktopLocalAgentBackendProbe): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ backend, command, available: false });
    }, 2_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      finish({ backend, command, available: false });
    });
    child.on("close", (code) => {
      finish({
        backend,
        command,
        available: code === 0,
        version: code === 0 ? firstLine(output) : undefined,
      });
    });
  });
}

export function detectLocalAgentBackends(): Promise<
  DesktopLocalAgentBackendProbe[]
> {
  return Promise.all(
    BACKEND_COMMANDS.map(({ backend, command }) => {
      return probeBackend(backend, command);
    }),
  );
}

export function executeLocalAgentBackend(params: {
  readonly backend: DesktopLocalAgentBackend;
  readonly prompt: string;
  readonly workdir: string;
  readonly permissionMode: DesktopLocalAgentPermissionMode;
  readonly signal?: AbortSignal;
}): Promise<DesktopLocalAgentExecutionResult> {
  const { command, args } = executionCommand({
    backend: params.backend,
    prompt: params.prompt,
    permissionMode: params.permissionMode,
  });

  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: params.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: DesktopLocalAgentExecutionResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      params.signal?.removeEventListener("abort", abort);
      resolve(result);
    };

    const abort = (): void => {
      child.kill();
      finish({
        output: stdout.trimEnd(),
        error: "Local agent job was stopped",
        exitCode: 1,
      });
    };

    if (params.signal?.aborted) {
      abort();
      return;
    }
    params.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({
        output: stdout,
        error: error.message,
        exitCode: 1,
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const output = [stdout.trimEnd(), stderr.trimEnd()]
        .filter((value) => {
          return value.length > 0;
        })
        .join("\n");
      finish({
        output,
        error: exitCode === 0 ? undefined : stderr.trim() || undefined,
        exitCode,
      });
    });
  });
}
