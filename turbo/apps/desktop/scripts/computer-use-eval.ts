#!/usr/bin/env tsx
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(desktopRoot, "dist", "vm0-computer.js");
const DEFAULT_SUITE = "html-basic";
const COMMAND_TIMEOUT_MS = 60_000;
const APP_STATE_RETRY_COUNT = 20;
const APP_STATE_RETRY_DELAY_MS = 500;

interface EvalOptions {
  readonly suite: string;
  readonly caseName?: string;
  readonly repeat: number;
  readonly app: string;
}

interface FixtureState {
  readonly resetVersion: number;
  readonly clicked: boolean;
  readonly actionPressed: boolean;
  readonly switchChecked: boolean;
  readonly setValueText: string;
  readonly typeText: string;
  readonly lastKey: string | null;
  readonly scrollTop: number;
  readonly coordinateClicked: boolean;
  readonly coordinateClientX: number | null;
  readonly coordinateClientY: number | null;
}

interface FixtureServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly state: () => Promise<FixtureState>;
}

interface CommandOutput {
  readonly raw: string;
  readonly json: JsonObject;
}

interface AppStateOutput {
  readonly snapshotId: string;
  readonly appStatePath: string;
  readonly screenshotPath: string;
  readonly appStateText: string;
}

interface EvalCaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

interface EvalContext {
  readonly options: EvalOptions;
  readonly fixture: FixtureServer;
  readonly artifactsDir: string;
  readonly daemonDir: string;
  readonly browserProfileDir: string;
  readonly command: (
    caseName: string,
    args: readonly string[],
  ) => Promise<CommandOutput>;
  readonly getAppState: (caseName: string) => Promise<AppStateOutput>;
}

interface EvalCase {
  readonly name: string;
  readonly run: (context: EvalContext) => Promise<void>;
}

type JsonObject = Record<string, unknown>;

function emptyFixtureState(resetVersion: number): FixtureState {
  return {
    resetVersion,
    clicked: false,
    actionPressed: false,
    switchChecked: false,
    setValueText: "",
    typeText: "",
    lastKey: null,
    scrollTop: 0,
    coordinateClicked: false,
    coordinateClientX: null,
    coordinateClientY: null,
  };
}

function usage(): string {
  return `Usage: pnpm desktop:eval [-- --suite html-basic] [-- --case NAME] [-- --repeat N] [-- --app APP]

Runs the manual vm0-computer driver eval suite. The default suite launches a
local HTML fixture in Electron and verifies driver actions against an
independent fixture oracle.`;
}

function parseOptions(argv: readonly string[]): EvalOptions {
  let suite = DEFAULT_SUITE;
  let caseName: string | undefined;
  let repeat = 1;
  let app = process.env.VM0_COMPUTER_EVAL_APP ?? "Electron";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--suite") {
      suite = requiredNextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length);
      continue;
    }
    if (arg === "--case") {
      caseName = requiredNextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--case=")) {
      caseName = arg.slice("--case=".length);
      continue;
    }
    if (arg === "--repeat") {
      repeat = parsePositiveInteger(requiredNextValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--repeat=")) {
      repeat = parsePositiveInteger(arg.slice("--repeat=".length), "--repeat");
      continue;
    }
    if (arg === "--app") {
      app = requiredNextValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--app=")) {
      app = arg.slice("--app=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  if (suite !== DEFAULT_SUITE) {
    throw new Error(`Unknown suite: ${suite}`);
  }

  return { suite, caseName, repeat, app };
}

function requiredNextValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Expected ${key} in command output`);
  }
  return field;
}

function numberField(value: JsonObject, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Expected numeric ${key} in fixture state`);
  }
  return field;
}

function booleanField(value: JsonObject, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw new Error(`Expected boolean ${key} in fixture state`);
  }
  return field;
}

