import { Command } from "commander";
import type {
  LocalBrowserCommandResponse,
  LocalBrowserReadCommandKind,
  LocalBrowserWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  createLocalBrowserReadCommand,
  createLocalBrowserWriteCommand,
  getLocalBrowserReadCommand,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

interface BrowserCommandOptions {
  host?: string;
  hostId?: string;
  tabId?: string;
  timeout?: string;
}

interface BrowserClickOptions extends BrowserCommandOptions {
  selector?: string;
  x?: string;
  y?: string;
}

interface BrowserTypeOptions extends BrowserCommandOptions {
  selector: string;
  text: string;
}

interface BrowserScrollOptions extends BrowserCommandOptions {
  direction?: string;
  amount?: string;
}

interface BrowserUrlOptions extends BrowserCommandOptions {
  url: string;
}

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

function resultText(command: LocalBrowserCommandResponse): string {
  if (!command.result) {
    return "";
  }
  return JSON.stringify(command.result, null, 2);
}

async function runReadCommand(
  kind: LocalBrowserReadCommandKind,
  options: BrowserCommandOptions,
): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const created = await createLocalBrowserReadCommand({
    kind,
    timeoutMs: timeoutSeconds * 1000,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ...(options.host ? { hostName: options.host } : {}),
    ...(options.hostId ? { hostId: options.hostId } : {}),
  });

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const command = await getLocalBrowserReadCommand(created.commandId);
    if (command.status === "queued" || command.status === "running") {
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
          : "Local-browser command failed",
      );
    }

    const text = resultText(command);
    if (text) {
      console.log(text);
    }
    return;
  }

  throw new Error(`Local-browser command timed out: ${created.commandId}`);
}

async function waitForCommand(
  commandId: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const command = await getLocalBrowserReadCommand(commandId);
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
          : "Local-browser command failed",
      );
    }

    const text = resultText(command);
    if (text) {
      console.log(text);
    }
    return;
  }

  throw new Error(`Local-browser command timed out: ${commandId}`);
}

async function runWriteCommand(
  kind: LocalBrowserWriteCommandKind,
  options: BrowserCommandOptions,
  payload: {
    selector?: string;
    x?: number;
    y?: number;
    text?: string;
    direction?: "up" | "down";
    amount?: number;
    url?: string;
  },
): Promise<void> {
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const created = await createLocalBrowserWriteCommand({
    kind,
    timeoutMs: timeoutSeconds * 1000,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ...(options.host ? { hostName: options.host } : {}),
    ...(options.hostId ? { hostId: options.hostId } : {}),
    ...payload,
  });

  await waitForCommand(created.commandId, timeoutSeconds);
}

function addReadOptions(command: Command): Command {
  return command
    .option("--host <name>", "Run on a named local-browser host")
    .option("--host-id <id>", "Run on a specific local-browser host id")
    .option("--tab-id <id>", "Target a specific browser tab")
    .option("--timeout <seconds>", "Maximum time to wait", "30");
}

function addWriteOptions(
  command: Command,
  options: { readonly tabId?: boolean } = {},
): Command {
  const withHostOptions = command
    .option("--host <name>", "Run on a named local-browser host")
    .option("--host-id <id>", "Run on a specific local-browser host id")
    .option("--timeout <seconds>", "Maximum time to wait", "30");

  return options.tabId === false
    ? withHostOptions
    : withHostOptions.option("--tab-id <id>", "Target a specific browser tab");
}

function readCommand(name: string, kind: LocalBrowserReadCommandKind): Command {
  return addReadOptions(
    new Command()
      .name(name)
      .description(`Run ${kind}`)
      .action(
        withErrorHandler(async (options: BrowserCommandOptions) => {
          await runReadCommand(kind, options);
        }),
      ),
  );
}

