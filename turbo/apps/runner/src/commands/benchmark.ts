import { Command } from "commander";
import crypto from "crypto";
import { loadDebugConfig, validateFirecrackerPaths } from "../lib/config.js";
import { executeJob } from "../lib/executor.js";
import type { ExecutionContext } from "../lib/api.js";
import {
  checkNetworkPrerequisites,
  setupBridge,
} from "../lib/firecracker/network.js";
import { Timer } from "../lib/timing.js";

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

      // Set up bridge network
      timer.log("Setting up network bridge...");
      await setupBridge();

      // Create benchmark execution context
      timer.log(`Executing command: ${prompt}`);
      const context = createBenchmarkContext(prompt, options);

      // Execute job in benchmark mode (runs bash command directly, skips run-agent.py)
      const result = await executeJob(context, config, {
        benchmarkMode: true,
        logger: timer.log.bind(timer),
      });

      // Output results
      timer.log(`Exit code: ${result.exitCode}`);
      if (result.error) {
        timer.log(`Error: ${result.error}`);
      }
      timer.log(`Total time: ${timer.totalSeconds().toFixed(1)}s`);

      process.exit(result.exitCode);
    } catch (error) {
      timer.log(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      process.exit(1);
    }
  });