function nullableNumberField(value: JsonObject, key: string): number | null {
  const field = value[key];
  if (field === null) {
    return null;
  }
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Expected nullable numeric ${key} in fixture state`);
  }
  return field;
}

function fixtureStateFromJson(value: unknown): FixtureState {
  if (!isJsonObject(value)) {
    throw new Error("Fixture state must be an object");
  }
  const lastKey = value.lastKey;
  if (lastKey !== null && typeof lastKey !== "string") {
    throw new Error("Expected nullable string lastKey in fixture state");
  }
  const setValueText = value.setValueText;
  const typeText = value.typeText;
  if (typeof setValueText !== "string" || typeof typeText !== "string") {
    throw new Error("Expected text fields in fixture state");
  }
  return {
    resetVersion: numberField(value, "resetVersion"),
    clicked: booleanField(value, "clicked"),
    actionPressed: booleanField(value, "actionPressed"),
    switchChecked: booleanField(value, "switchChecked"),
    setValueText,
    typeText,
    lastKey,
    scrollTop: numberField(value, "scrollTop"),
    coordinateClicked: booleanField(value, "coordinateClicked"),
    coordinateClientX: nullableNumberField(value, "coordinateClientX"),
    coordinateClientY: nullableNumberField(value, "coordinateClientY"),
  };
}

function mergeFixturePatch(
  state: FixtureState,
  patch: JsonObject,
): FixtureState {
  return {
    clicked: typeof patch.clicked === "boolean" ? patch.clicked : state.clicked,
    actionPressed:
      typeof patch.actionPressed === "boolean"
        ? patch.actionPressed
        : state.actionPressed,
    switchChecked:
      typeof patch.switchChecked === "boolean"
        ? patch.switchChecked
        : state.switchChecked,
    setValueText:
      typeof patch.setValueText === "string"
        ? patch.setValueText
        : state.setValueText,
    typeText:
      typeof patch.typeText === "string" ? patch.typeText : state.typeText,
    lastKey:
      typeof patch.lastKey === "string" || patch.lastKey === null
        ? patch.lastKey
        : state.lastKey,
    scrollTop:
      typeof patch.scrollTop === "number" && Number.isFinite(patch.scrollTop)
        ? patch.scrollTop
        : state.scrollTop,
    coordinateClicked:
      typeof patch.coordinateClicked === "boolean"
        ? patch.coordinateClicked
        : state.coordinateClicked,
    coordinateClientX:
      typeof patch.coordinateClientX === "number" &&
      Number.isFinite(patch.coordinateClientX)
        ? patch.coordinateClientX
        : state.coordinateClientX,
    coordinateClientY:
      typeof patch.coordinateClientY === "number" &&
      Number.isFinite(patch.coordinateClientY)
        ? patch.coordinateClientY
        : state.coordinateClientY,
    resetVersion: state.resetVersion,
  };
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function writeHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

async function createFixtureServer(): Promise<FixtureServer> {
  let resetVersion = 0;
  let state = emptyFixtureState(resetVersion);
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/reset") {
        resetVersion += 1;
        state = emptyFixtureState(resetVersion);
        writeJson(response, state);
        return;
      }
      if (request.method === "POST" && url.pathname === "/event") {
        const body = await readRequestBody(request);
        const parsed = JSON.parse(body) as unknown;
        if (!isJsonObject(parsed)) {
          response.writeHead(400);
          response.end("event body must be a JSON object");
          return;
        }
        state = mergeFixturePatch(state, parsed);
        writeJson(response, state);
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        writeJson(response, state);
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        writeHtml(response, mainFixtureHtml());
        return;
      }
      response.writeHead(404);
      response.end("not found");
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve fixture server address");
  }
  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;

  return {
    origin,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    reset: async () => {
      const response = await fetch(`${origin}/reset`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Fixture reset failed: ${response.status}`);
      }
      await delay(300);
    },
    state: async () => {
      const response = await fetch(`${origin}/state`);
      if (!response.ok) {
        throw new Error(`Fixture state read failed: ${response.status}`);
      }
      return fixtureStateFromJson(await response.json());
    },
  };
}

