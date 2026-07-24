import { spawnSync } from "node:child_process";

import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  ZERO_BROWSER_DEFAULT_MAX_CREDITS,
  ZERO_BROWSER_DEFAULT_TIMEOUT_MINUTES,
  ZERO_BROWSER_MAX_CREDITS,
  ZERO_BROWSER_MAX_TIMEOUT_MINUTES,
  zeroBrowserCreateRequestSchema,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";

import {
  createZeroBrowser,
  getCurrentZeroBrowser,
  resumeZeroBrowser,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const DEFAULT_AGENT_BROWSER_SESSION = "zero-browser";

interface NewOptions {
  readonly name: string;
  readonly country?: string;
  readonly timeout: number;
  readonly maxCredits: number;
  readonly agentSession?: string;
  readonly json?: boolean;
}

interface ConnectionOptions {
  readonly agentSession?: string;
  readonly json?: boolean;
}

interface OutputOptions {
  readonly json?: boolean;
}

function positiveInteger(
  label: string,
  maximum: number,
): (value: string) => number {
  return (value) => {
    if (!/^\d+$/u.test(value)) {
      throw new InvalidArgumentError(
        `${label} must be an integer from 1 to ${maximum}`,
      );
    }
    const parsed = Number(value);
    if (parsed < 1 || parsed > maximum) {
      throw new InvalidArgumentError(
        `${label} must be an integer from 1 to ${maximum}`,
      );
    }
    return parsed;
  };
}

function parseCountry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(normalized)) {
    throw new InvalidArgumentError("country must be a two-letter country code");
  }
  return normalized;
}

function parseAgentSession(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(value)) {
    throw new InvalidArgumentError(
      "agent-session must contain only letters, numbers, underscores, or hyphens",
    );
  }
  return value;
}

function browserJson(
  browser: ZeroBrowserSession,
): Omit<ZeroBrowserSession, "liveUrl"> {
  const { liveUrl: _liveUrl, ...safeBrowser } = browser;
  return safeBrowser;
}

function connectAgentBrowser(cdpUrl: string, sessionName: string): void {
  const result = spawnSync(
    "agent-browser",
    ["--session", sessionName, "connect", cdpUrl],
    { stdio: "ignore" },
  );
  if (result.error) {
    throw new Error("Could not start agent-browser", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `agent-browser connect exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function renderBrowser(browser: ZeroBrowserSession): void {
  console.log(`${browser.name} · ${browser.status}`);
  console.log(chalk.dim(`  ID: ${browser.id}`));
  console.log(
    chalk.dim(
      `  Credits: ${browser.creditsCharged} charged / ${browser.maxCredits} budget`,
    ),
  );
  console.log(chalk.dim(`  Per-run timeout: ${browser.timeoutMinutes}m`));
  console.log(`  ${browser.viewerUrl}`);
}

async function connectResponse(
  response: {
    readonly browser: ZeroBrowserSession;
    readonly cdpUrl: string;
  },
  options: ConnectionOptions,
): Promise<void> {
  const sessionName = options.agentSession ?? DEFAULT_AGENT_BROWSER_SESSION;
  connectAgentBrowser(response.cdpUrl, sessionName);
  if (options.json) {
    console.log(
      JSON.stringify({
        browser: browserJson(response.browser),
        agentBrowserSession: sessionName,
      }),
    );
    return;
  }
  console.log(chalk.green("✓ Managed browser ready"));
  console.log(chalk.dim(`  agent-browser session: ${sessionName}`));
  console.log(`[Open live browser](${response.browser.viewerUrl})`);
}

const resumeCommand = new Command()
  .name("resume")
  .description(
    "Resume the current thread browser and attach it to agent-browser",
  )
  .addOption(
    new Option(
      "--agent-session <name>",
      "Named agent-browser session",
    ).argParser(parseAgentSession),
  )
  .option("--json", "Print machine-readable output without connection secrets")
  .action(
    withErrorHandler(async (options: ConnectionOptions) => {
      await connectResponse(await resumeZeroBrowser(), options);
    }),
  );

const newCommand = new Command()
  .name("new")
  .description("Create a fresh thread browser and attach it to agent-browser")
  .addOption(new Option("--name <name>", "Browser name").default("browser"))
  .addOption(
    new Option(
      "--country <code>",
      "Residential proxy country; omitted uses lower-cost proxyless egress",
    ).argParser(parseCountry),
  )
  .addOption(
    new Option("--timeout <minutes>", "Provider lifetime for this run")
      .default(ZERO_BROWSER_DEFAULT_TIMEOUT_MINUTES)
      .argParser(positiveInteger("timeout", ZERO_BROWSER_MAX_TIMEOUT_MINUTES)),
  )
  .addOption(
    new Option("--max-credits <credits>", "Logical browser credit budget")
      .default(ZERO_BROWSER_DEFAULT_MAX_CREDITS)
      .argParser(positiveInteger("max-credits", ZERO_BROWSER_MAX_CREDITS)),
  )
  .addOption(
    new Option(
      "--agent-session <name>",
      "Named agent-browser session",
    ).argParser(parseAgentSession),
  )
  .option("--json", "Print machine-readable output without connection secrets")
  .action(
    withErrorHandler(async (options: NewOptions) => {
      const request = zeroBrowserCreateRequestSchema.parse({
        name: options.name,
        proxyCountryCode: options.country ?? null,
        timeoutMinutes: options.timeout,
        maxCredits: options.maxCredits,
      });
      await connectResponse(await createZeroBrowser(request), options);
    }),
  );

const statusCommand = new Command()
  .name("status")
  .description("Show the current thread browser status")
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: OutputOptions) => {
      const browser = await getCurrentZeroBrowser();
      if (options.json) {
        console.log(JSON.stringify({ browser: browserJson(browser) }));
        return;
      }
      renderBrowser(browser);
    }),
  );

const viewCommand = new Command()
  .name("view")
  .description("Print the current thread browser's authenticated viewer link")
  .action(
    withErrorHandler(async () => {
      console.log((await getCurrentZeroBrowser()).viewerUrl);
    }),
  );

export const zeroBrowserCommand = new Command()
  .name("browser")
  .description("Use a managed remote browser through agent-browser")
  .addCommand(resumeCommand)
  .addCommand(newCommand)
  .addCommand(statusCommand)
  .addCommand(viewCommand)
  .addHelpText(
    "after",
    `
Examples:
  Resume this thread:    zero browser resume
  Create fresh state:    zero browser new --name booking --country us
  Use the browser:       agent-browser --session zero-browser open https://example.com
  Share live view:       zero browser view

Notes:
  - Zero stops and settles the provider instance automatically when the run ends
  - There are no manual stop or suspend commands
  - Browser Use credentials and connection URLs are never printed
  - A thread can have only one active provider instance`,
  );
