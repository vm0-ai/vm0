import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import type {
  ComputerUseCommandResponse,
  ComputerUseReadCommandKind,
  ComputerUseWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import {
  createComputerUseReadCommand,
  createComputerUseWriteCommand,
  getComputerUseCommand,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

interface ComputerUseCommandOptions {
  readonly timeout?: string;
}

interface ComputerUseAppOptions extends ComputerUseCommandOptions {
  readonly app: string;
}

interface ComputerUseClickOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly x?: string;
  readonly y?: string;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: string;
}

interface ComputerUseScrollOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly direction: "up" | "down" | "left" | "right";
  readonly pages?: string;
}

interface ComputerUseSetValueOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly value: string;
}

interface ComputerUsePerformActionOptions extends ComputerUseAppOptions {
  readonly snapshotId?: string;
  readonly element?: string;
  readonly elementIndex?: string;
  readonly action: string;
}

interface ComputerUseTypeTextOptions extends ComputerUseAppOptions {
  readonly text: string;
}

interface ComputerUsePressKeyOptions extends ComputerUseAppOptions {
  readonly key: string;
}

const COMPUTER_USE_SCREENSHOT_DIR = "/tmp/vm0/computer-use";
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseTimeoutSeconds(value: string | undefined): number {
  if (!value) return 30;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Timeout must be a positive number of seconds");
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
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveNumber(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parseMouseButton(
  value: string | undefined,
): "left" | "right" | "middle" {
  if (value === "left" || value === "right" || value === "middle") {
    return value;
  }
  throw new Error("button must be left, right, or middle");
}

function elementTargetPayload(options: {
  readonly element?: string;
  readonly elementIndex?: string;
}): { readonly elementId?: string; readonly elementIndex?: number } {
  const elementIndex = parseOptionalNonNegativeInteger(
    options.elementIndex,
    "element-index",
  );
  if (!options.element && elementIndex === undefined) {
    throw new Error("element or element-index is required");
  }
  return {
    ...(options.element ? { elementId: options.element } : {}),
    ...(elementIndex !== undefined ? { elementIndex } : {}),
  };
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
  const outputPath = join(
    COMPUTER_USE_SCREENSHOT_DIR,
    `${appName}-${snapshotId}.${extensionForMimeType(mimeType)}`,
  );

  await mkdir(COMPUTER_USE_SCREENSHOT_DIR, { recursive: true });
  await writeFile(outputPath, Buffer.from(base64Data, "base64"));
  return outputPath;
}

export async function formatComputerUseResultForConsole(
  result: Record<string, unknown>,
): Promise<string> {
  const printable: Record<string, unknown> = { ...result };
  if (typeof printable.screenshot === "string") {
    const screenshotPath = await writeScreenshotDataUrl(
      printable,
      printable.screenshot,
    );
    if (screenshotPath) {
      printable.screenshot = screenshotPath;
    }
  }
  return JSON.stringify(printable, null, 2);
}

async function resultText(
  command: ComputerUseCommandResponse,
): Promise<string> {
  if (!command.result) {
    return "";
  }
  return await formatComputerUseResultForConsole(command.result);
}

async function waitForCommand(
  commandId: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const command = await getComputerUseCommand(commandId);
    if (
      command.status === "pending_approval" ||
      command.status === "queued" ||
      command.status === "running"
    ) {
      if (process.stdout.isTTY) {
        process.stdout.write(".");
      }
      await sleep(1_000);
      continue;
    }

    if (process.stdout.isTTY) {
      process.stdout.write("\n");
    }

    if (command.status === "failed") {
      throw new Error(
        command.error
          ? `${command.error.code}: ${command.error.message}`
          : "Computer-use command failed",
      );
    }

    const text = await resultText(command);
    if (text) {
      console.log(text);
    }
    return;
  }

  throw new Error(`Computer-use command timed out: ${commandId}`);
}

async function runReadCommand(
  kind: ComputerUseReadCommandKind,
  options: ComputerUseCommandOptions,
  payload: { readonly app?: string } = {},
): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const created = await createComputerUseReadCommand({
    kind,
    timeoutMs: timeoutSeconds * 1000,
    ...payload,
  });
  await waitForCommand(created.commandId, timeoutSeconds);
}

async function runWriteCommand(
  kind: ComputerUseWriteCommandKind,
  options: ComputerUseCommandOptions,
  payload: {
    readonly app: string;
    readonly snapshotId?: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly x?: number;
    readonly y?: number;
    readonly button?: "left" | "right" | "middle";
    readonly clickCount?: number;
    readonly direction?: "up" | "down" | "left" | "right";
    readonly pages?: number;
    readonly value?: string;
    readonly text?: string;
    readonly key?: string;
    readonly action?: string;
  },
): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const created = await createComputerUseWriteCommand({
    kind,
    timeoutMs: timeoutSeconds * 1000,
    ...payload,
  });
  await waitForCommand(created.commandId, timeoutSeconds);
}

function addTargetOptions(command: Command): Command {
  return command.option("--timeout <seconds>", "Maximum time to wait", "30");
}

function appOption(command: Command): Command {
  return command.requiredOption("--app <name>", "Target app name or bundle id");
}