function fixtureScript(): string {
  return `
const post = async (patch) => {
  await fetch("/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
};

window.addEventListener("DOMContentLoaded", () => {
  const setValueInput = document.getElementById("set-value-input");
  const typeTextInput = document.getElementById("type-text-input");
  const reactSwitch = document.getElementById("react-switch");
  const scrollRegion = document.getElementById("scroll-region");
  let resetVersion = -1;
  const setReactSwitchChecked = (checked) => {
    reactSwitch.setAttribute("aria-checked", checked ? "true" : "false");
    reactSwitch.dataset.checked = checked ? "true" : "false";
  };
  const syncReset = async () => {
    const response = await fetch("/state");
    const state = await response.json();
    if (state.resetVersion === resetVersion) {
      return;
    }
    resetVersion = state.resetVersion;
    setValueInput.value = "";
    typeTextInput.value = "";
    setReactSwitchChecked(false);
    scrollRegion.scrollTop = 0;
  };
  document.getElementById("click-button").addEventListener("click", () => {
    void post({ clicked: true });
  });
  document.getElementById("action-button").addEventListener("click", () => {
    void post({ actionPressed: true });
  });
  reactSwitch.addEventListener("click", () => {
    const checked = reactSwitch.getAttribute("aria-checked") !== "true";
    setReactSwitchChecked(checked);
    void post({ switchChecked: checked });
  });
  document.getElementById("hotkey-target").addEventListener("click", () => {
    document.getElementById("hotkey-target").focus();
  });
  scrollRegion.addEventListener("scroll", () => {
    void post({ scrollTop: scrollRegion.scrollTop });
  });
  window.addEventListener("keydown", (event) => {
    void post({ lastKey: event.key });
  });
  document.getElementById("coordinate-target").addEventListener("click", (event) => {
    void post({
      coordinateClicked: true,
      coordinateClientX: event.clientX,
      coordinateClientY: event.clientY
    });
  });
  setInterval(() => {
    void syncReset().then(() => {
      void post({
        setValueText: setValueInput.value,
        typeText: typeTextInput.value,
        scrollTop: scrollRegion.scrollTop
      });
    });
  }, 150);
});
`;
}

function mainFixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>VM0 Computer Use Eval</title>
    <style>
      body {
        color: #1a1f2b;
        font-family: Arial, sans-serif;
        margin: 24px;
      }
      main {
        display: grid;
        gap: 18px;
        grid-template-columns: 420px 420px;
        max-width: 900px;
      }
      button,
      input {
        font-size: 18px;
        min-height: 44px;
        padding: 8px 12px;
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 16px;
      }
      #scroll-region {
        border: 2px solid #44546a;
        height: 120px;
        overflow: auto;
        padding: 12px;
        width: 420px;
      }
      #scroll-content {
        height: 720px;
      }
      #coordinate-target {
        align-items: center;
        background: #1d7f5a;
        color: white;
        display: flex;
        font-size: 28px;
        font-weight: 700;
        height: 360px;
        justify-content: center;
        margin-top: 68px;
        width: 380px;
      }
      #react-switch {
        align-items: center;
        background: #6c7280;
        border: 2px solid #273142;
        border-radius: 999px;
        display: inline-flex;
        height: 42px;
        padding: 3px;
        width: 78px;
      }
      #react-switch[data-checked="true"] {
        background: #256f4a;
      }
      #react-switch .switch-thumb {
        background: white;
        border-radius: 999px;
        box-shadow: 0 1px 3px rgb(0 0 0 / 30%);
        display: block;
        height: 34px;
        transform: translateX(0);
        transition: transform 80ms linear;
        width: 34px;
      }
      #react-switch[data-checked="true"] .switch-thumb {
        transform: translateX(36px);
      }
      .controls {
        display: grid;
        gap: 18px;
      }
    </style>
    <script>${fixtureScript()}</script>
  </head>
  <body>
    <main aria-label="VM0-EVAL main fixture">
      <section class="controls">
        <h1>VM0 Computer Use Eval</h1>
        <button id="click-button" aria-label="VM0-EVAL click button">
          VM0-EVAL click button
        </button>
        <button id="action-button" aria-label="VM0-EVAL action button">
          VM0-EVAL action button
        </button>
        <div>
          <span id="react-switch-label">VM0-EVAL React switch</span>
          <div
            id="react-switch"
            role="switch"
            aria-checked="false"
            aria-labelledby="react-switch-label"
            tabindex="0"
            data-checked="false"
          >
            <span class="switch-thumb"></span>
          </div>
        </div>
        <label>
          VM0-EVAL set value field
          <input
            id="set-value-input"
            aria-label="VM0-EVAL set value input"
            value=""
          >
        </label>
        <label>
          VM0-EVAL type text field
          <input
            id="type-text-input"
            aria-label="VM0-EVAL type text input"
            value=""
          >
        </label>
        <button id="hotkey-target" aria-label="VM0-EVAL hotkey target">
          VM0-EVAL hotkey target
        </button>
        <div
          id="scroll-region"
          role="region"
          tabindex="0"
          aria-label="VM0-EVAL scroll area"
        >
          <div id="scroll-content">
            VM0-EVAL scroll area top
            <p style="margin-top: 620px;">VM0-EVAL scroll area bottom</p>
          </div>
        </div>
      </section>
      <button id="coordinate-target" aria-label="VM0-EVAL coordinate target">
        VM0-EVAL coordinate target
      </button>
    </main>
  </body>
