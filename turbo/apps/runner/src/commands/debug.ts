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

interface DebugOptions {
  config: string;
  workingDir: string;
  agentType: string;
}

/**
 * Create a local ExecutionContext for debug mode
 * Sets USE_MOCK_CLAUDE=true so mock-claude executes the prompt as bash
 */
function createDebugContext(
  prompt: string,
  options: DebugOptions,
): ExecutionContext {
  return {
    runId: crypto.randomUUID(),
    prompt,
    agentComposeVersionId: "debug-local",
    vars: null,
    secretNames: null,
    checkpointId: null,
    sandboxToken: "debug-token-not-used",
    workingDir: options.workingDir,
    storageManifest: null,
    environment: {
      USE_MOCK_CLAUDE: "true",
    },
    resumeSession: null,
    secretValues: null,
    cliAgentType: options.agentType,
  };
}

export const debugCommand = new Command("debug")
  .description("Run a local test job in a VM (uses mock-claude)")
  .argument("<prompt>", "The prompt/command to execute")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .option("--working-dir <path>", "Working directory in VM", "/home/user")
  .option("--agent-type <type>", "Agent type", "claude-code")
  .action(async (prompt: string, options: DebugOptions): Promise<void> => {
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

      // Create debug execution context
      timer.log(`Executing prompt: ${prompt}`);
      const context = createDebugContext(prompt, options);

      // Execute job in dev mode
      const result = await executeJob(context, config, { devMode: true });

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
