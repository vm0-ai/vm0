import { Command } from "commander";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
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
import {
  initProxyManager,
  initVMRegistry,
  getProxyManager,
} from "../lib/proxy/index.js";
import {
  initMetrics,
  withRunnerTiming,
  flushMetrics,
  shutdownMetrics,
} from "../lib/metrics/index.js";

// Track active jobs for concurrency management
const activeJobs = new Set<string>();

// Runner mode for maintenance/drain support
type RunnerMode = "running" | "draining" | "stopped";

interface RunnerStatus {
  mode: RunnerMode;
  active_jobs: number;
  active_job_ids: string[];
  started_at: string;
  updated_at: string;
}

/**
 * Write runner status to a JSON file for external monitoring.
 * Used by deployment tools (Ansible) to track drain progress.
 */
function writeStatusFile(
  statusFilePath: string,
  mode: RunnerMode,
  startedAt: Date,
): void {
  const status: RunnerStatus = {
    mode,
    active_jobs: activeJobs.size,
    active_job_ids: Array.from(activeJobs),
    started_at: startedAt.toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
  } catch (err) {
    // Non-fatal: log and continue
    console.error(
      `Failed to write status file: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

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

      // Initialize metrics (from AXIOM_TOKEN env var)
      // Use explicit AXIOM_DATASET_SUFFIX if provided, otherwise infer from NODE_ENV
      const datasetSuffix =
        (process.env.AXIOM_DATASET_SUFFIX as "dev" | "prod" | undefined) ??
        (process.env.NODE_ENV === "production" ? "prod" : "dev");
      initMetrics({
        serviceName: "vm0-runner",
        runnerLabel: config.name,
        axiomToken: process.env.AXIOM_TOKEN,
        environment: datasetSuffix,
      });

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

      // Initialize proxy for network security mode
      // The proxy is always started but only used when experimentalFirewall is enabled
      console.log("Initializing network proxy...");
      initVMRegistry();
      const proxyManager = initProxyManager({
        apiUrl: config.server.url,
        port: config.proxy.port,
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

      // Status file for external monitoring (Ansible drain support)
      const statusFilePath = join(dirname(options.config), "status.json");
      const startedAt = new Date();

      // Use object to track mode - avoids TypeScript control flow issues with callbacks
      const state = { mode: "running" as RunnerMode };

      // Helper to update status file
      const updateStatus = (): void => {
        writeStatusFile(statusFilePath, state.mode, startedAt);
      };

      // Start polling loop
      console.log(
        `Starting runner '${config.name}' for group '${config.group}'...`,
      );
      console.log(`Max concurrent jobs: ${config.sandbox.max_concurrent}`);
      console.log(`Status file: ${statusFilePath}`);
      console.log("Press Ctrl+C to stop");
      console.log("");

      // Write initial status
      updateStatus();

      // Handle graceful shutdown
      let running = true;
      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        running = false;
        state.mode = "stopped";
        updateStatus();
      });
      process.on("SIGTERM", () => {
        console.log("\nShutting down...");
        running = false;
        state.mode = "stopped";
        updateStatus();
      });

      // Handle SIGUSR1 for maintenance/drain mode
      // When received, stop polling for new jobs but continue executing active jobs
      process.on("SIGUSR1", () => {
        if (state.mode === "running") {
          console.log("\n[Maintenance] Entering drain mode...");
          console.log(
            `[Maintenance] Active jobs: ${activeJobs.size} (will wait for completion)`,
          );
          state.mode = "draining";
          updateStatus();
        }
      });

      // Track job completion promises for graceful shutdown
      const jobPromises = new Set<Promise<void>>();

      // Main polling loop
      while (running) {
        // In drain mode, don't poll for new jobs - just wait for active jobs to complete
        if (state.mode === "draining") {
          if (activeJobs.size === 0) {
            console.log("[Maintenance] All jobs completed, exiting drain mode");
            running = false;
            break;
          }
          // Wait for any job to complete
          if (jobPromises.size > 0) {
            await Promise.race(jobPromises);
            updateStatus(); // Update status after job completes
          }
          continue;
        }

        // Check concurrency limit - skip poll if at capacity
        if (activeJobs.size >= config.sandbox.max_concurrent) {
          // Wait for any job to complete before polling again
          if (jobPromises.size > 0) {
            await Promise.race(jobPromises);
            updateStatus(); // Update status after job completes
          }
          continue;
        }

        try {
          // Poll for pending jobs
          const job = await withRunnerTiming("poll", () =>
            pollForJob(config.server, config.group),
          );

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
            const context = await withRunnerTiming("claim", () =>
              claimJob(config.server, job.runId),
            );
            console.log(`Claimed job: ${context.runId}`);

            // Track and execute in background
            activeJobs.add(context.runId);
            updateStatus(); // Update status when job starts

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
                updateStatus(); // Update status when job completes
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

      // Cleanup proxy
      if (proxyEnabled) {
        console.log("Stopping network proxy...");
        await getProxyManager().stop();
      }

      // Flush and shutdown metrics
      console.log("Flushing metrics...");
      await flushMetrics();
      await shutdownMetrics();

      // Final status update
      state.mode = "stopped";
      updateStatus();

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
