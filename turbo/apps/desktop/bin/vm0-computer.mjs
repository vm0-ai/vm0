#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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
].filter(Boolean);

const zeroCommands = new Map([
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

function usage() {
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

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const values = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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

function helperPathFrom(values) {
  const explicit = values.get("helper-path");
  if (explicit) {
    return explicit;
  }
  const helperPath = helperCandidates.find((candidate) =>
    existsSync(candidate),
  );
  return helperPath ?? defaultHelperPath;
}

function stringValue(values, key) {
  const value = values.get(key);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(values, key) {
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

function commandFromArgs(kind, values) {
  const payload = {};
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

  for (const [option, field] of [
    ["button", "button"],
    ["direction", "direction"],
    ["value", "value"],
    ["text", "text"],
    ["key", "key"],
    ["action", "action"],
  ]) {
    const value = stringValue(values, option);
    if (value) payload[field] = value;
  }
  return { kind, payload };
}

class RuntimeClient {
  constructor(helperPath) {
    this.child = spawn(helperPath, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = "";
    this.counter = 0;
    this.pending = new Map();
    this.stderr = "";

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
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

  send(command) {
    const id = `cli_${(this.counter += 1).toString()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ id, ...command })}\n`,
        (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }

  close() {
    this.child.stdin.end();
  }

  handleStdout(chunk) {
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

  handleLine(line) {
    const response = JSON.parse(line);
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    pending.resolve(response);
  }
}

async function runServe(helperPath) {
  const child = spawn(helperPath, ["serve"], { stdio: "inherit" });
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  process.exit(typeof code === "number" ? code : 1);
}

async function runCommands(helperPath, commands, outputArray) {
  const client = new RuntimeClient(helperPath);
  try {
    const responses = [];
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

const { positional, values } = parseArgs(process.argv.slice(2));
const command = positional[0];
if (!command || command === "--help" || command === "help") {
  console.log(usage());
  process.exit(command ? 0 : 1);
}

const helperPath = helperPathFrom(values);
if (command === "serve") {
  await runServe(helperPath);
} else if (command === "run") {
  const raw = positional[1];
  if (!raw) {
    fail("vm0-computer run requires a JSON command or command array");
  }
  const parsed = JSON.parse(raw);
  const commands = Array.isArray(parsed) ? parsed : [parsed];
  await runCommands(helperPath, commands, Array.isArray(parsed));
} else if (zeroCommands.has(command)) {
  await runCommands(
    helperPath,
    [commandFromArgs(zeroCommands.get(command), values)],
    false,
  );
} else {
  fail(`Unknown vm0-computer command: ${command}\n\n${usage()}`);
}
