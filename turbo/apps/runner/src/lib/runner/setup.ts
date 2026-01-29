import type { RunnerConfig } from "../config.js";
import {
  checkNetworkPrerequisites,
  setupBridge,
  cleanupOrphanedProxyRules,
  flushBridgeArpCache,
} from "../firecracker/network.js";
import { cleanupOrphanedAllocations } from "../firecracker/ip-pool.js";
import {
  initProxyManager,
  initVMRegistry,
  getProxyManager,
} from "../proxy/index.js";
import type { RunnerResources } from "./types.js";

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

  // Check network prerequisites
  const networkCheck = checkNetworkPrerequisites();
  if (!networkCheck.ok) {
    console.error("Network prerequisites not met:");
    for (const error of networkCheck.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  // Set up bridge network
  console.log("Setting up network bridge...");
  await setupBridge();

  // Flush bridge ARP cache to clear stale entries from previous runs
  // This prevents routing issues when IPs are reused with different MACs
  console.log("Flushing bridge ARP cache...");
  await flushBridgeArpCache();

  // Clean up orphaned proxy rules from previous runs
  // This handles rules left behind after crashes or SIGKILL
  console.log("Cleaning up orphaned proxy rules...");
  await cleanupOrphanedProxyRules(config.name);

  // Clean up orphaned IP allocations from previous runs
  // This reconciles the IP registry with actual TAP devices
  console.log("Cleaning up orphaned IP allocations...");
  await cleanupOrphanedAllocations();

  // Initialize proxy for network security mode
  // The proxy is always started but only used when experimentalFirewall is enabled
  console.log("Initializing network proxy...");
  initVMRegistry();
  const proxyManager = initProxyManager({
    apiUrl: config.server.url,
    port: config.proxy.port,
    caDir: config.proxy.ca_dir,
  });

  // Try to start proxy - if mitmproxy is not installed, continue without it
  // Note: Per-VM iptables rules are set up in executor.ts when a job with
  // experimentalFirewall is executed, not globally here.
  let proxyEnabled = false;
  try {
    await proxyManager.start();
    proxyEnabled = true;
    console.log("Network proxy initialized successfully");
  } catch (err) {
    console.warn(
      `Network proxy not available: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    console.warn(
      "Jobs with experimentalFirewall enabled will run without network interception",
    );
  }

  return { proxyEnabled };
}

/**
 * Clean up runner resources: proxy
 */
export async function cleanupEnvironment(
  resources: RunnerResources,
): Promise<void> {
  // Cleanup proxy
  if (resources.proxyEnabled) {
    console.log("Stopping network proxy...");
    await getProxyManager().stop();
  }
}
