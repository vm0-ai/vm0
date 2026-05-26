#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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

interface PendingResponse {
  readonly resolve: (response: RuntimeResponse) => void;
  readonly reject: (error: Error) => void;
}

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
  vm0-computer serve [--helper-path PATH]
  vm0-computer run JSON [--helper-path PATH]
  vm0-computer list-apps [--helper-path PATH]
  vm0-computer get-app-state --app APP [--helper-path PATH]
  vm0-computer open-app --app APP [--helper-path PATH]
  vm0-computer click --app APP (--element-index N | --element ID | --x X --y Y) [--snapshot-id ID] [--button left|right|middle] [--click-count N]
  vm0-computer scroll --app APP (--element-index N | --element ID) --direction up|down|left|right [--snapshot-id ID] [--pages N]
  vm0-computer set-value --app APP (--element-index N | --element ID) --value VALUE [--snapshot-id ID]
  vm0-computer perform-action --app APP (--element-index N | --element ID) --action ACTION [--snapshot-id ID]
  vm0-computer type-text --app APP --text TEXT
  vm0-computer press-key --app APP --key KEY`;
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

class RuntimeClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private counter = 0;
  private readonly pending = new Map<string, PendingResponse>();
  private stderr = "";

  constructor(helperPath: string) {
    this.child = spawn(helperPath, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.handleStdout(chunk);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("close", (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(
          new Error(
            this.stderr.trim() ||
              `computer-use-helper exited with status ${code ?? "null"}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  send(command: RuntimeCommand): Promise<RuntimeResponse> {
    const id = `cli_${(this.counter += 1).toString()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ id, ...command })}\n`,
        (error: Error | null | undefined) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }

  close(): void {
    this.child.stdin.end();
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const index = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    const response: unknown = JSON.parse(line);
    if (!isJsonObject(response) || typeof response.id !== "string") {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    pending.resolve(response);
  }
}

async function runServe(helperPath: string): Promise<void> {
  const child = spawn(helperPath, ["serve"], { stdio: "inherit" });
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  process.exit(typeof code === "number" ? code : 1);
}

async function runCommands(
  helperPath: string,
  commands: readonly RuntimeCommand[],
  outputArray: boolean,
): Promise<void> {
  const client = new RuntimeClient(helperPath);
  try {
    const responses: RuntimeResponse[] = [];
    for (const command of commands) {
      responses.push(await client.send(command));
    }
    process.stdout.write(
      `${JSON.stringify(outputArray ? responses : responses[0], null, 2)}\n`,
    );
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const { positional, values } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }

  const helperPath = helperPathFrom(values);
  if (command === "serve") {
    await runServe(helperPath);
    return;
  }
  if (command === "run") {
    const raw = positional[1];
    if (!raw) {
      fail("vm0-computer run requires a JSON command or command array");
    }
    const { commands, outputArray } = parseRuntimeCommands(raw);
    await runCommands(helperPath, commands, outputArray);
    return;
  }
  const mappedKind = zeroCommands.get(command);
  if (mappedKind) {
    await runCommands(helperPath, [commandFromArgs(mappedKind, values)], false);
    return;
  }
  fail(`Unknown vm0-computer command: ${command}\n\n${usage()}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
