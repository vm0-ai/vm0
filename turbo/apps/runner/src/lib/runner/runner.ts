import type { RunnerConfig } from "../config.js";
import {
  pollForJob,
  claimJob,
  completeJob,
  type ExecutionContext,
} from "../api.js";
import { executeJob as executeJobInVM } from "../executor.js";
import { withRunnerTiming } from "../metrics/index.js";
import type { RunnerState, RunnerResources } from "./types.js";
import { createStatusUpdater } from "./status.js";
import { setupEnvironment, cleanupEnvironment } from "./setup.js";
import { setupSignalHandlers } from "./signals.js";

export class Runner {
  private config: RunnerConfig;
  private statusFilePath: string;
  private state: RunnerState;
  private resources: RunnerResources | null = null;
  private running = true;
  private updateStatus: () => void;

  constructor(config: RunnerConfig, statusFilePath: string) {
    this.config = config;
    this.statusFilePath = statusFilePath;
    this.state = {
      mode: "running",
      activeRuns: new Set(),
      jobPromises: new Set(),
      startedAt: new Date(),
    };
    this.updateStatus = createStatusUpdater(statusFilePath, this.state);
  }

  async start(): Promise<void> {
    // 1. Setup environment
    this.resources = await setupEnvironment({ config: this.config });

    // 2. Setup signal handlers
    setupSignalHandlers(this.state, {
      onShutdown: () => {
        this.running = false;
      },
      updateStatus: this.updateStatus,
    });

    // 3. Start message
    console.log(
      `Starting runner '${this.config.name}' for group '${this.config.group}'...`,
    );
    console.log(`Max concurrent jobs: ${this.config.sandbox.max_concurrent}`);
    console.log(`Status file: ${this.statusFilePath}`);
    console.log("Press Ctrl+C to stop");
    console.log("");

    // Write initial status
    this.updateStatus();

    // 4. Run main loop
    await this.runMainLoop();

    // 5. Wait for active jobs to complete
    if (this.state.jobPromises.size > 0) {
      console.log(
        `Waiting for ${this.state.jobPromises.size} active job(s) to complete...`,
      );
      await Promise.all(this.state.jobPromises);
    }

    // 6. Cleanup
    await cleanupEnvironment(this.resources);

    // Final status update
    this.state.mode = "stopped";
    this.updateStatus();

    console.log("Runner stopped");
    process.exit(0);
  }

  private async runMainLoop(): Promise<void> {
    while (this.running) {
      // In drain mode, don't poll for new jobs - just wait for active jobs to complete
      if (this.state.mode === "draining") {
        if (this.state.activeRuns.size === 0) {
          console.log("[Maintenance] All jobs completed, exiting drain mode");
          this.running = false;
          break;
        }
        // Wait for any job to complete
        if (this.state.jobPromises.size > 0) {
          await Promise.race(this.state.jobPromises);
          this.updateStatus();
        }
        continue;
      }

      // Check concurrency limit - skip poll if at capacity
      if (this.state.activeRuns.size >= this.config.sandbox.max_concurrent) {
        // Wait for any job to complete before polling again
        if (this.state.jobPromises.size > 0) {
          await Promise.race(this.state.jobPromises);
          this.updateStatus();
        }
        continue;
      }

      try {
        // Poll for pending jobs
        const job = await withRunnerTiming("poll", () =>
          pollForJob(this.config.server, this.config.group),
        );

        if (!job) {
          // No job found, wait before polling again
          await new Promise((resolve) =>
            setTimeout(resolve, this.config.sandbox.poll_interval_ms),
          );
          continue;
        }

        console.log(`Found job: ${job.runId}`);

        // Claim the job
        await this.processJob(job.runId);
      } catch (error) {
        console.error(
          "Polling error:",
          error instanceof Error ? error.message : "Unknown error",
        );
        // Wait before retrying after error
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private async processJob(runId: string): Promise<void> {
    try {
      const context = await withRunnerTiming("claim", () =>
        claimJob(this.config.server, runId),
      );
      console.log(`Claimed job: ${context.runId}`);

      // Track and execute in background
      this.state.activeRuns.add(context.runId);
      this.updateStatus();

      const jobPromise: Promise<void> = this.executeJob(context)
        .catch((error) => {
          console.error(
            `Job ${context.runId} failed:`,
            error instanceof Error ? error.message : "Unknown error",
          );
        })
        .finally(() => {
          this.state.activeRuns.delete(context.runId);
          this.state.jobPromises.delete(jobPromise);
          this.updateStatus();
        });
      this.state.jobPromises.add(jobPromise);
    } catch (error) {
      // Job was claimed by another runner, continue polling
      console.log(
        `Could not claim job ${runId}:`,
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  private async executeJob(context: ExecutionContext): Promise<void> {
    console.log(`  Executing job ${context.runId}...`);
    console.log(`  Prompt: ${context.prompt.substring(0, 100)}...`);
    console.log(`  Compose version: ${context.agentComposeVersionId}`);

    try {
      // Execute in Firecracker VM
      const result = await executeJobInVM(context, this.config);

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
      const result = await completeJob(
        this.config.server.url,
        context,
        1,
        error,
      );
      console.log(`  Job ${context.runId} reported as ${result.status}`);
    }
  }
}
