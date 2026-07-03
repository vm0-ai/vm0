import type { ChildProcess } from "child_process";
import chalk from "chalk";
import { safeSpawn } from "./spawn";

const PACKAGE_NAME = "@vm0/cli";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const TIMEOUT_MS = 5000;

type PackageManager = "npm" | "pnpm" | "bun" | "yarn" | "unknown";

/**
 * Internal state for pending upgrade process
 */
interface UpgradeHandle {
  promise: Promise<boolean>;
  child: ChildProcess;
  packageManager: "npm" | "pnpm";
}

// Module-level state for pending upgrade
let pendingUpgrade: UpgradeHandle | null = null;

/**
 * Detect which package manager was used to install the CLI
 * by checking the executable path for known package manager patterns.
 * Returns "unknown" if no known pattern is matched.
 */
export function detectPackageManager(): PackageManager {
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
  // Common npm paths: Homebrew, nvm, fnm, volta, nodenv, n, or node_modules
  if (
    execPath.includes("/usr/local/") || // Homebrew on Intel Mac
    execPath.includes("/opt/homebrew/") || // Homebrew on arm64 Mac
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
export function isAutoUpgradeSupported(
  pm: PackageManager,
): pm is "npm" | "pnpm" {
  return pm === "npm" || pm === "pnpm";
}

/**
 * Get the manual upgrade command for a package manager
 */
export function getManualUpgradeCommand(pm: PackageManager): string {
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
 * Fetch the latest version of the package from npm registry
 * Returns null if the request fails or times out
 */
export async function getLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      return controller.abort();
    }, TIMEOUT_MS);

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
export function performUpgrade(
  packageManager: "npm" | "pnpm",
): Promise<boolean> {
  return new Promise((resolve) => {
    const args =
      packageManager === "pnpm"
        ? ["add", "-g", `${PACKAGE_NAME}@latest`]
        : ["install", "-g", `${PACKAGE_NAME}@latest`];

    const child = safeSpawn(packageManager, args, {
      stdio: "inherit",
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
 * Start silent upgrade in background.
 * Call this at command start. Does NOT block after spawning.
 * The upgrade runs in parallel with command execution.
 *
 * @param currentVersion - Current CLI version
 * @returns Promise that resolves after starting upgrade (or determining no upgrade needed)
 */
export async function startSilentUpgrade(
  currentVersion: string,
): Promise<void> {
  // Reset any previous state
  pendingUpgrade = null;

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

  // Spawn upgrade process (don't wait for completion)
  const isWindows = process.platform === "win32";
  const args =
    packageManager === "pnpm"
      ? ["add", "-g", `${PACKAGE_NAME}@latest`]
      : ["install", "-g", `${PACKAGE_NAME}@latest`];

  const child = safeSpawn(packageManager, args, {
    stdio: "pipe",
    detached: !isWindows,
    windowsHide: true,
  });

  const promise = new Promise<boolean>((resolve) => {
    child.on("close", (code) => {
      return resolve(code === 0);
    });
    child.on("error", () => {
      return resolve(false);
    });
  });

  pendingUpgrade = { promise, child, packageManager };
}

/**
 * Wait for pending upgrade to complete and show warning if failed.
 * Call this at command end.
 *
 * @param timeout - Max time to wait if upgrade still running (ms)
 * @returns Promise that resolves when upgrade completes or times out
 */
export async function waitForSilentUpgrade(
  timeout: number = TIMEOUT_MS,
): Promise<void> {
  if (!pendingUpgrade) {
    return;
  }

  const { promise, child, packageManager } = pendingUpgrade;
  pendingUpgrade = null; // Clear state

  // Race between upgrade completion and timeout
  const result = await Promise.race([
    promise,
    new Promise<false>((resolve) => {
      setTimeout(() => {
        child.kill();
        resolve(false);
      }, timeout);
    }),
  ]);

  // Show whisper message only on failure
  if (!result) {
    console.log(
      chalk.yellow(
        `\n⚠ vm0 auto upgrade failed. Please run: ${getManualUpgradeCommand(packageManager)}`,
      ),
    );
  }
}
