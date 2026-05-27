#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComputerUseSnapshotStore,
  SUPPORTED_COMPUTER_USE_CAPABILITIES,
  executeComputerUseCommand,
  type ComputerUseCommandKind,
} from "./computer-use-accessibility";
import { createComputerUseNativeBackend } from "./computer-use-native";

type JsonObject = Record<string, unknown>;

interface RuntimeCommand {
  readonly kind: string;
  readonly payload?: JsonObject;
}

interface RuntimeResponse {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, string>;
}

interface ParsedRuntimeCommands {
  readonly commands: readonly RuntimeCommand[];
  readonly outputArray: boolean;
}

interface DaemonPaths {
  readonly dir: string;
  readonly socketPath: string;
  readonly pidPath: string;
}

interface DaemonCommandRequest {
  readonly type: "commands";
  readonly commands: readonly RuntimeCommand[];
  readonly outputArray: boolean;
}

interface DaemonStatusRequest {
  readonly type: "status";
}

interface DaemonStopRequest {
  readonly type: "stop";
}

type DaemonRequest =
  | DaemonCommandRequest
  | DaemonStatusRequest
  | DaemonStopRequest;

interface DaemonStatusResult {
  readonly pid: number;
  readonly helperPath: string;
  readonly socketPath: string;
}

interface DaemonOkResponse {
  readonly status: "ok";
  readonly result?: unknown;
}

interface DaemonErrorResponse {
  readonly status: "error";
  readonly message: string;
}

type DaemonResponse = DaemonOkResponse | DaemonErrorResponse;

const appRoot = path.resolve(__dirname, "..");
const defaultHelperPath = path.join(
  appRoot,
  "native",
  "dist",
  "native",
  "computer-use-helper",
);
const helperCandidates = [
  process.env.VM0_COMPUTER_HELPER_PATH,
  defaultHelperPath,
  path.join(
    appRoot,
    "native",
    "computer-use-helper",
    ".build",
    "release",
    "computer-use-helper",
  ),
].filter((candidate): candidate is string => Boolean(candidate));

const zeroCommands = new Map<string, string>([
  ["list-apps", "apps.list"],
  ["get-app-state", "app.state"],
  ["open-app", "app.open"],
  ["click", "element.click"],
  ["scroll", "element.scroll"],
  ["set-value", "element.set_value"],
  ["perform-action", "element.perform_action"],
  ["type-text", "keyboard.type_text"],
  ["press-key", "keyboard.press_key"],
]);

function usage(): string {
  return `Usage:
  vm0-computer daemon start [--helper-path PATH] [--daemon-dir DIR]
  vm0-computer daemon stop [--daemon-dir DIR]
  vm0-computer daemon status [--daemon-dir DIR]
  vm0-computer run JSON [--daemon-dir DIR]
  vm0-computer list-apps [--daemon-dir DIR]
  vm0-computer get-app-state --app APP [--daemon-dir DIR]
  vm0-computer open-app --app APP [--daemon-dir DIR]
  vm0-computer click --app APP (--element-index N | --element ID | --x X --y Y) [--snapshot-id ID] [--button left|right|middle] [--click-count N] [--daemon-dir DIR]
  vm0-computer scroll --app APP (--element-index N | --element ID) --direction up|down|left|right [--snapshot-id ID] [--pages N] [--daemon-dir DIR]
  vm0-computer set-value --app APP (--element-index N | --element ID) --value VALUE [--daemon-dir DIR]
  vm0-computer perform-action --app APP (--element-index N | --element ID) --action ACTION [--daemon-dir DIR]
  vm0-computer type-text --app APP --text TEXT [--daemon-dir DIR]
  vm0-computer press-key --app APP --key KEY [--daemon-dir DIR]`;
}

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  return (
    isJsonObject(value) &&
    typeof value.kind === "string" &&
    (value.payload === undefined || isJsonObject(value.payload))
  );
}

function parseRuntimeCommands(raw: string): ParsedRuntimeCommands {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    if (parsed.every(isRuntimeCommand)) {
      return { commands: parsed, outputArray: true };
    }
    fail("vm0-computer run requires every array item to be a runtime command");
  }
  if (isRuntimeCommand(parsed)) {
    return { commands: [parsed], outputArray: false };
  }
  fail("vm0-computer run requires a runtime command or command array");
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const inlineValueIndex = arg.indexOf("=");
    if (inlineValueIndex !== -1) {
      values.set(
        arg.slice(2, inlineValueIndex),
        arg.slice(inlineValueIndex + 1),
      );
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return { positional, values };
}

