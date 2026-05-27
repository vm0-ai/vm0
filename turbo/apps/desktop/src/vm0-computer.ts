#!/usr/bin/env node
import { existsSync } from "node:fs";
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

function runtimeResponse(
  id: string,
  result: Awaited<ReturnType<typeof executeComputerUseCommand>>,
): RuntimeResponse {
  return { id, ...result };
}

async function runCommands(
  helperPath: string,
  commands: readonly RuntimeCommand[],
  outputArray: boolean,
): Promise<void> {
  const nativeBackend = createComputerUseNativeBackend({ helperPath });
  const snapshotStore = new ComputerUseSnapshotStore();
  try {
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
    process.stdout.write(
      `${JSON.stringify(outputArray ? responses : responses[0], null, 2)}\n`,
    );
  } finally {
    nativeBackend.dispose();
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
