import { Command } from "commander";
import type {
  LocalBrowserCommandResponse,
  LocalBrowserReadCommandKind,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  createLocalBrowserReadCommand,
  getLocalBrowserReadCommand,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command/with-error-handler";

interface BrowserReadOptions {
  host?: string;
  hostId?: string;
  tabId?: string;
  timeout?: string;
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

function resultText(command: LocalBrowserCommandResponse): string {
  if (!command.result) {
    return "";
  }
  return JSON.stringify(command.result, null, 2);
}

async function runReadCommand(
  kind: LocalBrowserReadCommandKind,
  options: BrowserReadOptions,
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

function addReadOptions(command: Command): Command {
  return command
    .option("--host <name>", "Run on a named local-browser host")
    .option("--host-id <id>", "Run on a specific local-browser host id")
    .option("--tab-id <id>", "Target a specific browser tab")
    .option("--timeout <seconds>", "Maximum time to wait", "30");
}

function readCommand(name: string, kind: LocalBrowserReadCommandKind): Command {
  return addReadOptions(
    new Command()
      .name(name)
      .description(`Run ${kind}`)
      .action(
        withErrorHandler(async (options: BrowserReadOptions) => {
          await runReadCommand(kind, options);
        }),
      ),
  );
}

const tabsCommand = new Command()
  .name("tabs")
  .description("Read browser tabs")
  .addCommand(readCommand("list", "tabs.list"))
  .addCommand(readCommand("current", "tabs.current"));

const pageCommand = new Command()
  .name("page")
  .description("Read the active browser page")
  .addCommand(readCommand("snapshot", "page.snapshot"))
  .addCommand(readCommand("screenshot", "page.screenshot"))
  .addCommand(readCommand("selection", "page.selection"))
  .addCommand(readCommand("metadata", "page.metadata"));

export const zeroLocalBrowserCommand = new Command()
  .name("local-browser")
  .description("Read authorized browser context")
  .addHelpText(
    "after",
    `
Examples:
  List tabs?       zero local-browser tabs list
  Current tab?     zero local-browser tabs current
  Page metadata?   zero local-browser page metadata
  Page selection?  zero local-browser page selection`,
  )
  .addCommand(tabsCommand)
  .addCommand(pageCommand);