function helperPathFrom(values: ReadonlyMap<string, string>): string {
  const explicit = values.get("helper-path");
  if (explicit) {
    return explicit;
  }
  const helperPath = helperCandidates.find((candidate) =>
    existsSync(candidate),
  );
  return helperPath ?? defaultHelperPath;
}

function defaultDaemonDir(): string {
  const userId =
    typeof process.getuid === "function" ? process.getuid().toString() : "user";
  const appRootHash = createHash("sha256").update(appRoot).digest("hex");
  return path.join(tmpdir(), `vm0-computer-${userId}-${appRootHash.slice(0, 12)}`);
}

function daemonPaths(values: ReadonlyMap<string, string>): DaemonPaths {
  const dir =
    stringValue(values, "daemon-dir") ??
    process.env.VM0_COMPUTER_DAEMON_DIR ??
    defaultDaemonDir();
  return {
    dir,
    socketPath: path.join(dir, "daemon.sock"),
    pidPath: path.join(dir, "daemon.pid"),
  };
}

function stringValue(
  values: ReadonlyMap<string, string>,
  key: string,
): string | undefined {
  const value = values.get(key);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(
  values: ReadonlyMap<string, string>,
  key: string,
): number | undefined {
  const value = stringValue(values, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`Invalid numeric value for --${key}: ${value}`);
  }
  return parsed;
}

function commandFromArgs(
  kind: string,
  values: ReadonlyMap<string, string>,
): RuntimeCommand {
  const payload: JsonObject = {};
  const app = stringValue(values, "app");
  const snapshotId = stringValue(values, "snapshot-id");
  const elementId =
    stringValue(values, "element-id") ?? stringValue(values, "element");
  const elementIndex = numberValue(values, "element-index");
  const x = numberValue(values, "x");
  const y = numberValue(values, "y");
  const pages = numberValue(values, "pages");
  const clickCount = numberValue(values, "click-count");
  if (app) payload.app = app;
  if (snapshotId) payload.snapshotId = snapshotId;
  if (elementId) payload.elementId = elementId;
  if (elementIndex !== undefined) payload.elementIndex = elementIndex;
  if (x !== undefined) payload.x = x;
  if (y !== undefined) payload.y = y;
  if (pages !== undefined) payload.pages = pages;
  if (clickCount !== undefined) payload.clickCount = clickCount;

  const optionMappings: readonly (readonly [string, string])[] = [
    ["button", "button"],
    ["direction", "direction"],
    ["value", "value"],
    ["text", "text"],
    ["key", "key"],
    ["action", "action"],
  ];
  for (const [option, field] of optionMappings) {
    const value = stringValue(values, option);
    if (value) payload[field] = value;
  }
  return { kind, payload };
}

function isComputerUseCommandKind(
  kind: string,
): kind is ComputerUseCommandKind {
  return SUPPORTED_COMPUTER_USE_CAPABILITIES.includes(
    kind as ComputerUseCommandKind,
  );
}

function assertComputerUseCommandKind(kind: string): ComputerUseCommandKind {
  if (isComputerUseCommandKind(kind)) {
    return kind;
  }
  fail(`Unsupported vm0-computer command kind: ${kind}\n\n${usage()}`);
}

function assertDaemonRequest(value: unknown): DaemonRequest {
  if (!isJsonObject(value) || typeof value.type !== "string") {
    throw new Error("Invalid vm0-computer daemon request");
  }
  if (value.type === "status" || value.type === "stop") {
    return { type: value.type };
  }
  if (
    value.type === "commands" &&
    Array.isArray(value.commands) &&
    value.commands.every(isRuntimeCommand) &&
    typeof value.outputArray === "boolean"
  ) {
    return {
      type: "commands",
      commands: value.commands,
      outputArray: value.outputArray,
    };
  }
  throw new Error("Invalid vm0-computer daemon command request");
}

function daemonUnavailableMessage(socketPath: string): string {
  return `vm0-computer daemon is not running at ${socketPath}. Start it first with: vm0-computer daemon start`;
}

