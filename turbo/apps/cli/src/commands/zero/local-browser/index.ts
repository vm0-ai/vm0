import { Command } from "commander";
import chalk from "chalk";
import type {
  LocalBrowserAuditEvent,
  LocalBrowserCommandResponse,
  LocalBrowserHost,
  LocalBrowserReadCommandKind,
  LocalBrowserWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  createLocalBrowserReadCommand,
  createLocalBrowserWriteCommand,
  deleteLocalBrowserHost,
  getLocalBrowserReadCommand,
  listLocalBrowserAuditEvents,
  listLocalBrowserHosts,
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

interface JsonOutputOptions {
  json?: boolean;
}

interface AuditListOptions extends JsonOutputOptions {
  limit?: string;
  commandId?: string;
  hostId?: string;
  runId?: string;
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

function parseLimit(value: string | undefined): number {
  if (value === undefined) {
    return 50;
  }
  const parsed = parsePositiveInteger(value, "limit");
  if (parsed > 200) {
    throw new Error("limit must be 200 or less");
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

function formatCapabilities(capabilities: readonly string[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "none";
}

function formatHost(host: LocalBrowserHost): string {
  const status =
    host.status === "online" ? chalk.green("online") : chalk.dim("offline");
  return [
    `${status}  ${host.displayName}`,
    `  id: ${host.id}`,
    `  browser: ${host.browser}`,
    `  extension: ${host.extensionVersion}`,
    `  last seen: ${host.lastSeenAt}`,
    `  capabilities: ${formatCapabilities(host.supportedCapabilities)}`,
  ].join("\n");
}

function formatAuditEvent(event: LocalBrowserAuditEvent): string {
  const parts = [
    event.createdAt,
    event.event,
    event.kind,
    `command=${event.commandId}`,
  ];
  if (event.hostId) {
    parts.push(`host=${event.hostId}`);
  }
  if (event.runId) {
    parts.push(`run=${event.runId}`);
  }
  if (event.tabId) {
    parts.push(`tab=${event.tabId}`);
  }
  if (event.targetUrl) {
    parts.push(`url=${event.targetUrl}`);
  }
  if (event.approvalOutcome) {
    parts.push(`approval=${event.approvalOutcome}`);
  }
  if (event.error) {
    parts.push(`error=${JSON.stringify(event.error)}`);
  }
  return parts.join("  ");
}

const hostsCommand = new Command()
  .name("hosts")
  .description("List and revoke linked local-browser hosts")
  .addCommand(
    new Command()
      .name("list")
      .description("List linked local-browser hosts")
      .option("--json", "Output hosts as JSON")
      .action(
        withErrorHandler(async (options: JsonOutputOptions) => {
          const result = await listLocalBrowserHosts();
          if (options.json) {
            console.log(JSON.stringify(result));
            return;
          }
          if (result.hosts.length === 0) {
            console.log(chalk.dim("No linked local-browser hosts."));
            return;
          }
          console.log(result.hosts.map(formatHost).join("\n\n"));
        }),
      ),
  )
  .addCommand(
    new Command()
      .name("revoke")
      .description("Revoke a linked local-browser host")
      .argument("<host-id>", "Local-browser host id")
      .option("--json", "Output the revoke result as JSON")
      .action(
        withErrorHandler(async (hostId: string, options: JsonOutputOptions) => {
          const result = await deleteLocalBrowserHost(hostId);
          if (options.json) {
            console.log(JSON.stringify(result));
            return;
          }
          console.log(chalk.green("Local-browser host revoked"));
          console.log(chalk.dim(`  Host: ${hostId}`));
        }),
      ),
  );

const auditCommand = new Command()
  .name("audit")
  .description("Inspect local-browser write command audit events")
  .addCommand(
    new Command()
      .name("list")
      .description("List local-browser write command audit events")
      .option("--limit <count>", "Maximum events to show", "50")
      .option("--command-id <id>", "Filter by command id")
      .option("--host-id <id>", "Filter by host id")
      .option("--run-id <id>", "Filter by run id")
      .option("--json", "Output audit events as JSON")
      .action(
        withErrorHandler(async (options: AuditListOptions) => {
          const result = await listLocalBrowserAuditEvents({
            limit: parseLimit(options.limit),
            ...(options.commandId ? { commandId: options.commandId } : {}),
            ...(options.hostId ? { hostId: options.hostId } : {}),
            ...(options.runId ? { runId: options.runId } : {}),
          });
          if (options.json) {
            console.log(JSON.stringify(result));
            return;
          }
          if (result.auditEvents.length === 0) {
            console.log(chalk.dim("No local-browser audit events found."));
            return;
          }
          console.log(result.auditEvents.map(formatAuditEvent).join("\n"));
        }),
      ),
  );

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
  .description("Read and manage authorized browser context")
  .addHelpText(
    "after",
    `
Examples:
  List hosts?      zero local-browser hosts list
  Revoke host?     zero local-browser hosts revoke <host-id>
  List tabs?       zero local-browser tabs list
  Current tab?     zero local-browser tabs current
  Click page?      zero local-browser page click --selector button
  Open tab?        zero local-browser tabs open --url https://example.com
  Audit actions?   zero local-browser audit list`,
  )
  .addCommand(hostsCommand)
  .addCommand(auditCommand)
  .addCommand(tabsCommand)
  .addCommand(pageCommand);
