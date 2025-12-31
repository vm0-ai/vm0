import { Command } from "commander";
import { loadConfig, validateFirecrackerPaths } from "../lib/config.js";
import {
  registerRunner,
  pollForJob,
  claimJob,
  type ExecutionContext,
} from "../lib/api.js";
import { getToken } from "../lib/token.js";

// Track active jobs for concurrency management
const activeJobs = new Set<string>();

/**
 * Execute a claimed job
 * Currently a stub - Phase 4+ will add Firecracker VM execution
 */
async function executeJob(context: ExecutionContext): Promise<void> {
  console.log(`  Executing job ${context.runId}...`);
  console.log(`  Prompt: ${context.prompt.substring(0, 100)}...`);
  console.log(`  Compose version: ${context.agentComposeVersionId}`);

  // TODO: Phase 4+ - Firecracker VM execution
  // For now, just log that we would execute
  console.log("  [STUB] Job execution not yet implemented");
  console.log("  [STUB] Would start Firecracker VM and run agent");

  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`  Job ${context.runId} completed (stub)`);
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
                executeJob(context)
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
