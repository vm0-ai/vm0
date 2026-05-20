import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DesktopLocalAgentBackend,
  DesktopLocalAgentBackendProbe,
  DesktopLocalAgentExecutionResult,
  DesktopLocalAgentPermissionMode,
} from "./desktop-local-agent-types";

const BACKEND_COMMANDS: ReadonlyArray<{
  readonly backend: DesktopLocalAgentBackend;
  readonly command: string;
  readonly label: string;
}> = [
  { backend: "codex", command: "codex", label: "Codex" },
  { backend: "claude-code", command: "claude", label: "Claude Code" },
];

const COMMON_EXECUTABLE_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.local/bin",
  "~/.cargo/bin",
] as const;
const MAX_OUTPUT_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 2_000;

interface CommandOutput {
  readonly exitCode: number;
  readonly output: string;
  readonly error?: string;
}

interface ResolveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly commonExecutableDirectories?: readonly string[];
}

interface DesktopLocalAgentBackendRuntime {
  readonly backend: DesktopLocalAgentBackend;
  readonly command: string;
  readonly executablePath: string;
  readonly runtimePath: string;
  readonly version?: string;
}

function backendCommand(backend: DesktopLocalAgentBackend): {
  readonly backend: DesktopLocalAgentBackend;
  readonly command: string;
  readonly label: string;
} {
  const match = BACKEND_COMMANDS.find((candidate) => {
    return candidate.backend === backend;
  });
  if (!match) {
    throw new Error(`Unsupported local agent backend: ${backend}`);
  }
  return match;
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: Error): string | undefined {
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return typeof env.PATH === "string" ? env.PATH : "";
}

function splitPath(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((entry) => {
      return entry.trim();
    })
    .filter((entry) => {
      return entry.length > 0;
    });
}

function mergePathValues(values: readonly (string | undefined)[]): string {
  const entries = new Set<string>();
  for (const value of values) {
    for (const entry of splitPath(value)) {
      entries.add(entry);
    }
  }
  return [...entries].join(path.delimiter);
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value === "~") {
    return typeof env.HOME === "string" ? env.HOME : undefined;
  }
  if (value.startsWith("~/")) {
    return typeof env.HOME === "string"
      ? path.join(env.HOME, value.slice(2))
      : undefined;
  }
  return value;
}

function commonExecutableDirectories(
  env: NodeJS.ProcessEnv,
  directories: readonly string[] | undefined,
): string[] {
  return (directories ?? COMMON_EXECUTABLE_DIRECTORIES)
    .map((directory) => {
      return expandHome(directory, env);
    })
    .filter((directory): directory is string => {
      return typeof directory === "string" && directory.length > 0;
    });
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutableInPath(
  command: string,
  pathList: string,
): Promise<string | undefined> {
  for (const directory of splitPath(pathList)) {
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function findExecutableInDirectories(
  command: string,
  directories: readonly string[],
): Promise<string | undefined> {
  for (const directory of directories) {
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function loginShell(env: NodeJS.ProcessEnv): string | undefined {
  return typeof env.SHELL === "string" && env.SHELL.length > 0
    ? env.SHELL
    : undefined;
}

function shellProbeScript(command: string): string {
  return `resolved="$(command -v ${command} || true)"; printf '%s\\n%s\\n' "$resolved" "$PATH"`;
}

function runCommand(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly runtimePath?: string;
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
}): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const child = spawn(params.command, [...params.args], {
      env: {
        ...params.env,
        ...(params.runtimePath ? { PATH: params.runtimePath } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const finish = (result: CommandOutput): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        exitCode: 1,
        output,
        error: params.timeoutMessage,
      });
    }, params.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      output = appendLimited(output, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = appendLimited(output, chunk);
    });
    child.on("error", (error: Error) => {
      finish({
        exitCode: 1,
        output,
        error: error.message,
      });
    });
    child.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        output,
      });
    });
  });
}

async function resolveFromLoginShell(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly executablePath?: string;
  readonly runtimePath?: string;
}> {
  const shell = loginShell(env);
  if (!shell) {
    return {};
  }

  const result = await runCommand({
    command: shell,
    args: ["-lc", shellProbeScript(command)],
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    timeoutMessage: "Login shell lookup timed out",
  });
  if (result.exitCode !== 0) {
    return {};
  }

  const lines = result.output.replace(/\r\n/g, "\n").split("\n");
  const executablePath = lines[0]?.trim();
  const runtimePath = lines[1]?.trim();
  return {
    ...(executablePath &&
    path.isAbsolute(executablePath) &&
    (await isExecutable(executablePath))
      ? { executablePath }
      : {}),
    ...(runtimePath ? { runtimePath } : {}),
  };
}

