import { Command } from "commander";
import {
  loadConfig,
  validateFirecrackerPaths,
  type RunnerConfig,
} from "../lib/config.js";
import {
  pollForJob,
  claimJob,
  completeJob,
  type ExecutionContext,
} from "../lib/api.js";
import { executeJob as executeJobInVM } from "../lib/executor.js";
import {
  checkNetworkPrerequisites,
  setupBridge,
} from "../lib/firecracker/network.js";

// Track active jobs for concurrency management
const activeJobs = new Set<string>();

/**
 * Execute a claimed job in a Firecracker VM
 */
async function executeJob(
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
    // Let errors propagate - the caller's .catch() will handle them
    const result = await completeJob(config.server.url, context, 1, error);
    console.log(`  Job ${context.runId} reported as ${result.status}`);
  }
}

export const startCommand = new Command("start")
  .description("Start the runner")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(async (options: { config: string }): Promise<void> => {
    try {
      // Load and validate config
      const config = loadConfig(options.config);

      // Validate firecracker paths exist
      validateFirecrackerPaths(config.firecracker);

      console.log("Config valid");

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

      // Start polling loop
      console.log(
        `Starting runner '${config.name}' for group '${config.group}'...`,
      );
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

      // Track job completion promises for graceful shutdown
      const jobPromises = new Set<Promise<void>>();

      // Main polling loop
      while (running) {
        // Check concurrency limit - skip poll if at capacity
        if (activeJobs.size >= config.sandbox.max_concurrent) {
          // Wait for any job to complete before polling again
          if (jobPromises.size > 0) {
            await Promise.race(jobPromises);
          }
          continue;
        }

        try {
          // Poll for pending jobs
          const job = await pollForJob(config.server, config.group);

          if (!job) {
            // No job found, wait before polling again
            // Interval is configurable via sandbox.poll_interval_ms (default 5s)
            await new Promise((resolve) =>
              setTimeout(resolve, config.sandbox.poll_interval_ms),
            );
            continue;
          }

          console.log(`Found job: ${job.runId}`);

          // Claim the job
          try {
            const context = await claimJob(config.server, job.runId);
            console.log(`Claimed job: ${context.runId}`);

            // Track and execute in background
            activeJobs.add(context.runId);
            const jobPromise: Promise<void> = executeJob(context, config)
              .catch((error) => {
                console.error(
                  `Job ${context.runId} failed:`,
                  error instanceof Error ? error.message : "Unknown error",
                );
              })
              .finally(() => {
                activeJobs.delete(context.runId);
                jobPromises.delete(jobPromise);
              });
            jobPromises.add(jobPromise);
          } catch (error) {
            // Job was claimed by another runner, continue polling
            console.log(
              `Could not claim job ${job.runId}:`,
              error instanceof Error ? error.message : "Unknown error",
            );
          }
        } catch (error) {
          console.error(
            "Polling error:",
            error instanceof Error ? error.message : "Unknown error",
          );
          // Wait before retrying after error
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      // Wait for active jobs to complete
      if (jobPromises.size > 0) {
        console.log(
          `Waiting for ${jobPromises.size} active job(s) to complete...`,
        );
        await Promise.all(jobPromises);
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
  });
