import type { LocalAgentBackend } from "@vm0/api-contracts/contracts/zero-local-agent";
import { safeSpawn } from "../utils/spawn";

interface LocalAgentBackendProbe {
  backend: LocalAgentBackend;
  command: string;
  available: boolean;
  version?: string;
}

interface LocalAgentExecutionResult {
  output: string;
  error?: string;
  exitCode: number;
}

export type LocalAgentPermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "plan"
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

const BACKEND_COMMANDS: Array<{
  backend: LocalAgentBackend;
  command: string;
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

async function probeBackend(
  backend: LocalAgentBackend,
  command: string,
): Promise<LocalAgentBackendProbe> {
  return new Promise((resolve) => {
    const child = safeSpawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const finish = (probe: LocalAgentBackendProbe) => {
      if (settled) return;
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

export async function detectLocalAgentBackends(): Promise<
  LocalAgentBackendProbe[]
> {
  return Promise.all(
    BACKEND_COMMANDS.map(({ backend, command }) => {
      return probeBackend(backend, command);
    }),
  );
}

function claudePermissionArgs(mode: LocalAgentPermissionMode): string[] {
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
  throw new Error(`Unsupported Claude Code permission mode: ${mode}`);
}

function codexPermissionArgs(mode: LocalAgentPermissionMode): string[] {
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
  throw new Error(`Unsupported Codex permission mode: ${mode}`);
}

function executionCommand(
  backend: LocalAgentBackend,
  prompt: string,
  permissionMode: LocalAgentPermissionMode,
  claudeArgs: readonly string[] = [],
): { command: string; args: string[] } {
  if (backend === "claude-code") {
    return {
      command: "claude",
      args: [
        "-p",
        ...claudePermissionArgs(permissionMode),
        ...claudeArgs,
        prompt,
      ],
    };
  }
  return {
    command: "codex",
    args: ["exec", ...codexPermissionArgs(permissionMode), prompt],
  };
}

function appendLimited(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_OUTPUT_BYTES) {
    return next;
  }
  return next.slice(-MAX_OUTPUT_BYTES);
}

export async function executeLocalAgentBackend(params: {
  backend: LocalAgentBackend;
  prompt: string;
  workdir: string;
  claudeArgs?: readonly string[];
  permissionMode: LocalAgentPermissionMode;
}): Promise<LocalAgentExecutionResult> {
  const { command, args } = executionCommand(
    params.backend,
    params.prompt,
    params.permissionMode,
    params.claudeArgs,
  );

  return new Promise((resolve) => {
    const child = safeSpawn(command, args, {
      cwd: params.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: LocalAgentExecutionResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

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
