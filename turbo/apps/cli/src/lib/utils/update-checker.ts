import { spawn } from "child_process";
import chalk from "chalk";

const PACKAGE_NAME = "@vm0/cli";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const TIMEOUT_MS = 5000;

type PackageManager = "npm" | "pnpm" | "bun" | "yarn" | "unknown";

/**
 * Detect which package manager was used to install the CLI
 * by checking the executable path for known package manager patterns.
 * Returns "unknown" if no known pattern is matched.
 */
function detectPackageManager(): PackageManager {
  const execPath = process.argv[1] ?? "";

  // Check for pnpm (supported for auto-upgrade)
  if (execPath.includes("pnpm")) {
    return "pnpm";
  }

  // Check for bun (unsupported - manual upgrade only)
  if (execPath.includes("/.bun/") || execPath.includes("/bun/")) {
    return "bun";
  }

  // Check for yarn (unsupported - manual upgrade only)
  if (execPath.includes("/.yarn/") || execPath.includes("/yarn/")) {
    return "yarn";
  }

  // Check for npm (supported for auto-upgrade)
  // Common npm paths: /usr/local/, nvm, fnm, volta, nodenv, n, or node_modules
  if (
    execPath.includes("/usr/local/") ||
    execPath.includes("/.nvm/") ||
    execPath.includes("/.fnm/") ||
    execPath.includes("/.volta/") ||
    execPath.includes("/.nodenv/") ||
    execPath.includes("/.n/") ||
    execPath.includes("/node_modules/") ||
    execPath.includes("\\npm\\") || // Windows: AppData\Roaming\npm
    execPath.includes("\\nodejs\\") // Windows: Program Files\nodejs
  ) {
    return "npm";
  }

  // Unknown package manager - don't assume npm
  return "unknown";
}

/**
 * Check if the package manager supports auto-upgrade
 */
function isAutoUpgradeSupported(pm: PackageManager): pm is "npm" | "pnpm" {
  return pm === "npm" || pm === "pnpm";
}

/**
 * Get the manual upgrade command for a package manager
 */
function getManualUpgradeCommand(pm: PackageManager): string {
  switch (pm) {
    case "bun":
      return `bun add -g ${PACKAGE_NAME}@latest`;
    case "yarn":
      return `yarn global add ${PACKAGE_NAME}@latest`;
    case "pnpm":
      return `pnpm add -g ${PACKAGE_NAME}@latest`;
    case "npm":
      return `npm install -g ${PACKAGE_NAME}@latest`;
    case "unknown":
      return `npm install -g ${PACKAGE_NAME}@latest`;
  }
}

/**
 * Escape a string for use in shell command display
 * Uses double quotes and escapes internal double quotes
 */
function escapeForShell(str: string): string {
  return `"${str.replace(/"/g, '\\"')}"`;
}

/**
 * Build the re-run command string
 */
function buildRerunCommand(prompt: string | undefined): string {
  if (prompt) {
    return `vm0 cook ${escapeForShell(prompt)}`;
  }
  return "vm0 cook";
}

/**
 * Fetch the latest version of the package from npm registry
 * Returns null if the request fails or times out
 */
async function getLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Execute package manager upgrade command
 * - npm: npm install -g @vm0/cli@latest
 * - pnpm: pnpm add -g @vm0/cli@latest
 * Returns true on success, false on failure
 */
function performUpgrade(packageManager: "npm" | "pnpm"): Promise<boolean> {
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
 * Returns false if caller should continue (no update needed, check failed, or unsupported PM)
 */
export async function checkAndUpgrade(
  currentVersion: string,
  prompt: string | undefined,
): Promise<boolean> {
  const latestVersion = await getLatestVersion();

  // If we couldn't check, warn and continue
  if (latestVersion === null) {
    console.log(chalk.yellow("⚠ Could not check for updates"));
    console.log();
    return false;
  }

  // If already on latest, continue
  if (latestVersion === currentVersion) {
    return false;
  }

  // New version available - show beta notice
  console.log(chalk.yellow("vm0 is currently in beta."));
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

  // Check package manager
  const packageManager = detectPackageManager();

  // For unsupported package managers, show manual upgrade instructions and continue
  if (!isAutoUpgradeSupported(packageManager)) {
    if (packageManager === "unknown") {
      console.log(
        chalk.yellow("Could not detect your package manager for auto-upgrade."),
      );
    } else {
      console.log(
        chalk.yellow(`Auto-upgrade is not supported for ${packageManager}.`),
      );
    }
    console.log(chalk.yellow("Please upgrade manually:"));
    console.log(chalk.cyan(`  ${getManualUpgradeCommand(packageManager)}`));
    console.log();
    return false;
  }

  // Perform upgrade for supported package managers (npm, pnpm)
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
  console.error();
  console.error(chalk.red("✗ Upgrade failed. Please run manually:"));
  console.error(chalk.cyan(`  ${getManualUpgradeCommand(packageManager)}`));
  console.error();
  console.error("Then re-run:");
  console.error(chalk.cyan(`  ${buildRerunCommand(prompt)}`));
  return true;
}

/**
 * Perform silent upgrade after command completion.
 * - Checks for new version
 * - Spawns upgrade process
 * - Waits up to 5s for result
 * - Shows whisper message only on failure
 *
 * @param currentVersion - Current CLI version
 * @returns Promise that resolves when upgrade check/attempt is complete
 */
export async function silentUpgradeAfterCommand(
  currentVersion: string,
): Promise<void> {
  // Check for new version
  const latestVersion = await getLatestVersion();

  // If check failed or already on latest, return silently
  if (latestVersion === null || latestVersion === currentVersion) {
    return;
  }

  // Check package manager
  const packageManager = detectPackageManager();

  // For unsupported package managers, return silently (no whisper)
  if (!isAutoUpgradeSupported(packageManager)) {
    return;
  }

  // Spawn upgrade process and wait for result with timeout
  const isWindows = process.platform === "win32";
  const command = isWindows ? `${packageManager}.cmd` : packageManager;
  const args =
    packageManager === "pnpm"
      ? ["add", "-g", `${PACKAGE_NAME}@latest`]
      : ["install", "-g", `${PACKAGE_NAME}@latest`];

  const upgradeResult = await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      stdio: "pipe", // Capture output instead of inheriting
      shell: isWindows,
      detached: !isWindows, // Detach on non-Windows
      windowsHide: true,
    });

    // Set up timeout - kill child process to prevent orphaned processes
    const timeoutId = setTimeout(() => {
      child.kill();
      resolve(false); // Timeout = failure
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve(code === 0);
    });

    child.on("error", () => {
      clearTimeout(timeoutId);
      resolve(false);
    });
  });

  // Show whisper message only on failure
  if (!upgradeResult) {
    console.log(
      chalk.yellow(
        `\n⚠ vm0 auto upgrade failed. Please run: ${getManualUpgradeCommand(packageManager)}`,
      ),
    );
  }
}
