import https from "https";
import { spawn } from "child_process";
import chalk from "chalk";

const PACKAGE_NAME = "@vm0/cli";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const TIMEOUT_MS = 5000;

type PackageManager = "npm" | "pnpm";

/**
 * Detect which package manager was used to install the CLI
 * by checking if the executable path contains "pnpm"
 */
export function detectPackageManager(): PackageManager {
  const execPath = process.argv[1] ?? "";
  if (execPath.includes("pnpm")) {
    return "pnpm";
  }
  return "npm";
}

/**
 * Escape a string for use in shell command display
 * Uses double quotes and escapes internal double quotes
 */
export function escapeForShell(str: string): string {
  return `"${str.replace(/"/g, '\\"')}"`;
}

/**
 * Build the re-run command string
 */
export function buildRerunCommand(prompt: string | undefined): string {
  if (prompt) {
    return `vm0 cook ${escapeForShell(prompt)}`;
  }
  return "vm0 cook";
}

/**
 * Fetch the latest version of the package from npm registry
 * Returns null if the request fails or times out
 */
export function getLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(NPM_REGISTRY_URL, (res) => {
      let data = "";

      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });

      res.on("end", () => {
        try {
          const json = JSON.parse(data) as { version?: string };
          resolve(json.version ?? null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => {
      resolve(null);
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Execute package manager upgrade command
 * - npm: npm install -g @vm0/cli@latest
 * - pnpm: pnpm add -g @vm0/cli@latest
 * Returns true on success, false on failure
 */
export function performUpgrade(
  packageManager: PackageManager,
): Promise<boolean> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const command = isWindows ? `${packageManager}.cmd` : packageManager;
    const args =
      packageManager === "pnpm"
        ? ["add", "-g", `${PACKAGE_NAME}@latest`]
        : ["install", "-g", `${PACKAGE_NAME}@latest`];

    const child = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows,
    });

    child.on("close", (code) => {
      resolve(code === 0);
    });

    child.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Check for updates and perform upgrade if needed
 * Returns true if caller should exit (upgrade happened or failed)
 * Returns false if caller should continue (no update needed or check failed)
 */
export async function checkAndUpgrade(
  currentVersion: string,
  prompt: string | undefined,
): Promise<boolean> {
  const latestVersion = await getLatestVersion();

  // If we couldn't check, warn and continue
  if (latestVersion === null) {
    console.log(chalk.yellow("Warning: Could not check for updates"));
    console.log();
    return false;
  }

  // If already on latest, continue
  if (latestVersion === currentVersion) {
    return false;
  }

  // New version available - show EA notice
  console.log(chalk.yellow("vm0 is currently in Early Access (EA)."));
  console.log(
    chalk.yellow(
      `Current version: ${currentVersion} -> Latest version: ${latestVersion}`,
    ),
  );
  console.log(
    chalk.yellow(
      "Please always use the latest version for best compatibility.",
    ),
  );
  console.log();

  // Perform upgrade
  const packageManager = detectPackageManager();
  console.log(`Upgrading via ${packageManager}...`);
  const success = await performUpgrade(packageManager);

  if (success) {
    console.log(chalk.green(`Upgraded to ${latestVersion}`));
    console.log();
    console.log("To continue, run:");
    console.log(chalk.cyan(`  ${buildRerunCommand(prompt)}`));
    return true;
  }

  // Upgrade failed - show manual instructions
  console.log();
  console.log(chalk.red("Upgrade failed. Please run manually:"));
  console.log(chalk.cyan(`  npm install -g ${PACKAGE_NAME}@latest`));
  console.log(chalk.dim("  # or"));
  console.log(chalk.cyan(`  pnpm add -g ${PACKAGE_NAME}@latest`));
  console.log();
  console.log("Then re-run:");
  console.log(chalk.cyan(`  ${buildRerunCommand(prompt)}`));
  return true;
}
