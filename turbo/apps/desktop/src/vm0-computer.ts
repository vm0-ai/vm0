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

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, string>;
}

interface DaemonPaths {
  readonly dir: string;
  readonly socketPath: string;
  readonly pidPath: string;
}

interface DaemonCommandRequest {
  readonly type: "command";
  readonly command: RuntimeCommand;
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

const COMPUTER_USE_OUTPUT_DIR = "/tmp/vm0/computer-use";
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

function usage(): string {
  return `Usage:
  vm0-computer daemon start [--helper-path PATH] [--daemon-dir DIR]
  vm0-computer daemon stop [--daemon-dir DIR]
  vm0-computer daemon status [--daemon-dir DIR]
  vm0-computer list-apps [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer get-app-state --app BUNDLE_ID [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer open-app --app BUNDLE_ID [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer click --app BUNDLE_ID (--element-index N | --element ID | --x X --y Y) [--snapshot-id ID] [--button left|right|middle] [--click-count N] [--foreground-recovery never|on-window-unavailable|always] [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer scroll --app BUNDLE_ID (--element-index N | --element ID) --direction up|down|left|right [--snapshot-id ID] [--pages N] [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer set-value --app BUNDLE_ID (--element-index N | --element ID) --value VALUE [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer perform-action --app BUNDLE_ID (--element-index N | --element ID) --action ACTION [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer type-text --app BUNDLE_ID --text TEXT [--snapshot-id ID] [--foreground-recovery never|on-window-unavailable|always] [--timeout SECONDS] [--daemon-dir DIR]
  vm0-computer press-key --app BUNDLE_ID --key KEY [--snapshot-id ID] [--foreground-recovery never|on-window-unavailable|always] [--timeout SECONDS] [--daemon-dir DIR]

  BUNDLE_ID is an app bundle id (e.g. com.google.Chrome); run list-apps to find it.
  Apps listed without a bundleId cannot be targeted.`;
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
  return path.join(
    tmpdir(),
    `vm0-computer-${userId}-${appRootHash.slice(0, 12)}`,
  );
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

function parseTimeoutSeconds(value: string | undefined): number {
  if (!value) return 30;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    fail("Timeout must be a positive number of seconds");
  }
  return seconds;
}

function parseOptionalNonNegativeInteger(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number {
  if (value === undefined) {
    fail(`${label} is required`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined, label: string): number {
  if (value === undefined) {
    fail(`${label} is required`);
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${label} must be a positive number`);
  }
  return parsed;
}

function parseMouseButton(
  value: string | undefined,
): "left" | "right" | "middle" {
  if (value === "left" || value === "right" || value === "middle") {
    return value;
  }
  fail("button must be left, right, or middle");
}

function parseForegroundRecovery(
  value: string | undefined,
): "never" | "on-window-unavailable" | "always" | undefined {
  if (value === undefined) return undefined;
  if (
    value === "never" ||
    value === "on-window-unavailable" ||
    value === "always"
  ) {
    return value;
  }
  fail("foreground-recovery must be never, on-window-unavailable, or always");
}

function requiredStringValue(
  values: ReadonlyMap<string, string>,
  key: string,
): string {
  const value = stringValue(values, key);
  if (!value) {
    fail(`${key} is required`);
  }
  return value;
}

function elementTargetPayload(values: ReadonlyMap<string, string>): JsonObject {
  const elementId = stringValue(values, "element");
  const elementIndex = parseOptionalNonNegativeInteger(
    stringValue(values, "element-index"),
    "element-index",
  );
  if (!elementId && elementIndex === undefined) {
    fail("element or element-index is required");
  }
  return {
    ...(elementId ? { elementId } : {}),
    ...(elementIndex !== undefined ? { elementIndex } : {}),
  };
}

function commandFromArgs(
  kind: string,
  values: ReadonlyMap<string, string>,
): RuntimeCommand {
  const payload: JsonObject = {};
  const app =
    kind === "apps.list" ? undefined : requiredStringValue(values, "app");
  const snapshotId = stringValue(values, "snapshot-id");
  const foregroundRecovery = parseForegroundRecovery(
    stringValue(values, "foreground-recovery"),
  );
  if (app) payload.app = app;
  if (snapshotId) payload.snapshotId = snapshotId;

  if (kind === "element.click") {
    const elementId = stringValue(values, "element");
    const elementIndex = parseOptionalNonNegativeInteger(
      stringValue(values, "element-index"),
      "element-index",
    );
    const x = parseOptionalNonNegativeInteger(stringValue(values, "x"), "x");
    const y = parseOptionalNonNegativeInteger(stringValue(values, "y"), "y");
    if (elementId) payload.elementId = elementId;
    if (elementIndex !== undefined) payload.elementIndex = elementIndex;
    if (x !== undefined) payload.x = x;
    if (y !== undefined) payload.y = y;
    payload.button = parseMouseButton(stringValue(values, "button") ?? "left");
    payload.clickCount = parsePositiveInteger(
      stringValue(values, "click-count") ?? "1",
      "click-count",
    );
    if (foregroundRecovery) payload.foregroundRecovery = foregroundRecovery;
  } else if (kind === "element.scroll") {
    Object.assign(payload, elementTargetPayload(values));
    payload.direction = requiredStringValue(values, "direction");
    payload.pages = parsePositiveNumber(
      stringValue(values, "pages") ?? "1",
      "pages",
    );
  } else if (kind === "element.set_value") {
    Object.assign(payload, elementTargetPayload(values));
    payload.value = requiredStringValue(values, "value");
  } else if (kind === "element.perform_action") {
    Object.assign(payload, elementTargetPayload(values));
    payload.action = requiredStringValue(values, "action");
  } else if (kind === "keyboard.type_text") {
    payload.text = requiredStringValue(values, "text");
    if (foregroundRecovery) payload.foregroundRecovery = foregroundRecovery;
  } else if (kind === "keyboard.press_key") {
    payload.key = requiredStringValue(values, "key");
    if (foregroundRecovery) payload.foregroundRecovery = foregroundRecovery;
  }
  return { kind, payload };
}

function sanitizeFilenamePart(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : fallback;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  const suffix = mimeType.startsWith("image/") ? mimeType.slice(6) : "bin";
  return sanitizeFilenamePart(suffix, "bin").toLowerCase();
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

async function writeScreenshotDataUrl(
  result: Record<string, unknown>,
  dataUrl: string,
): Promise<string | null> {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    return null;
  }

  const mimeType = match[1] ?? "";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported screenshot MIME type: ${mimeType}`);
  }

  const base64Data = match[2] ?? "";
  const appName = sanitizeFilenamePart(result.app, "app");
  const snapshotId = sanitizeFilenamePart(result.snapshotId, "snapshot");
  const outputPath = path.join(
    COMPUTER_USE_OUTPUT_DIR,
    `${appName}-${snapshotId}.${extensionForMimeType(mimeType)}`,
  );

  await mkdir(COMPUTER_USE_OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, Buffer.from(base64Data, "base64"));
  return outputPath;
}

async function writeAppStateText(
  result: Record<string, unknown>,
  appState: string,
): Promise<string> {
  const appName = sanitizeFilenamePart(result.app, "app");
  const snapshotId = sanitizeFilenamePart(result.snapshotId, "snapshot");
  const outputPath = path.join(
    COMPUTER_USE_OUTPUT_DIR,
    `${appName}-${snapshotId}.appState.txt`,
  );

  await mkdir(COMPUTER_USE_OUTPUT_DIR, { recursive: true });
  await writeFile(outputPath, appState, "utf8");
  return outputPath;
}

function compactActionResult(
  action: Record<string, unknown>,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      compact[key] = value;
    } else if (key === "foregroundRecovery" && isJsonObject(value)) {
      compact[key] = value;
    }
  }
  return compact;
}

async function formatComputerUseResultForConsole(
  result: Record<string, unknown>,
): Promise<string> {
  const printable: Record<string, unknown> = { status: "succeeded" };
  const apps = result.apps;
  if (Array.isArray(apps)) {
    printable.apps = apps;
  }
  const snapshotId = stringField(result, "snapshotId");
  if (snapshotId) {
    printable.snapshotId = snapshotId;
  }
  const appState = stringField(result, "appState");
  if (appState) {
    printable.appState = await writeAppStateText(result, appState);
  }
  const screenshot = stringField(result, "screenshot");
  if (screenshot) {
    const screenshotPath = await writeScreenshotDataUrl(result, screenshot);
    printable.screenshot = screenshotPath ?? screenshot;
  }
  const action = result.action;
  if (isJsonObject(action)) {
    printable.action = compactActionResult(action);
  }
  return JSON.stringify(printable, null, 2);
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
  if (value.type === "command" && isRuntimeCommand(value.command)) {
    return {
      type: "command",
      command: value.command,
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

async function executeRuntimeCommand(
  nativeBackend: ReturnType<typeof createComputerUseNativeBackend>,
  snapshotStore: ComputerUseSnapshotStore,
  command: RuntimeCommand,
): Promise<Awaited<ReturnType<typeof executeComputerUseCommand>>> {
  const permissions = await nativeBackend.getPermissions();
  const kind = assertComputerUseCommandKind(command.kind);
  return await executeComputerUseCommand(
    {
      id: "cli_1",
      kind,
      payload: command.payload ?? {},
    },
    permissions,
    {
      nativeBackend,
      platform: process.platform,
      snapshotStore,
    },
  );
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

async function runCommandThroughDaemon(
  paths: DaemonPaths,
  command: RuntimeCommand,
  timeoutMs: number,
): Promise<void> {
  try {
    const response = await sendDaemonRequest(
      paths.socketPath,
      {
        type: "command",
        command,
      },
      timeoutMs,
    );
    if (response.status === "error") {
      fail(response.message);
    }
    const result = response.result;
    if (
      !isJsonObject(result) ||
      (result.status !== "succeeded" && result.status !== "failed")
    ) {
      fail("Invalid vm0-computer daemon command response");
    }
    if (result.status === "failed") {
      const error = result.error;
      if (
        isJsonObject(error) &&
        typeof error.code === "string" &&
        typeof error.message === "string"
      ) {
        fail(`${error.code}: ${error.message}`);
      }
      fail("Computer-use command failed");
    }
    const commandResult = result.result;
    if (!isJsonObject(commandResult)) {
      return;
    }
    const text = await formatComputerUseResultForConsole(commandResult);
    process.stdout.write(`${text}\n`);
  } catch (error) {
    if (isConnectionUnavailable(error)) {
      fail(daemonUnavailableMessage(paths.socketPath));
    }
    throw error;
  }
}

async function daemonStatus(paths: DaemonPaths): Promise<DaemonStatusResult> {
  const response = await sendDaemonRequest(paths.socketPath, {
    type: "status",
  });
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
    const response = await sendDaemonRequest(paths.socketPath, {
      type: "stop",
    });
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

async function serveDaemon(
  paths: DaemonPaths,
  helperPath: string,
): Promise<void> {
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
          const result = await executeRuntimeCommand(
            nativeBackend,
            snapshotStore,
            request.command,
          );
          writeDaemonResponse(socket, {
            status: "ok",
            result,
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
    fail(
      `Unknown vm0-computer daemon command: ${daemonCommand ?? ""}\n\n${usage()}`,
    );
  }
  const mappedKind = zeroCommands.get(command);
  if (mappedKind) {
    const timeoutSeconds = parseTimeoutSeconds(stringValue(values, "timeout"));
    await runCommandThroughDaemon(
      paths,
      commandFromArgs(mappedKind, values),
      timeoutSeconds * 1000,
    );
    return;
  }
  fail(`Unknown vm0-computer command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
