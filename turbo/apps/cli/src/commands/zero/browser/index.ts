import { spawnSync } from "node:child_process";

import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import {
  ZERO_BROWSER_IDLE_LEASE_MINUTES,
  zeroBrowserCreateRequestSchema,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";

import {
  createZeroBrowser,
  getCurrentZeroBrowser,
  leaseZeroBrowser,
  useZeroBrowser,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const DEFAULT_AGENT_BROWSER_SESSION = "zero-browser";

interface NewOptions {
  readonly name: string;
  readonly country?: string;
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
): Omit<
  ZeroBrowserSession,
  "creditsCharged" | "grossCredits" | "liveUrl" | "maxCredits"
> {
  const {
    creditsCharged: _creditsCharged,
    grossCredits: _grossCredits,
    liveUrl: _liveUrl,
    maxCredits: _maxCredits,
    ...safeBrowser
  } = browser;
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

function reclaimNotice(browser: ZeroBrowserSession): string {
  return browser.idleExpiresAt
    ? `Zero reclaims this browser at ${browser.idleExpiresAt} unless it is used or leased again`
    : "This browser has no live window to reclaim";
}

function renderBrowser(browser: ZeroBrowserSession): void {
  console.log(`${browser.name} · ${browser.status}`);
  console.log(chalk.dim(`  Thread ID: ${browser.threadId}`));
  console.log(chalk.dim(`  ${reclaimNotice(browser)}`));
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
  console.log(chalk.dim(`  ${reclaimNotice(response.browser)}`));
  console.log(`[Open live browser](${response.browser.viewerUrl})`);
}

const useCommand = new Command()
  .name("use")
  .description(
    "Create, reuse, or resume this thread's browser, attach it to agent-browser, and extend its lease",
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
      await connectResponse(await useZeroBrowser(), options);
    }),
  );

const resumeCommand = new Command()
  .name("resume")
  .description("Deprecated alias of use")
  .addOption(
    new Option(
      "--agent-session <name>",
      "Named agent-browser session",
    ).argParser(parseAgentSession),
  )
  .option("--json", "Print machine-readable output without connection secrets")
  .action(
    withErrorHandler(async (options: ConnectionOptions) => {
      await connectResponse(await useZeroBrowser(), options);
    }),
  );

const leaseCommand = new Command()
  .name("lease")
  .description(
    `Keep this thread's live browser for another ${ZERO_BROWSER_IDLE_LEASE_MINUTES} minutes`,
  )
  .option("--json", "Print machine-readable output")
  .action(
    withErrorHandler(async (options: OutputOptions) => {
      const browser = await leaseZeroBrowser();
      if (options.json) {
        console.log(JSON.stringify({ browser: browserJson(browser) }));
        return;
      }
      console.log(chalk.green("✓ Managed browser lease extended"));
      console.log(chalk.dim(`  ${reclaimNotice(browser)}`));
    }),
  );

const newCommand = new Command()
  .name("new")
  .description(
    "Create another thread browser with the shared user profile and attach it to agent-browser",
  )
  .addOption(new Option("--name <name>", "Browser name").default("browser"))
  .addOption(
    new Option(
      "--country <code>",
      "Residential proxy country; omitted uses lower-cost proxyless egress",
    ).argParser(parseCountry),
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
  .addCommand(useCommand)
  .addCommand(leaseCommand)
  .addCommand(resumeCommand)
  .addCommand(newCommand)
  .addCommand(statusCommand)
  .addCommand(viewCommand)
  .addHelpText(
    "after",
    `
Examples:
  Open this thread's browser: zero browser use
  Keep it alive:              zero browser lease
  Create another browser:     zero browser new --name booking --country us
  Use the browser:            agent-browser --session zero-browser open https://example.com
  Share live view:            zero browser view

Notes:
  - The browser outlives this run; the user can keep working in it from the viewer link
  - Zero reclaims it after ${ZERO_BROWSER_IDLE_LEASE_MINUTES} idle minutes
  - \`zero browser use\` restores a reclaimed browser's login profile, not its old tabs
  - Browser Use credentials and connection URLs are never printed
  - Threads for the same user and organization share one login profile
  - Threads can use the shared profile in parallel`,
  );
