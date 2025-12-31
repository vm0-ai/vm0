import { Command } from "commander";
import {
  loadConfig,
  validateFirecrackerPaths,
  type RunnerConfig,
} from "../lib/config.js";
import {
  registerRunner,
  pollForJob,
  claimJob,
  completeJob,
  type ExecutionContext,
} from "../lib/api.js";
import { getToken } from "../lib/token.js";
import { executeJob as executeJobInVM } from "../lib/executor.js";
import {
  checkNetworkPrerequisites,
  setupBridge,
} from "../lib/firecracker/network.js";

// Track active jobs for concurrency management
const activeJobs = new Set<string>();

/**
 * Execute a claimed job in stub mode (no VM, direct complete)
 * Used for testing runner infrastructure without full Firecracker setup
 */
async function executeJobStub(context: ExecutionContext): Promise<void> {
  console.log(`  [STUB] Executing job ${context.runId}...`);
  console.log(`  [STUB] Prompt: ${context.prompt.substring(0, 100)}...`);

  // Simulate brief execution
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Report completion to server
  try {
    const result = await completeJob(context, 0);
    console.log(`  [STUB] Job ${context.runId} reported as ${result.status}`);
  } catch (err) {
    console.error(
      `  [STUB] Failed to report job ${context.runId} completion:`,
      err instanceof Error ? err.message : "Unknown error",
    );
  }
}

/**
 * Execute a claimed job in a Firecracker VM
 */
async function executeJobFirecracker(
  context: ExecutionContext,
  config: RunnerConfig,
): Promise<void> {
  console.log(`  Executing job ${context.runId}...`);
  console.log(`  Prompt: ${context.prompt.substring(0, 100)}...`);
  console.log(`  Compose version: ${context.agentComposeVersionId}`);

  try {
    // Execute in Firecracker VM
    const result = await executeJobInVM(context, config);

    console.log(
      `  Job ${context.runId} execution completed with exit code ${result.exitCode}`,
    );

    // The executor's bootstrap script calls the complete API directly
    // But if execution fails before that, we need to report it ourselves
    if (result.exitCode !== 0 && result.error) {
      console.log(`  Job ${context.runId} failed: ${result.error}`);
    }
  } catch (err) {
    const error =
      err instanceof Error ? err.message : "Unknown execution error";
    console.error(`  Job ${context.runId} execution failed: ${error}`);

    // Report failure to server if VM execution failed before bootstrap
    try {
      const result = await completeJob(context, 1, error);
      console.log(`  Job ${context.runId} reported as ${result.status}`);
    } catch (reportErr) {
      console.error(
        `  Failed to report job ${context.runId} completion:`,
        reportErr instanceof Error ? reportErr.message : "Unknown error",
      );
    }
  }
}

/**
 * Execute a claimed job (dispatches to stub or Firecracker based on config)
 */
async function executeJob(
  context: ExecutionContext,
  config: RunnerConfig,
): Promise<void> {
  if (config.sandbox.stub_mode) {
    return executeJobStub(context);
  }
  return executeJobFirecracker(context, config);
}

export const startCommand = new Command("start")
  .description("Start the runner")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .option("--api-url <url>", "VM0 API URL")
  .option("--dry-run", "Validate config without starting")
  .action(
    async (options: {
      config: string;
      apiUrl?: string;
      dryRun?: boolean;
    }): Promise<void> => {
      try {
        // Load and validate config
        const config = loadConfig(options.config);

        // Validate firecracker paths exist
        validateFirecrackerPaths(config.firecracker);

        console.log("Config valid");

        if (options.dryRun) {
          console.log(JSON.stringify(config, null, 2));
          process.exit(0);
        }

        // Skip network setup in stub mode
        if (!config.sandbox.stub_mode) {
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
        } else {
          console.log("Stub mode enabled - skipping Firecracker setup");
        }

        // Check authentication
        const token = await getToken();
        if (!token) {
          console.error(
            "Error: Not authenticated. Run 'vm0-runner setup' first.",
          );
          process.exit(1);
        }

        // Register runner with server
        console.log(
          `Registering runner '${config.name}' for group '${config.group}'...`,
        );
        const runner = await registerRunner(config.name, config.group);
        console.log(`Runner registered: ${runner.id}`);

        // Start polling loop
        console.log("Starting polling loop...");
        console.log(`Max concurrent jobs: ${config.sandbox.max_concurrent}`);
        console.log("Press Ctrl+C to stop");
        console.log("");

        // Handle graceful shutdown
        let running = true;
        process.on("SIGINT", () => {
          console.log("\nShutting down...");
          running = false;
        });
        process.on("SIGTERM", () => {
          console.log("\nShutting down...");
          running = false;
        });

        // Main polling loop
        while (running) {
          // Check concurrency limit
          if (activeJobs.size >= config.sandbox.max_concurrent) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }

          try {
            // Poll for pending jobs
            const job = await pollForJob(config.group);

            if (job) {
              console.log(`Found job: ${job.runId}`);

              // Claim the job
              try {
                const context = await claimJob(job.runId, runner.id);
                console.log(`Claimed job: ${context.runId}`);

                // Track and execute in background
                activeJobs.add(context.runId);
                executeJob(context, config)
                  .catch((error) => {
                    console.error(
                      `Job ${context.runId} failed:`,
                      error instanceof Error ? error.message : "Unknown error",
                    );
                  })
                  .finally(() => {
                    activeJobs.delete(context.runId);
                  });
              } catch (error) {
                // Job was claimed by another runner, continue polling
                console.log(
                  `Could not claim job ${job.runId}:`,
                  error instanceof Error ? error.message : "Unknown error",
                );
              }
            }
          } catch (error) {
            console.error(
              "Polling error:",
              error instanceof Error ? error.message : "Unknown error",
            );
            // Wait before retrying on error
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }

        // Wait for active jobs to complete
        if (activeJobs.size > 0) {
          console.log(
            `Waiting for ${activeJobs.size} active job(s) to complete...`,
          );
          while (activeJobs.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        console.log("Runner stopped");
        process.exit(0);
      } catch (error) {
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error("An unknown error occurred");
        }
        process.exit(1);
      }
    },
  );
