import { Command } from "commander";
import crypto from "crypto";
import { loadDebugConfig, validateFirecrackerPaths } from "../lib/config.js";
import { executeJob } from "../lib/executor/index.js";
import type { ExecutionContext } from "../lib/api.js";
import { checkNetworkPrerequisites } from "../lib/firecracker/network.js";
import {
  initOverlayPool,
  cleanupOverlayPool,
} from "../lib/firecracker/overlay-pool.js";
import {
  initNetnsPool,
  cleanupNetnsPool,
} from "../lib/firecracker/netns-pool.js";
import { initVMRegistry } from "../lib/proxy/index.js";
import { Timer } from "../lib/utils/timing.js";
import { setGlobalLogger } from "../lib/logger.js";
import { runnerPaths } from "../lib/paths.js";
import { execCommand } from "../lib/utils/exec.js";

interface BenchmarkOptions {
  config: string;
  workingDir: string;
  agentType: string;
}

/**
 * Create a local ExecutionContext for benchmark mode
 * In benchmark mode, the prompt is executed directly as a bash command (run-agent.py is skipped)
 */
function createBenchmarkContext(
  prompt: string,
  options: BenchmarkOptions,
): ExecutionContext {
  return {
    runId: crypto.randomUUID(),
    prompt,
    agentComposeVersionId: "benchmark-local",
    vars: null,
    secretNames: null,
    checkpointId: null,
    sandboxToken: "benchmark-token-not-used",
    workingDir: options.workingDir,
    storageManifest: null,
    environment: null,
    resumeSession: null,
    secretValues: null,
    cliAgentType: options.agentType,
    // Enable firewall and MITM by default for benchmark to test proxy flow
    experimentalFirewall: {
      enabled: true,
      experimental_mitm: true,
    },
  };
}

export const benchmarkCommand = new Command("benchmark")
  .description(
    "Run a VM performance benchmark (executes bash command directly)",
  )
  .argument("<prompt>", "The bash command to execute in the VM")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .option("--working-dir <path>", "Working directory in VM", "/home/user")
  .option("--agent-type <type>", "Agent type", "claude-code")
  .action(async (prompt: string, options: BenchmarkOptions): Promise<void> => {
    const timer = new Timer();

    // Set global logger to use Timer.log for all modules
    setGlobalLogger(timer.log.bind(timer));

    let exitCode = 1;
    let poolsInitialized = false;

    try {
      // Load config
      timer.log("Loading configuration...");
      const config = loadDebugConfig(options.config);

      validateFirecrackerPaths(config.firecracker);

      // Check network prerequisites
      timer.log("Checking network prerequisites...");
      const networkCheck = checkNetworkPrerequisites();
      if (!networkCheck.ok) {
        console.error("Network prerequisites not met:");
        for (const error of networkCheck.errors) {
          console.error(`  - ${error}`);
        }
        process.exit(1);
      }

      // Initialize VM registry for proxy IP → run mapping
      initVMRegistry(runnerPaths.vmRegistry(config.base_dir));

      // Initialize pools for VM resources
      // - With snapshot: copies golden overlay (preserves snapshot disk state)
      // - Without snapshot: creates empty ext4 files
      timer.log("Initializing pools...");
      const snapshotConfig = config.firecracker.snapshot;
      await initOverlayPool({
        size: 2,
        replenishThreshold: 1,
        poolDir: runnerPaths.overlayPool(config.base_dir),
        createFile: snapshotConfig
          ? (filePath) =>
              execCommand(
                `cp --sparse=always "${snapshotConfig.overlay}" "${filePath}"`,
                false,
              ).then(() => {})
          : undefined,
      });
      await initNetnsPool({ name: config.name, size: 2 });
      poolsInitialized = true;

      // Create benchmark execution context
      timer.log(`Executing command: ${prompt}`);
      const context = createBenchmarkContext(prompt, options);

      // Execute job in benchmark mode (runs bash command directly, skips run-agent.py)
      const result = await executeJob(context, config, {
        benchmarkMode: true,
      });

      // Output results
      timer.log(`Exit code: ${result.exitCode}`);
      if (result.error) {
        timer.log(`Error: ${result.error}`);
      }
      timer.log(`Total time: ${timer.totalSeconds().toFixed(1)}s`);

      exitCode = result.exitCode;
    } catch (error) {
      timer.log(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      if (poolsInitialized) {
        await cleanupNetnsPool();
        cleanupOverlayPool();
      }
    }

    process.exit(exitCode);
  });