</html>`;
}

async function launchFixtureWindow(
  options: EvalOptions,
  fixture: FixtureServer,
  browserProfileDir: string,
): Promise<ChildProcess | null> {
  const url = `${fixture.origin}/`;
  if (options.app === "Electron") {
    const electronPath = path.join(
      desktopRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "electron.cmd" : "electron",
    );
    const fixturePath = path.join(
      desktopRoot,
      "scripts",
      "computer-use-eval-fixture.mjs",
    );
    const child = spawn(electronPath, [fixturePath, url], {
      cwd: desktopRoot,
      stdio: "ignore",
    });
    await delay(1_500);
    return child;
  }
  if (options.app === "Google Chrome") {
    await execFileAsync(
      "open",
      [
        "-na",
        "Google Chrome",
        "--args",
        `--user-data-dir=${browserProfileDir}`,
        `--app=${url}`,
        "--window-size=900,700",
      ],
      { timeout: COMMAND_TIMEOUT_MS },
    );
    await delay(1_000);
    return null;
  }
  await execFileAsync("open", ["-a", options.app, url], {
    timeout: COMMAND_TIMEOUT_MS,
  });
  await delay(1_000);
  return null;
}

async function stopFixtureBrowser(
  options: EvalOptions,
  browserProfileDir: string,
  fixtureProcess: ChildProcess | null,
): Promise<void> {
  if (fixtureProcess) {
    fixtureProcess.kill();
    await delay(250);
    return;
  }
  if (options.app !== "Google Chrome") {
    return;
  }
  try {
    await execFileAsync("pkill", ["-f", browserProfileDir], {
      timeout: COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isNoProcessExit(error)) {
      throw error;
    }
  }
}

function isNoProcessExit(error: unknown): boolean {
  return (
    isJsonObject(error) && typeof error.code === "number" && error.code === 1
  );
}

async function startDaemon(daemonDir: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [cliPath, "daemon", "start", "--daemon-dir", daemonDir],
    { cwd: desktopRoot, timeout: COMMAND_TIMEOUT_MS },
  );
}

async function stopDaemon(daemonDir: string): Promise<void> {
  try {
    await execFileAsync(
      process.execPath,
      [cliPath, "daemon", "stop", "--daemon-dir", daemonDir],
      { cwd: desktopRoot, timeout: COMMAND_TIMEOUT_MS },
    );
  } catch (error) {
    if (!isNoProcessExit(error)) {
      throw error;
    }
  }
}

async function writeCommandArtifact(
  artifactsDir: string,
  caseName: string,
  args: readonly string[],
  stdout: string,
  stderr: string,
): Promise<void> {
  const safeName = caseName.replace(/[^A-Za-z0-9._-]+/g, "-");
  const artifact = {
    args,
    stdout,
    stderr,
  };
  await writeFile(
    path.join(artifactsDir, `${safeName}.command.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
}

