import type { RunnerConfig } from "../config.js";
import {
  pollForJob,
  claimJob,
  completeJob,
  type ExecutionContext,
} from "../api.js";
import {
  subscribeToJobs,
  type JobSubscription,
} from "../realtime/subscription.js";
import { executeJob as executeJobInVM } from "../executor/index.js";
import { withRunnerTiming } from "../metrics/index.js";
import type { RunnerState, RunnerResources } from "./types.js";
import { createStatusUpdater } from "./status.js";
import { setupEnvironment, cleanupEnvironment } from "./setup.js";
import { setupSignalHandlers } from "./signals.js";
import { createLogger } from "../logger.js";

const logger = createLogger("Runner");

export class Runner {
  private config: RunnerConfig;
  private statusFilePath: string;
  private state: RunnerState;
  private resources: RunnerResources | null = null;
  private updateStatus: () => void;

  // Ably subscription
  private subscription: JobSubscription | null = null;

  // Queue for jobs received while at capacity (max 100 to prevent unbounded growth)
  private static readonly MAX_PENDING_QUEUE_SIZE = 100;
  private pendingJobs: string[] = [];

  // Polling fallback interval
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // Shutdown coordination
  private resolveShutdown: (() => void) | null = null;

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

    // 2. Create shutdown promise
    const shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });

    // 3. Setup signal handlers
    setupSignalHandlers(this.state, {
      onShutdown: () => {
        this.resolveShutdown?.();
      },
      onDrain: () => {
        // Clear pending jobs queue - don't process new jobs
        this.pendingJobs.length = 0;

        // If no active jobs, shutdown immediately
        if (this.state.activeRuns.size === 0) {
          logger.log("[Maintenance] No active jobs, exiting immediately");
          this.state.mode = "stopping";
          this.updateStatus();
          this.resolveShutdown?.();
        }
      },
      updateStatus: this.updateStatus,
    });

    // 4. Start message
    logger.log(
      `Starting runner '${this.config.name}' for group '${this.config.group}'...`,
    );
    logger.log(`Max concurrent jobs: ${this.config.sandbox.max_concurrent}`);
    logger.log(`Status file: ${this.statusFilePath}`);
    logger.log("Press Ctrl+C to stop");
    logger.log("");

    // Write initial status
    this.updateStatus();

    // 5. Poll on startup to clear any backlog
    logger.log("Checking for pending jobs...");
    await this.pollFallback();

    // 6. Subscribe to Ably job notifications
    logger.log("Connecting to realtime job notifications...");
    this.subscription = await subscribeToJobs(
      this.config.server,
      this.config.group,
      (notification) => {
        logger.log(`Ably notification: ${notification.runId}`);
        this.processJob(notification.runId).catch(console.error);
      },
      (connectionState, reason) => {
        logger.log(
          `Ably connection: ${connectionState}${reason ? ` (${reason})` : ""}`,
        );
      },
    );
    logger.log("Connected to realtime job notifications");

    // 7. Start polling fallback interval
    this.pollInterval = setInterval(() => {
      this.pollFallback().catch(console.error);
    }, this.config.sandbox.poll_interval_ms);
    logger.log(
      `Polling fallback enabled (every ${this.config.sandbox.poll_interval_ms / 1000}s)`,
    );

    // 8. Wait for shutdown signal
    await shutdownPromise;

    // 9. Cleanup polling interval
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    // 10. Cleanup Ably subscription
    if (this.subscription) {
      this.subscription.cleanup();
    }

    // 11. Wait for active jobs to complete
    if (this.state.jobPromises.size > 0) {
      logger.log(
        `Waiting for ${this.state.jobPromises.size} active job(s) to complete...`,
      );
      await Promise.all(this.state.jobPromises);
    }

    // 12. Cleanup environment
    await cleanupEnvironment(this.resources);

    // Final status update
    this.state.mode = "stopped";
    this.updateStatus();

    logger.log("Runner stopped");
    process.exit(0);
  }

  /**
   * Poll for jobs as fallback mechanism.
   * Catches jobs that may have been missed by push notifications.
   */
  private async pollFallback(): Promise<void> {
    if (this.state.mode !== "running") return;
    if (this.state.activeRuns.size >= this.config.sandbox.max_concurrent)
      return;

    try {
      const job = await withRunnerTiming("poll", () =>
        pollForJob(this.config.server, this.config.group),
      );
      if (job) {
        logger.log(`Poll fallback found job: ${job.runId}`);
        await this.processJob(job.runId);
      }
    } catch (error) {
      logger.error(
        `Poll fallback error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Process a job notification - claim and execute.
   */
  private async processJob(runId: string): Promise<void> {
    // Skip if not in running mode (draining or stopped)
    if (this.state.mode !== "running") {
      logger.log(`Not running (${this.state.mode}), ignoring job ${runId}`);
      return;
    }

    // Skip if job is already being executed (duplicate notification)
    if (this.state.activeRuns.has(runId)) {
      return;
    }

    // Check concurrency limit
    if (this.state.activeRuns.size >= this.config.sandbox.max_concurrent) {
      // Avoid duplicate entries and respect max queue size
      if (
        !this.pendingJobs.includes(runId) &&
        this.pendingJobs.length < Runner.MAX_PENDING_QUEUE_SIZE
      ) {
        logger.log(`At capacity, queueing job ${runId}`);
        this.pendingJobs.push(runId);
      } else if (this.pendingJobs.length >= Runner.MAX_PENDING_QUEUE_SIZE) {
        logger.log(
          `Pending queue full (${Runner.MAX_PENDING_QUEUE_SIZE}), dropping job ${runId}`,
        );
      }
      return;
    }

    try {
      const context = await withRunnerTiming("claim", () =>
        claimJob(this.config.server, runId),
      );
      logger.log(`Claimed job: ${context.runId}`);

      // Track and execute in background
      this.state.activeRuns.add(context.runId);
      this.updateStatus();

      const jobPromise: Promise<void> = this.executeJob(context)
        .catch((error) => {
          logger.error(
            `Job ${context.runId} failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        })
        .finally(() => {
          this.state.activeRuns.delete(context.runId);
          this.state.jobPromises.delete(jobPromise);
          this.updateStatus();

          // In drain mode, shutdown when last job completes
          if (
            this.state.mode === "draining" &&
            this.state.activeRuns.size === 0
          ) {
            logger.log("[Maintenance] All jobs completed, exiting");
            this.state.mode = "stopping";
            this.updateStatus();
            this.resolveShutdown?.();
            return;
          }

          // Process next queued job if any
          if (this.pendingJobs.length > 0 && this.state.mode === "running") {
            const nextJob = this.pendingJobs.shift();
            if (nextJob) {
              this.processJob(nextJob).catch(console.error);
            }
          }
        });
      this.state.jobPromises.add(jobPromise);
    } catch (error) {
      // Job was claimed by another runner
      logger.log(
        `Could not claim job ${runId}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private async executeJob(context: ExecutionContext): Promise<void> {
    logger.log(`  Executing job ${context.runId}...`);
    logger.log(`  Prompt: ${context.prompt.substring(0, 100)}...`);
    logger.log(`  Compose version: ${context.agentComposeVersionId}`);

    try {
      // Execute in Firecracker VM
      const result = await executeJobInVM(context, this.config);

      logger.log(
        `  Job ${context.runId} execution completed with exit code ${result.exitCode}`,
      );

      // The executor's bootstrap script calls the complete API directly
      // But if execution fails before that, we need to report it ourselves
      if (result.exitCode !== 0 && result.error) {
        logger.error(`  Job ${context.runId} failed: ${result.error}`);
      }
    } catch (err) {
      const error =
        err instanceof Error ? err.message : "Unknown execution error";
      logger.error(`  Job ${context.runId} execution failed: ${error}`);

      // Report failure to server if VM execution failed before bootstrap
      const result = await completeJob(
        this.config.server.url,
        context,
        1,
        error,
      );
      logger.log(`  Job ${context.runId} reported as ${result.status}`);
    }
  }
}
