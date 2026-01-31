import type { RunnerConfig } from "../config.js";
import { dataPaths } from "../paths.js";
import {
  checkNetworkPrerequisites,
  setupBridge,
  cleanupOrphanedProxyRules,
  flushBridgeArpCache,
  setupCIDRProxyRules,
  cleanupCIDRProxyRules,
} from "../firecracker/network.js";
import { cleanupOrphanedAllocations } from "../firecracker/ip-pool.js";
import {
  initOverlayPool,
  cleanupOverlayPool,
} from "../firecracker/overlay-pool.js";
import { initTapPool, cleanupTapPool } from "../firecracker/tap-pool.js";
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
  await acquireRunnerLock();

  // Check network prerequisites
  const networkCheck = checkNetworkPrerequisites();
  if (!networkCheck.ok) {
    logger.error("Network prerequisites not met:");
    for (const error of networkCheck.errors) {
      logger.error(`  - ${error}`);
    }
    process.exit(1);
  }

  // Set up bridge network
  logger.log("Setting up network bridge...");
  await setupBridge();

  // Flush bridge ARP cache to clear stale entries from previous runs
  // This prevents routing issues when IPs are reused with different MACs
  logger.log("Flushing bridge ARP cache...");
  await flushBridgeArpCache();

  // Clean up orphaned proxy rules from previous runs
  // This handles rules left behind after crashes or SIGKILL
  logger.log("Cleaning up orphaned proxy rules...");
  await cleanupOrphanedProxyRules(config.name);

  // Clean up orphaned IP allocations from previous runs
  // This reconciles the IP registry with actual TAP devices
  logger.log("Cleaning up orphaned IP allocations...");
  await cleanupOrphanedAllocations();

  // Initialize overlay pool for faster VM boot
  // Pre-creates sparse ext4 overlay files that can be acquired instantly
  logger.log("Initializing overlay pool...");
  await initOverlayPool({
    size: config.sandbox.max_concurrent + 2,
    replenishThreshold: config.sandbox.max_concurrent,
    poolDir: dataPaths.overlayPool(config.data_dir),
  });

  // Initialize TAP pool for faster VM boot
  // Pre-creates TAP devices attached to bridge for instant acquisition
  logger.log("Initializing TAP pool...");
  await initTapPool({
    name: config.name,
    size: config.sandbox.max_concurrent + 2,
    replenishThreshold: config.sandbox.max_concurrent,
  });

  // Initialize proxy for network security mode
  // The proxy is always started but only used when experimentalFirewall is enabled
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

    // Set up CIDR-based proxy rules for all VMs
    // This redirects all VM traffic (172.16.0.0/24) to the proxy at startup
    // The proxy handles unregistered VMs by passing traffic through
    logger.log("Setting up CIDR proxy rules...");
    await setupCIDRProxyRules(config.proxy.port);
  } catch (err) {
    logger.log(
      `Network proxy not available: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    logger.log(
      "Jobs with experimentalFirewall enabled will run without network interception",
    );
  }

  return { proxyEnabled, proxyPort: config.proxy.port };
}

/**
 * Clean up runner resources: proxy and CIDR rules
 * Each step is isolated so failures don't prevent subsequent cleanup
 */
export async function cleanupEnvironment(
  resources: RunnerResources,
): Promise<void> {
  const errors: Error[] = [];

  // Cleanup CIDR proxy rules first
  if (resources.proxyEnabled) {
    try {
      logger.log("Cleaning up CIDR proxy rules...");
      await cleanupCIDRProxyRules(resources.proxyPort);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);
      logger.error(`Failed to cleanup CIDR proxy rules: ${error.message}`);
    }
  }

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

  // Cleanup overlay pool
  try {
    cleanupOverlayPool();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    errors.push(error);
    logger.error(`Failed to cleanup overlay pool: ${error.message}`);
  }

  // Cleanup TAP pool
  try {
    cleanupTapPool();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    errors.push(error);
    logger.error(`Failed to cleanup TAP pool: ${error.message}`);
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