async function resolveLocalAgentBackend(
  backend: DesktopLocalAgentBackend,
  options: ResolveOptions = {},
): Promise<DesktopLocalAgentBackendRuntime> {
  const env = options.env ?? process.env;
  const definition = backendCommand(backend);
  const processPath = pathValue(env);
  const shellResolution = await resolveFromLoginShell(definition.command, env);
  const commonDirectories = commonExecutableDirectories(
    env,
    options.commonExecutableDirectories,
  );
  const executablePath =
    (await findExecutableInPath(definition.command, processPath)) ??
    shellResolution.executablePath ??
    (await findExecutableInDirectories(definition.command, commonDirectories));
  if (!executablePath) {
    throw new Error(`${definition.label} not found`);
  }

  const runtimePath = mergePathValues([
    path.dirname(executablePath),
    shellResolution.runtimePath,
    processPath,
    commonDirectories.join(path.delimiter),
  ]);
  const versionResult = await runCommand({
    command: executablePath,
    args: ["--version"],
    env,
    runtimePath,
    timeoutMs: PROBE_TIMEOUT_MS,
    timeoutMessage: `${definition.label} version check timed out`,
  });
  if (versionResult.exitCode !== 0) {
    throw new Error(
      firstLine(versionResult.output) ??
        versionResult.error ??
        `${definition.label} version check failed`,
    );
  }

  return {
    backend,
    command: definition.command,
    executablePath,
    runtimePath,
    version: firstLine(versionResult.output),
  };
}

async function assertBackendAuthenticated(
  runtime: DesktopLocalAgentBackendRuntime,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (runtime.backend !== "codex") {
    return;
  }

  const result = await runCommand({
    command: runtime.executablePath,
    args: ["login", "status"],
    env,
    runtimePath: runtime.runtimePath,
    timeoutMs: PROBE_TIMEOUT_MS,
    timeoutMessage: "Codex login status timed out",
  });
  if (result.exitCode !== 0) {
    throw new Error("Codex not logged in");
  }
}

export async function preflightLocalAgentBackend(
  backend: DesktopLocalAgentBackend,
  options: ResolveOptions = {},
): Promise<DesktopLocalAgentBackendRuntime> {
  const env = options.env ?? process.env;
  const runtime = await resolveLocalAgentBackend(backend, options);
  await assertBackendAuthenticated(runtime, env);
  return runtime;
}

async function probeBackend(
  backend: DesktopLocalAgentBackend,
  options: ResolveOptions,
): Promise<DesktopLocalAgentBackendProbe> {
  const definition = backendCommand(backend);
  try {
    const runtime = await resolveLocalAgentBackend(backend, options);
    return {
      backend,
      command: definition.command,
      available: true,
      executablePath: runtime.executablePath,
      version: runtime.version,
    };
  } catch (error) {
    return {
      backend,
      command: definition.command,
      available: false,
      errorMessage: errorMessage(error),
    };
  }
}

export function detectLocalAgentBackends(
  options: ResolveOptions = {},
): Promise<DesktopLocalAgentBackendProbe[]> {
  return Promise.all(
    BACKEND_COMMANDS.map(({ backend }) => {
      return probeBackend(backend, options);
    }),
  );
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

function executionArgs(params: {
  readonly backend: DesktopLocalAgentBackend;
  readonly prompt: string;
  readonly permissionMode: DesktopLocalAgentPermissionMode;
}): readonly string[] {
  if (params.backend === "claude-code") {
    return [
      "-p",
      ...claudePermissionArgs(params.permissionMode),
      params.prompt,
    ];
  }
  return ["exec", ...codexPermissionArgs(params.permissionMode), params.prompt];
}

async function runtimeForExecution(params: {
  readonly backend: DesktopLocalAgentBackend;
  readonly executablePath?: string;
  readonly runtimePath?: string;
}): Promise<DesktopLocalAgentBackendRuntime> {
  const definition = backendCommand(params.backend);
  if (params.executablePath) {
    return {
      backend: params.backend,
      command: definition.command,
      executablePath: params.executablePath,
      runtimePath:
        params.runtimePath ??
        mergePathValues([
          path.dirname(params.executablePath),
          pathValue(process.env),
        ]),
    };
  }
  return preflightLocalAgentBackend(params.backend);
}

export async function executeLocalAgentBackend(params: {
  readonly backend: DesktopLocalAgentBackend;
  readonly prompt: string;
  readonly workdir: string;
  readonly permissionMode: DesktopLocalAgentPermissionMode;
  readonly executablePath?: string;
  readonly runtimePath?: string;
  readonly signal?: AbortSignal;
}): Promise<DesktopLocalAgentExecutionResult> {
  let runtime: DesktopLocalAgentBackendRuntime;
  try {
    runtime = await runtimeForExecution({
      backend: params.backend,
      executablePath: params.executablePath,
      runtimePath: params.runtimePath,
    });
  } catch (error) {
    return {
      output: "",
      error: errorMessage(error),
      exitCode: 1,
      backendHealthy: false,
    };
  }

  const args = executionArgs({
    backend: params.backend,
    prompt: params.prompt,
    permissionMode: params.permissionMode,
  });

  return new Promise((resolve) => {
    const child = spawn(runtime.executablePath, [...args], {
      cwd: params.workdir,
      env: {
        ...process.env,
        PATH: runtime.runtimePath,
      },
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
    child.on("error", (error: Error) => {
      const code = errorCode(error);
      finish({
        output: stdout,
        error: error.message,
        exitCode: 1,
        backendHealthy:
          code === "ENOENT" || code === "EACCES" ? false : undefined,
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