const listAppsCommand = addTargetOptions(
  new Command()
    .name("list-apps")
    .description("List apps available to the Desktop Computer Use host")
    .action(
      withErrorHandler(async (options: ComputerUseCommandOptions) => {
        await runReadCommand("apps.list", options);
      }),
    ),
);

const getAppStateCommand = appOption(
  addTargetOptions(
    new Command()
      .name("get-app-state")
      .description(
        "Get screenshot and accessibility state without activating an app",
      )
      .action(
        withErrorHandler(async (options: ComputerUseAppOptions) => {
          await runReadCommand("app.state", options, { app: options.app });
        }),
      ),
  ),
);

const clickCommand = appOption(
  addTargetOptions(
    new Command()
      .name("click")
      .description(
        "Click an accessibility element or background screenshot coordinate",
      )
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .option("--x <points>", "Screenshot x coordinate fallback")
      .option("--y <points>", "Screenshot y coordinate fallback")
      .option("--button <button>", "Mouse button", "left")
      .option("--click-count <count>", "Number of clicks", "1")
      .action(
        withErrorHandler(async (options: ComputerUseClickOptions) => {
          const x = parseOptionalNonNegativeInteger(options.x, "x");
          const y = parseOptionalNonNegativeInteger(options.y, "y");
          const elementIndex = parseOptionalNonNegativeInteger(
            options.elementIndex,
            "element-index",
          );
          await runWriteCommand("element.click", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...(options.element ? { elementId: options.element } : {}),
            ...(elementIndex !== undefined ? { elementIndex } : {}),
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            button: parseMouseButton(options.button),
            clickCount: parsePositiveInteger(options.clickCount, "click-count"),
          });
        }),
      ),
  ),
);

const scrollCommand = appOption(
  addTargetOptions(
    new Command()
      .name("scroll")
      .description("Scroll an accessibility element")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .requiredOption(
        "--direction <direction>",
        "Scroll direction: up, down, left, or right",
      )
      .option("--pages <count>", "Number of pages to scroll", "1")
      .action(
        withErrorHandler(async (options: ComputerUseScrollOptions) => {
          await runWriteCommand("element.scroll", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...elementTargetPayload(options),
            direction: options.direction,
            pages: parsePositiveNumber(options.pages, "pages"),
          });
        }),
      ),
  ),
);

const setValueCommand = appOption(
  addTargetOptions(
    new Command()
      .name("set-value")
      .description("Set the value of a settable accessibility element")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .requiredOption("--value <text>", "Value to assign")
      .action(
        withErrorHandler(async (options: ComputerUseSetValueOptions) => {
          await runWriteCommand("element.set_value", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...elementTargetPayload(options),
            value: options.value,
          });
        }),
      ),
  ),
);

const typeTextCommand = appOption(
  addTargetOptions(
    new Command()
      .name("type-text")
      .description("Type literal text into the target app")
      .requiredOption("--text <text>", "Text to type")
      .action(
        withErrorHandler(async (options: ComputerUseTypeTextOptions) => {
          await runWriteCommand("keyboard.type_text", options, {
            app: options.app,
            text: options.text,
          });
        }),
      ),
  ),
);

const pressKeyCommand = appOption(
  addTargetOptions(
    new Command()
      .name("press-key")
      .description("Send a background key or key combination to the target app")
      .requiredOption(
        "--key <key>",
        "Key or key combination to press, for example Command+K or Control+K",
      )
      .action(
        withErrorHandler(async (options: ComputerUsePressKeyOptions) => {
          await runWriteCommand("keyboard.press_key", options, {
            app: options.app,
            key: options.key,
          });
        }),
      ),
  ),
);

const performActionCommand = appOption(
  addTargetOptions(
    new Command()
      .name("perform-action")
      .description("Invoke a secondary accessibility action")
      .option("--snapshot-id <id>", "Snapshot id returned by get-app-state")
      .option("--element <id>", "Element id from get-app-state")
      .option("--element-index <index>", "Element index from get-app-state")
      .requiredOption("--action <name>", "Accessibility action name")
      .action(
        withErrorHandler(async (options: ComputerUsePerformActionOptions) => {
          await runWriteCommand("element.perform_action", options, {
            app: options.app,
            ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
            ...elementTargetPayload(options),
            action: options.action,
          });
        }),
      ),
  ),
);

const openAppCommand = appOption(
  addTargetOptions(
    new Command()
      .name("open-app")
      .description("Open an app on the Desktop host without activating it")
      .action(
        withErrorHandler(async (options: ComputerUseAppOptions) => {
          await runWriteCommand("app.open", options, { app: options.app });
        }),
      ),
  ),
);

export const zeroComputerUseCommand = new Command()
  .name("computer-use")
  .description("Desktop app computer use through Zero CLI")
  .addCommand(listAppsCommand)
  .addCommand(getAppStateCommand)
  .addCommand(clickCommand)
  .addCommand(scrollCommand)
  .addCommand(setValueCommand)
  .addCommand(typeTextCommand)
  .addCommand(pressKeyCommand)
  .addCommand(performActionCommand)
  .addCommand(openAppCommand);
