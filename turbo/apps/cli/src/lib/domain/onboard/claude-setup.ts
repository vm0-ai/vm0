import { spawn } from "child_process";
import chalk from "chalk";

// Marketplace and plugin identifiers
const MARKETPLACE_NAME = "vm0-skills";
const MARKETPLACE_REPO = "vm0-ai/vm0-skills";
const PLUGIN_ID = "vm0@vm0-skills";

// Primary skill for user prompt (vm0-agent)
export const PRIMARY_SKILL_NAME = "vm0-agent";

export type PluginScope = "user" | "project";

interface ClaudeCommandResult {
  success: boolean;
  output: string;
  error?: string;
}

interface MarketplaceInfo {
  name: string;
  source: string;
  repo: string;
  installLocation: string;
}

/**
 * Run a Claude CLI command and capture output
 */
async function runClaudeCommand(
  args: string[],
  cwd?: string,
): Promise<ClaudeCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      resolve({
        success: false,
        output: stdout,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr || undefined,
      });
    });
  });
}

/**
 * Handle installation error with user-friendly message and exit
 */
export function handlePluginError(error: unknown, context?: string): never {
  const displayContext = context ?? "Claude plugin";
  console.error(chalk.red(`✗ Failed to install ${displayContext}`));
  if (error instanceof Error) {
    console.error(chalk.red(`✗ ${error.message}`));
  }
  console.error(
    chalk.dim("Please ensure Claude CLI is installed and accessible."),
  );
  process.exit(1);
}

/**
 * Check if the VM0 skills marketplace is already added
 */
async function isMarketplaceInstalled(): Promise<boolean> {
  const result = await runClaudeCommand([
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);

  if (!result.success) {
    return false;
  }

  try {
    const marketplaces = JSON.parse(result.output) as MarketplaceInfo[];
    return marketplaces.some((m) => m.name === MARKETPLACE_NAME);
  } catch {
    return false;
  }
}

/**
 * Add the VM0 skills marketplace to Claude
 * @throws Error if command fails
 */
async function addMarketplace(): Promise<void> {
  const result = await runClaudeCommand([
    "plugin",
    "marketplace",
    "add",
    MARKETPLACE_REPO,
  ]);

  if (!result.success) {
    throw new Error(
      `Failed to add marketplace ${MARKETPLACE_REPO}: ${result.error ?? "unknown error"}`,
    );
  }
}

/**
 * Update the VM0 skills marketplace to get latest plugins
 * Logs warning on failure but does not throw - allows installation to proceed
 */
async function updateMarketplace(): Promise<void> {
  const result = await runClaudeCommand([
    "plugin",
    "marketplace",
    "update",
    MARKETPLACE_NAME,
  ]);

  if (!result.success) {
    console.warn(
      chalk.yellow(
        `Warning: Could not update marketplace: ${result.error ?? "unknown error"}`,
      ),
    );
  }
}

/**
 * Ensure the VM0 skills marketplace is available and up-to-date
 * Adds it if not installed, updates it if already present
 */
async function ensureMarketplace(): Promise<void> {
  const installed = await isMarketplaceInstalled();
  if (!installed) {
    await addMarketplace();
  } else {
    await updateMarketplace();
  }
}

interface InstallPluginResult {
  pluginId: string;
  scope: PluginScope;
}

/**
 * Install the VM0 plugin using Claude plugin system
 * @param scope - Installation scope (user or project)
 * @param cwd - Directory to run the command in (for project scope)
 * @throws Error if installation fails
 */
export async function installVm0Plugin(
  scope: PluginScope = "user",
  cwd?: string,
): Promise<InstallPluginResult> {
  // Ensure marketplace is available first
  await ensureMarketplace();

  // Install the plugin with specified scope
  const args = ["plugin", "install", PLUGIN_ID, "--scope", scope];
  const result = await runClaudeCommand(args, cwd);

  if (!result.success) {
    throw new Error(
      `Failed to install plugin ${PLUGIN_ID}: ${result.error ?? "unknown error"}`,
    );
  }

  return {
    pluginId: PLUGIN_ID,
    scope,
  };
}