async function runVm0ComputerCommand(
  context: Omit<EvalContext, "command" | "getAppState">,
  caseName: string,
  args: readonly string[],
): Promise<CommandOutput> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliPath, ...args, "--daemon-dir", context.daemonDir, "--timeout", "30"],
    {
      cwd: desktopRoot,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  await writeCommandArtifact(
    context.artifactsDir,
    caseName,
    args,
    stdout,
    stderr,
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`Command ${caseName} did not return a JSON object`);
  }
  return { raw: stdout, json: parsed };
}

async function getAppState(
  context: Omit<EvalContext, "command" | "getAppState">,
  caseName: string,
): Promise<AppStateOutput> {
  const output = await runVm0ComputerCommand(context, caseName, [
    "get-app-state",
    "--app",
    context.options.app,
  ]);
  const snapshotId = stringField(output.json, "snapshotId");
  const appStatePath = stringField(output.json, "appState");
  const screenshotPath = stringField(output.json, "screenshot");
  const appStateText = await readFile(appStatePath, "utf8");
  return {
    snapshotId,
    appStatePath,
    screenshotPath,
    appStateText,
  };
}

async function waitForFixtureAppState(
  context: EvalContext,
  caseName: string,
  expectedTitle: string,
): Promise<AppStateOutput> {
  let lastError: unknown;
  for (let attempt = 0; attempt < APP_STATE_RETRY_COUNT; attempt += 1) {
    try {
      const state = await context.getAppState(caseName);
      if (state.appStateText.includes(expectedTitle)) {
        return state;
      }
      lastError = new Error(`App state did not include ${expectedTitle}`);
    } catch (error) {
      lastError = error;
    }
    await delay(APP_STATE_RETRY_DELAY_MS);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${expectedTitle}`);
}

function findElementIndex(appStateText: string, text: string): number {
  for (const line of appStateText.split("\n")) {
    if (!line.includes(text)) {
      continue;
    }
    const match = /^\t*(\d+)\s+/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    return Number.parseInt(match[1], 10);
  }
  throw new Error(`Unable to find element index for ${text}`);
}

function findElementIndexByRole(
  appStateText: string,
  role: string,
  text: string,
): number {
  for (const line of appStateText.split("\n")) {
    if (!line.includes(text) || !line.includes(` ${role} `)) {
      continue;
    }
    const match = /^\t*(\d+)\s+/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    return Number.parseInt(match[1], 10);
  }
  throw new Error(`Unable to find ${role} element index for ${text}`);
}

function assertFreshActionState(
  output: CommandOutput,
  before: AppStateOutput,
): void {
  const snapshotId = stringField(output.json, "snapshotId");
  const appStatePath = stringField(output.json, "appState");
  const screenshotPath = stringField(output.json, "screenshot");
  if (snapshotId === before.snapshotId) {
    throw new Error("Action did not return a fresh snapshotId");
  }
  if (appStatePath === before.appStatePath) {
    throw new Error("Action did not return a fresh appState artifact");
  }
  if (screenshotPath === before.screenshotPath) {
    throw new Error("Action did not return a fresh screenshot artifact");
  }
}

function actionMetadata(output: CommandOutput): JsonObject {
  const action = output.json.action;
  if (!isJsonObject(action)) {
    throw new Error("Command output is missing action metadata");
  }
  return action;
}

async function waitForOracle(
  fixture: FixtureServer,
  description: string,
  predicate: (state: FixtureState) => boolean,
): Promise<FixtureState> {
  let latest = await fixture.state();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate(latest)) {
      return latest;
    }
    await delay(250);
    latest = await fixture.state();
  }
  throw new Error(
    `Timed out waiting for oracle: ${description}. Latest state: ${JSON.stringify(
      latest,
    )}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const evalCases: readonly EvalCase[] = [
  {
    name: "list-apps",
    run: async (context) => {
      const output = await context.command("list-apps", ["list-apps"]);
      const apps = output.json.apps;
      if (!Array.isArray(apps)) {
        throw new Error("list-apps did not return an apps array");
      }
      const hasTargetApp = apps.some((app) => {
        return isJsonObject(app) && app.name === context.options.app;
      });
      if (!hasTargetApp) {
        throw new Error(`list-apps did not include ${context.options.app}`);
      }
    },
  },
  {
    name: "open-app",
    run: async (context) => {
      const output = await context.command("open-app", [
        "open-app",
        "--app",
        context.options.app,
      ]);
      const action = output.json.action;
      if (!isJsonObject(action) || action.app !== context.options.app) {
        throw new Error("open-app did not return target app action metadata");
      }
    },
  },
  {
    name: "get-app-state",
    run: async (context) => {
      const state = await waitForFixtureAppState(
        context,
        "get-app-state",
        "VM0 Computer Use Eval",
      );
      if (!state.appStateText.includes("<app_state>")) {
        throw new Error("app state artifact is missing <app_state>");
      }
    },
  },
  {
    name: "click-element-index",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "click-element-index-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndex(
        before.appStateText,
        "VM0-EVAL click button",
      );
      const output = await context.command("click-element-index", [
        "click",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
      ]);
      assertFreshActionState(output, before);
      await waitForOracle(
        context.fixture,
        "click button sets clicked=true",
        (state) => state.clicked,
      );
    },
  },
  {
    name: "perform-action",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "perform-action-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndex(
        before.appStateText,
        "VM0-EVAL action button",
      );
      const output = await context.command("perform-action", [
        "perform-action",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
        "--action",
        "AXPress",
      ]);
      assertFreshActionState(output, before);
      const action = actionMetadata(output);
      if (
        action.action !== "AXPress" ||
        action.dispatchMode !== "accessibility_action"
      ) {
        throw new Error("perform-action returned unexpected action metadata");
      }
    },
  },
  {
    name: "click-web-switch",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "click-web-switch-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndexByRole(
        before.appStateText,
        "checkbox",
        "VM0-EVAL React switch",
      );
      const output = await context.command("click-web-switch", [
        "click",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
      ]);
      assertFreshActionState(output, before);
      const action = actionMetadata(output);
      if (action.clickStrategy !== "mouse") {
        throw new Error("web switch element click did not use mouse strategy");
      }
      await waitForOracle(
        context.fixture,
        "web switch element click toggles checked state",
        (state) => state.switchChecked,
      );
    },
  },
  {
    name: "set-value",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "set-value-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndex(
        before.appStateText,
        "VM0-EVAL set value input",
      );
      const output = await context.command("set-value", [
        "set-value",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
        "--value",
        "set-value-ok",
      ]);
      assertFreshActionState(output, before);
      await waitForOracle(
        context.fixture,
        "set-value updates fixture input",
        (state) => state.setValueText === "set-value-ok",
      );
    },
  },
  {
    name: "type-text",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "type-text-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndex(
        before.appStateText,
        "VM0-EVAL type text input",
      );
      await context.command("type-text-focus", [
        "click",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
      ]);
      const output = await context.command("type-text", [
        "type-text",
        "--app",
        context.options.app,
        "--text",
        "typed-ok",
      ]);
      assertFreshActionState(output, before);
      await waitForOracle(
        context.fixture,
        "type-text updates fixture input",
        (state) => state.typeText.includes("typed-ok"),
      );
    },
  },
  {
    name: "press-key",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "press-key-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndex(
        before.appStateText,
        "VM0-EVAL hotkey target",
      );
      await context.command("press-key-focus", [
        "click",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
      ]);
      const output = await context.command("press-key", [
        "press-key",
        "--app",
        context.options.app,
        "--key",
        "a",
      ]);
      assertFreshActionState(output, before);
      await waitForOracle(
        context.fixture,
        "press-key records keydown",
        (state) => state.lastKey === "a",
      );
    },
  },
  {
    name: "scroll",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "scroll-before",
        "VM0 Computer Use Eval",
      );
      const elementIndex = findElementIndex(
        before.appStateText,
        "VM0-EVAL scroll area",
      );
      const output = await context.command("scroll", [
        "scroll",
        "--app",
        context.options.app,
        "--element-index",
        elementIndex.toString(),
        "--direction",
        "down",
        "--pages",
        "1",
      ]);
      assertFreshActionState(output, before);
      const action = actionMetadata(output);
      if (
        action.direction !== "down" ||
        action.dispatchMode !== "accessibility_action"
      ) {
        throw new Error("scroll returned unexpected action metadata");
      }
    },
  },
  {
    name: "click-coordinates",
    run: async (context) => {
      await context.fixture.reset();
      const before = await waitForFixtureAppState(
        context,
        "click-coordinates-before",
        "VM0 Computer Use Eval",
      );
      const output = await context.command("click-coordinates", [
        "click",
        "--app",
        context.options.app,
        "--snapshot-id",
        before.snapshotId,
        "--x",
        "650",
        "--y",
        "260",
      ]);
      assertFreshActionState(output, before);
      await waitForOracle(
        context.fixture,
        "coordinate click hits fixture target",
        (state) => state.coordinateClicked,
      );
    },
  },
];

