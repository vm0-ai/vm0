import type { RunnerConfig } from "../config.js";
import { runnerPaths } from "../paths.js";
import { checkNetworkPrerequisites } from "../firecracker/network.js";
import { execCommand } from "../utils/exec.js";
import {
  initOverlayPool,
  cleanupOverlayPool,
} from "../firecracker/overlay-pool.js";
import { initNetnsPool, cleanupNetnsPool } from "../firecracker/netns-pool.js";
import {
  initProxyManager,
  initVMRegistry,
  getProxyManager,
} from "../proxy/index.js";
import { acquireRunnerLock, releaseRunnerLock } from "./runner-lock.js";
import type { RunnerResources } from "./types.js";
import { createLogger } from "../logger.js";

const logger = createLogger("Runner");

interface SetupOptions {
  config: RunnerConfig;
}

/**
 * Initialize runner environment: network and proxy
 */
export async function setupEnvironment(
  options: SetupOptions,
): Promise<RunnerResources> {
  const { config } = options;

  // Acquire runner lock first - ensures only one runner per device
  acquireRunnerLock();

  // Check network prerequisites
  const networkCheck = checkNetworkPrerequisites();
  if (!networkCheck.ok) {
    logger.error("Network prerequisites not met:");
    for (const error of networkCheck.errors) {
      logger.error(`  - ${error}`);
    }
    process.exit(1);
  }

  // Initialize proxy for network security mode
  // The proxy is always started but only used when experimentalFirewall is enabled
  // Must initialize BEFORE netns pool so we know the proxy port
  logger.log("Initializing network proxy...");
  initVMRegistry();
  const proxyManager = initProxyManager({
    apiUrl: config.server.url,
    port: config.proxy.port,
    caDir: config.proxy.ca_dir,
  });

  // Try to start proxy - if mitmproxy is not installed, continue without it
  let proxyEnabled = false;
  try {
    await proxyManager.start();
    proxyEnabled = true;
    logger.log("Network proxy initialized successfully");
  } catch (err) {
    logger.log(
      `Network proxy not available: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    logger.log(
      "Jobs with experimentalFirewall enabled will run without network interception",
    );
  }

  // Initialize overlay pool for faster VM boot
  // Pre-creates overlay files that can be acquired instantly
  // - With snapshot: copies golden overlay (preserves snapshot disk state)
  // - Without snapshot: creates empty ext4 files
  logger.log("Initializing overlay pool...");
  const snapshotConfig = config.firecracker.snapshot;
  await initOverlayPool({
    size: config.sandbox.max_concurrent + 2,
    replenishThreshold: config.sandbox.max_concurrent,
    poolDir: runnerPaths.overlayPool(config.base_dir),
    createFile: snapshotConfig
      ? (filePath) =>
          execCommand(
            `cp --sparse=always "${snapshotConfig.overlay}" "${filePath}"`,
            false,
          ).then(() => {})
      : undefined,
  });

  // Initialize network namespace pool for faster VM boot
  // Pre-creates isolated namespaces with TAP devices and routing
  // Proxy rules are set up per-namespace if proxyPort is provided
  logger.log("Initializing namespace pool...");
  await initNetnsPool({
    name: config.name,
    size: config.sandbox.max_concurrent + 2,
    proxyPort: proxyEnabled ? config.proxy.port : undefined,
  });

  return { proxyEnabled, proxyPort: config.proxy.port };
}

/**
 * Clean up runner resources: proxy, pools, and lock
 * Each step is isolated so failures don't prevent subsequent cleanup
 */
export async function cleanupEnvironment(
  resources: RunnerResources,
): Promise<void> {
  const errors: Error[] = [];

  // Cleanup proxy
  if (resources.proxyEnabled) {
    try {
      logger.log("Stopping network proxy...");
      await getProxyManager().stop();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);
      logger.error(`Failed to stop network proxy: ${error.message}`);
    }
  }

  // Cleanup namespace pool (includes iptables rules cleanup)
  try {
    logger.log("Cleaning up namespace pool...");
    await cleanupNetnsPool();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    errors.push(error);
    logger.error(`Failed to cleanup namespace pool: ${error.message}`);
  }

  // Cleanup overlay pool
  try {
    cleanupOverlayPool();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    errors.push(error);
    logger.error(`Failed to cleanup overlay pool: ${error.message}`);
  }

  // Release runner lock last
  try {
    releaseRunnerLock();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    errors.push(error);
    logger.error(`Failed to release runner lock: ${error.message}`);
  }

  if (errors.length > 0) {
    logger.error(`Cleanup completed with ${errors.length} error(s)`);
  }
}
