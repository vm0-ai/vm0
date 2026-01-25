import { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import prompts from "prompts";
import { getToken } from "../lib/api/config";
import { authenticate } from "../lib/api/auth";
import { checkModelProviderCredential, upsertModelProvider } from "../lib/api";
import { isInteractive } from "../lib/utils/prompt-utils";

const MARKETPLACE_NAME = "vm0-skills";
const MARKETPLACE_REPO = "vm0-ai/vm0-skills";
const PLUGIN_NAME = "vm0-cli";

interface MarketplaceConfig {
  [key: string]: {
    source: { source: string; url: string };
    installLocation: string;
    lastUpdated: string;
  };
}

interface InstalledPluginsConfig {
  version: number;
  plugins: {
    [key: string]: Array<{
      scope: string;
      installPath: string;
      version: string;
    }>;
  };
}

export function getClaudePluginsDir(home?: string): string {
  return path.join(home ?? homedir(), ".claude", "plugins");
}

function checkClaudeInstalled(): boolean {
  const result = spawnSync("claude", ["--version"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  return result.status === 0;
}

export function checkMarketplaceExists(home?: string): boolean {
  const configPath = path.join(
    getClaudePluginsDir(home),
    "known_marketplaces.json",
  );
  if (!existsSync(configPath)) {
    return false;
  }

  const config = JSON.parse(
    readFileSync(configPath, "utf-8"),
  ) as MarketplaceConfig;
  return MARKETPLACE_NAME in config;
}

export function checkPluginInstalled(home?: string): boolean {
  const configPath = path.join(
    getClaudePluginsDir(home),
    "installed_plugins.json",
  );
  if (!existsSync(configPath)) {
    return false;
  }

  const config = JSON.parse(
    readFileSync(configPath, "utf-8"),
  ) as InstalledPluginsConfig;
  const pluginKey = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
  return pluginKey in config.plugins;
}

function addMarketplace(): boolean {
  console.log(chalk.dim(`Adding ${MARKETPLACE_NAME} marketplace...`));
  const result = spawnSync(
    "claude",
    ["plugin", "marketplace", "add", MARKETPLACE_REPO],
    {
      stdio: "inherit",
    },
  );
  return result.status === 0;
}

function installPlugin(): boolean {
  console.log(chalk.dim(`Installing ${PLUGIN_NAME} plugin...`));
  const result = spawnSync(
    "claude",
    ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`],
    {
      stdio: "inherit",
    },
  );
  return result.status === 0;
}

async function ensureMarketplace(): Promise<boolean> {
  if (checkMarketplaceExists()) {
    console.log(chalk.green(`✓ ${MARKETPLACE_NAME} marketplace exists`));
    return true;
  }

  if (!addMarketplace()) {
    console.error(chalk.red(`✗ Failed to add ${MARKETPLACE_NAME} marketplace`));
    console.log();
    console.log("Try manually:");
    console.log(
      chalk.cyan(`  claude plugin marketplace add ${MARKETPLACE_REPO}`),
    );
    return false;
  }

  console.log(chalk.green(`✓ ${MARKETPLACE_NAME} marketplace added`));
  return true;
}

async function ensurePlugin(): Promise<boolean> {
  if (checkPluginInstalled()) {
    console.log(chalk.green(`✓ ${PLUGIN_NAME} plugin installed`));
    return true;
  }

  if (!installPlugin()) {
    console.error(chalk.red(`✗ Failed to install ${PLUGIN_NAME} plugin`));
    console.log();
    console.log("Try manually:");
    console.log(
      chalk.cyan(`  claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`),
    );
    return false;
  }

  console.log(chalk.green(`✓ ${PLUGIN_NAME} plugin installed`));
  return true;
}

async function ensureVm0Auth(): Promise<boolean> {
  const token = await getToken();
  if (token) {
    console.log(chalk.green("✓ VM0 authenticated"));
    return true;
  }

  console.log(chalk.dim("VM0 authentication required..."));
  console.log();

  await authenticate();

  const newToken = await getToken();
  if (!newToken) {
    console.error(chalk.red("✗ VM0 authentication failed"));
    return false;
  }

  console.log(chalk.green("✓ VM0 authenticated"));
  return true;
}

async function ensureClaudeToken(): Promise<boolean> {
  const checkResult = await checkModelProviderCredential(
    "claude-code-oauth-token",
  );

  if (checkResult.exists) {
    console.log(chalk.green("✓ Claude Code token configured"));
    return true;
  }

  if (!isInteractive()) {
    console.error(chalk.red("✗ Claude Code token not configured"));
    console.log(chalk.dim("  Run in interactive mode to configure, or use:"));
    console.log(
      chalk.cyan(
        '  vm0 model-provider setup --type claude-code-oauth-token --credential "<token>"',
      ),
    );
    return false;
  }

  console.log();
  console.log(chalk.yellow("Claude Code token setup required"));
  console.log();
  console.log("To get your OAuth token:");
  console.log(chalk.cyan("  1. Run: claude setup-token"));
  console.log(chalk.cyan("  2. Copy the token displayed"));
  console.log(chalk.dim("  (Requires Claude Pro or Max subscription)"));
  console.log();

  const tokenResponse = await prompts(
    {
      type: "password",
      name: "token",
      message: "Paste your Claude Code OAuth token:",
      validate: (value: string) => value.length > 0 || "Token is required",
    },
    { onCancel: () => process.exit(0) },
  );

  const token = tokenResponse.token as string;

  const confirmResponse = await prompts(
    {
      type: "confirm",
      name: "confirm",
      message: "Upload this token to VM0?",
      initial: true,
    },
    { onCancel: () => process.exit(0) },
  );

  if (!confirmResponse.confirm) {
    console.log(chalk.dim("Cancelled"));
    return false;
  }

  await upsertModelProvider({
    type: "claude-code-oauth-token",
    credential: token,
  });

  console.log(chalk.green("✓ Claude Code token uploaded to VM0"));
  return true;
}

function printLaunchCommand(): void {
  console.log();
  console.log(chalk.green.bold("Setup complete!"));
  console.log();
  console.log("Run the following command to start:");
  console.log();
  console.log(chalk.cyan('  claude "/vm0-cli bootstrap"'));
  console.log();
}

export const bootClaudeCommand = new Command()
  .name("boot-claude")
  .description("Set up Claude Code with VM0 integration")
  .action(async () => {
    // Check Claude CLI is installed
    if (!checkClaudeInstalled()) {
      console.error(chalk.red("✗ Claude CLI not found"));
      console.log();
      console.log("Please install Claude Code first:");
      console.log(chalk.cyan("  npm install -g @anthropic-ai/claude-code"));
      process.exit(1);
    }

    // Step 1: Ensure marketplace
    if (!(await ensureMarketplace())) {
      process.exit(1);
    }

    // Step 2: Ensure plugin
    if (!(await ensurePlugin())) {
      process.exit(1);
    }

    // Step 3: Ensure VM0 auth
    if (!(await ensureVm0Auth())) {
      process.exit(1);
    }

    // Step 4: Ensure Claude token
    if (!(await ensureClaudeToken())) {
      process.exit(1);
    }

    // Step 5: Print launch command
    printLaunchCommand();
  });