function isConnectionUnavailable(error: unknown): boolean {
  return (
    isJsonObject(error) &&
    typeof error.code === "string" &&
    ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)
  );
}

function runtimeResponse(
  id: string,
  result: Awaited<ReturnType<typeof executeComputerUseCommand>>,
): RuntimeResponse {
  return { id, ...result };
}

async function executeRuntimeCommands(
  nativeBackend: ReturnType<typeof createComputerUseNativeBackend>,
  snapshotStore: ComputerUseSnapshotStore,
  commands: readonly RuntimeCommand[],
): Promise<RuntimeResponse[]> {
  const permissions = await nativeBackend.getPermissions();
  const responses: RuntimeResponse[] = [];
  let counter = 0;
  for (const command of commands) {
    const id = `cli_${(counter += 1).toString()}`;
    const kind = assertComputerUseCommandKind(command.kind);
    const result = await executeComputerUseCommand(
      { id, kind, payload: command.payload ?? {} },
      permissions,
      {
        nativeBackend,
        platform: process.platform,
        snapshotStore,
      },
    );
    responses.push(runtimeResponse(id, result));
  }
  return responses;
}

async function sendDaemonRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs = 30_000,
): Promise<DaemonResponse> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const settle = (value: DaemonResponse | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (value instanceof Error) {
        reject(value);
        return;
      }
      resolve(value);
    };
    timer = setTimeout(() => {
      settle(new Error("Timed out waiting for vm0-computer daemon"));
      socket.destroy();
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      settle(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      try {
        const parsed = JSON.parse(buffer.slice(0, newlineIndex)) as unknown;
        if (
          !isJsonObject(parsed) ||
          (parsed.status !== "ok" && parsed.status !== "error")
        ) {
          throw new Error("Invalid vm0-computer daemon response");
        }
        if (parsed.status === "error") {
          settle({
            status: "error",
            message:
              typeof parsed.message === "string"
                ? parsed.message
                : "vm0-computer daemon request failed",
          });
          return;
        }
        settle({ status: "ok", result: parsed.result });
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      } finally {
        socket.destroy();
      }
    });
  });
}

async function runCommandsThroughDaemon(
  paths: DaemonPaths,
  commands: readonly RuntimeCommand[],
  outputArray: boolean,
): Promise<void> {
  try {
    const response = await sendDaemonRequest(paths.socketPath, {
      type: "commands",
      commands,
      outputArray,
    });
    if (response.status === "error") {
      fail(response.message);
    }
    process.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  } catch (error) {
    if (isConnectionUnavailable(error)) {
      fail(daemonUnavailableMessage(paths.socketPath));
    }
    throw error;
  }
}

async function daemonStatus(paths: DaemonPaths): Promise<DaemonStatusResult> {
  const response = await sendDaemonRequest(paths.socketPath, { type: "status" });
  if (response.status === "error") {
    throw new Error(response.message);
  }
  const result = response.result;
  if (
    !isJsonObject(result) ||
    typeof result.pid !== "number" ||
    typeof result.helperPath !== "string" ||
    typeof result.socketPath !== "string"
  ) {
    throw new Error("Invalid vm0-computer daemon status response");
  }
  return {
    pid: result.pid,
    helperPath: result.helperPath,
    socketPath: result.socketPath,
  };
}

async function waitForDaemon(paths: DaemonPaths): Promise<DaemonStatusResult> {
  const deadline = Date.now() + 3_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await daemonStatus(paths);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for vm0-computer daemon");
}