const tabsCommand = new Command()
  .name("tabs")
  .description("Read and control browser tabs")
  .addCommand(readCommand("list", "tabs.list"))
  .addCommand(readCommand("current", "tabs.current"))
  .addCommand(
    addWriteOptions(
      new Command()
        .name("activate")
        .description("Run tabs.activate")
        .requiredOption("--tab-id <id>", "Tab to activate")
        .action(
          withErrorHandler(async (options: BrowserCommandOptions) => {
            await runWriteCommand("tabs.activate", options, {});
          }),
        ),
      { tabId: false },
    ),
  )
  .addCommand(
    addWriteOptions(
      new Command()
        .name("open")
        .description("Run tabs.open")
        .requiredOption("--url <url>", "URL to open")
        .action(
          withErrorHandler(async (options: BrowserUrlOptions) => {
            await runWriteCommand("tabs.open", options, { url: options.url });
          }),
        ),
    ),
  )
  .addCommand(
    addWriteOptions(
      new Command()
        .name("close")
        .description("Run tabs.close")
        .requiredOption("--tab-id <id>", "Tab to close")
        .action(
          withErrorHandler(async (options: BrowserCommandOptions) => {
            await runWriteCommand("tabs.close", options, {});
          }),
        ),
      { tabId: false },
    ),
  );

const pageCommand = new Command()
  .name("page")
  .description("Read and control the active browser page")
  .addCommand(readCommand("snapshot", "page.snapshot"))
  .addCommand(readCommand("screenshot", "page.screenshot"))
  .addCommand(readCommand("selection", "page.selection"))
  .addCommand(readCommand("metadata", "page.metadata"))
  .addCommand(
    addWriteOptions(
      new Command()
        .name("click")
        .description("Run page.click")
        .option("--selector <selector>", "CSS selector to click")
        .option("--x <pixels>", "X coordinate to click")
        .option("--y <pixels>", "Y coordinate to click")
        .action(
          withErrorHandler(async (options: BrowserClickOptions) => {
            await runWriteCommand("page.click", options, {
              ...(options.selector ? { selector: options.selector } : {}),
              ...(options.x !== undefined
                ? { x: parseOptionalNonNegativeInteger(options.x, "x") }
                : {}),
              ...(options.y !== undefined
                ? { y: parseOptionalNonNegativeInteger(options.y, "y") }
                : {}),
            });
          }),
        ),
    ),
  )
  .addCommand(
    addWriteOptions(
      new Command()
        .name("type")
        .description("Run page.type")
        .requiredOption("--selector <selector>", "CSS selector to type into")
        .requiredOption("--text <text>", "Text to type")
        .action(
          withErrorHandler(async (options: BrowserTypeOptions) => {
            await runWriteCommand("page.type", options, {
              selector: options.selector,
              text: options.text,
            });
          }),
        ),
    ),
  )
  .addCommand(
    addWriteOptions(
      new Command()
        .name("scroll")
        .description("Run page.scroll")
        .option(
          "--direction <direction>",
          "Scroll direction: up or down",
          "down",
        )
        .option("--amount <pixels>", "Scroll amount in pixels", "600")
        .action(
          withErrorHandler(async (options: BrowserScrollOptions) => {
            if (options.direction !== "up" && options.direction !== "down") {
              throw new Error("direction must be up or down");
            }
            await runWriteCommand("page.scroll", options, {
              direction: options.direction,
              amount: parsePositiveInteger(options.amount, "amount"),
            });
          }),
        ),
    ),
  )
  .addCommand(
    addWriteOptions(
      new Command()
        .name("navigate")
        .description("Run page.navigate")
        .requiredOption("--url <url>", "URL to navigate to")
        .action(
          withErrorHandler(async (options: BrowserUrlOptions) => {
            await runWriteCommand("page.navigate", options, {
              url: options.url,
            });
          }),
        ),
    ),
  );

export const zeroLocalBrowserCommand = new Command()
  .name("local-browser")
  .description("Read authorized browser context")
  .addHelpText(
    "after",
    `
Examples:
  List tabs?       zero local-browser tabs list
  Current tab?     zero local-browser tabs current
  Click page?      zero local-browser page click --selector button
  Open tab?        zero local-browser tabs open --url https://example.com`,
  )
  .addCommand(tabsCommand)
  .addCommand(pageCommand);