function filteredCases(options: EvalOptions): readonly EvalCase[] {
  if (!options.caseName) {
    return evalCases;
  }
  const matches = evalCases.filter((testCase) => {
    return testCase.name === options.caseName;
  });
  if (matches.length === 0) {
    throw new Error(`Unknown eval case: ${options.caseName}`);
  }
  return matches;
}

async function runEvalCases(context: EvalContext): Promise<EvalCaseResult[]> {
  const cases = filteredCases(context.options);
  const results: EvalCaseResult[] = [];
  for (let iteration = 1; iteration <= context.options.repeat; iteration += 1) {
    for (const testCase of cases) {
      const name =
        context.options.repeat === 1
          ? testCase.name
          : `${testCase.name}#${iteration.toString()}`;
      const startedAt = Date.now();
      try {
        await testCase.run(context);
        const durationMs = Date.now() - startedAt;
        results.push({ name, passed: true, durationMs });
        console.log(`PASS ${name} (${durationMs.toString()} ms)`);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          name,
          passed: false,
          durationMs,
          error: message,
        });
        console.error(`FAIL ${name} (${durationMs.toString()} ms)`);
        console.error(message);
      }
    }
  }
  return results;
}

async function writeSummary(
  artifactsDir: string,
  options: EvalOptions,
  results: readonly EvalCaseResult[],
): Promise<void> {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const summary = {
    suite: options.suite,
    app: options.app,
    total: results.length,
    passed,
    failed,
    successRate: results.length === 0 ? 0 : passed / results.length,
    artifactsDir,
    results,
  };
  await writeFile(
    path.join(artifactsDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `\nSummary: ${passed.toString()}/${results.length.toString()} passed`,
  );
  console.log(`Artifacts: ${artifactsDir}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runId = `${new Date()
    .toISOString()
    .replace(/[^0-9A-Za-z]+/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactsDir = path.join("/tmp/vm0/computer-use-evals", runId);
  const daemonDir = path.join(artifactsDir, "daemon");
  const browserProfileDir = await mkdtemp(
    path.join(tmpdir(), "vm0-computer-eval-chrome-"),
  );
  await mkdir(artifactsDir, { recursive: true });

  const fixture = await createFixtureServer();
  let fixtureProcess: ChildProcess | null = null;
  const contextBase: Omit<EvalContext, "command" | "getAppState"> = {
    options,
    fixture,
    artifactsDir,
    daemonDir,
    browserProfileDir,
  };
  const context: EvalContext = {
    ...contextBase,
    command: async (caseName, args) => {
      return await runVm0ComputerCommand(contextBase, caseName, args);
    },
    getAppState: async (caseName) => {
      return await getAppState(contextBase, caseName);
    },
  };

  let results: readonly EvalCaseResult[] = [];
  try {
    fixtureProcess = await launchFixtureWindow(
      options,
      fixture,
      browserProfileDir,
    );
    await startDaemon(daemonDir);
    results = await runEvalCases(context);
    await writeSummary(artifactsDir, options, results);
  } finally {
    await stopDaemon(daemonDir);
    await stopFixtureBrowser(options, browserProfileDir, fixtureProcess);
    await fixture.close();
    await rm(browserProfileDir, { recursive: true, force: true });
  }

  if (results.some((result) => !result.passed)) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