async function startDaemon(
  paths: DaemonPaths,
  helperPath: string,
): Promise<void> {
  try {
    const status = await daemonStatus(paths);
    process.stdout.write(
      `vm0-computer daemon already running (pid ${status.pid})\n`,
    );
    return;
  } catch (error) {
    if (!isConnectionUnavailable(error)) {
      await rm(paths.socketPath, { force: true });
    }
  }

  await mkdir(paths.dir, { recursive: true });
  await rm(paths.socketPath, { force: true });
  const child = spawn(
    process.execPath,
    [
      path.join(appRoot, "dist", "vm0-computer.js"),
      "daemon",
      "serve",
      "--helper-path",
      helperPath,
      "--daemon-dir",
      paths.dir,
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();

  const status = await waitForDaemon(paths);
  process.stdout.write(`vm0-computer daemon started (pid ${status.pid})\n`);
}

async function stopDaemon(paths: DaemonPaths): Promise<void> {
  try {
    const response = await sendDaemonRequest(paths.socketPath, { type: "stop" });
    if (response.status === "error") {
      fail(response.message);
    }
    process.stdout.write("vm0-computer daemon stopped\n");
  } catch (error) {
    if (isConnectionUnavailable(error)) {
      fail(daemonUnavailableMessage(paths.socketPath));
    }
    throw error;
  }
}

async function printDaemonStatus(paths: DaemonPaths): Promise<void> {
  try {
    const status = await daemonStatus(paths);
    process.stdout.write(
      JSON.stringify(
        {
          running: true,
          pid: status.pid,
          helperPath: status.helperPath,
          socketPath: status.socketPath,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    if (isConnectionUnavailable(error)) {
      process.stdout.write(
        JSON.stringify(
          {
            running: false,
            socketPath: paths.socketPath,
          },
          null,
          2,
        ) + "\n",
      );
      process.exit(1);
    }
    throw error;
  }
}

function writeDaemonResponse(socket: Socket, response: DaemonResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function serveDaemon(paths: DaemonPaths, helperPath: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await rm(paths.socketPath, { force: true });
  const nativeBackend = createComputerUseNativeBackend({ helperPath });
  const snapshotStore = new ComputerUseSnapshotStore();
  let commandQueue = Promise.resolve();

  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      commandQueue = commandQueue
        .then(async () => {
          const parsed = JSON.parse(line) as unknown;
          const request = assertDaemonRequest(parsed);
          if (request.type === "status") {
            writeDaemonResponse(socket, {
              status: "ok",
              result: {
                pid: process.pid,
                helperPath,
                socketPath: paths.socketPath,
              },
            });
            return;
          }
          if (request.type === "stop") {
            writeDaemonResponse(socket, { status: "ok" });
            await shutdownDaemon(server, nativeBackend, paths);
            return;
          }
          const responses = await executeRuntimeCommands(
            nativeBackend,
            snapshotStore,
            request.commands,
          );
          writeDaemonResponse(socket, {
            status: "ok",
            result: request.outputArray ? responses : responses[0],
          });
        })
        .catch((error: unknown) => {
          writeDaemonResponse(socket, {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      reject(error);
    });
    server.listen(paths.socketPath, () => {
      resolve();
    });
  });
  await writeFile(paths.pidPath, `${process.pid}\n`);

  const shutdown = (): void => {
    void shutdownDaemon(server, nativeBackend, paths);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function shutdownDaemon(
  server: ReturnType<typeof createServer>,
  nativeBackend: ReturnType<typeof createComputerUseNativeBackend>,
  paths: DaemonPaths,
): Promise<void> {
  nativeBackend.dispose();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(paths.socketPath, { force: true });
  await rm(paths.pidPath, { force: true });
  process.exit(0);
}

async function main(): Promise<void> {
  const { positional, values } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }

  const paths = daemonPaths(values);
  if (command === "daemon") {
    const daemonCommand = positional[1];
    if (daemonCommand === "start") {
      await startDaemon(paths, helperPathFrom(values));
      return;
    }
    if (daemonCommand === "stop") {
      await stopDaemon(paths);
      return;
    }
    if (daemonCommand === "status") {
      await printDaemonStatus(paths);
      return;
    }
    if (daemonCommand === "serve") {
      await serveDaemon(paths, helperPathFrom(values));
      return;
    }
    fail(`Unknown vm0-computer daemon command: ${daemonCommand ?? ""}\n\n${usage()}`);
  }

  if (command === "run") {
    const raw = positional[1];
    if (!raw) {
      fail("vm0-computer run requires a JSON command or command array");
    }
    const { commands, outputArray } = parseRuntimeCommands(raw);
    await runCommandsThroughDaemon(paths, commands, outputArray);
    return;
  }
  const mappedKind = zeroCommands.get(command);
  if (mappedKind) {
    await runCommandsThroughDaemon(
      paths,
      [commandFromArgs(mappedKind, values)],
      false,
    );
    return;
  }
  fail(`Unknown vm0-computer command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
