/**
 * Main agent execution orchestrator for VM0.
 * This script coordinates the execution of Claude Code and handles:
 * - Working directory setup
 * - Claude CLI execution with JSONL streaming
 * - Event sending to webhook
 * - Checkpoint creation on success
 * - Complete API call on finish
 *
 * Design principles:
 * - Never call process.exit() in the middle of execution - use throw instead
 * - Single exit point at the very end of main()
 * - finally block guarantees cleanup runs regardless of success/failure
 * - Complete API passes error message for CLI to display
 */
import * as fs from "fs";
import { spawn, execSync } from "child_process";
import * as readline from "readline";
import {
  WORKING_DIR,
  PROMPT,
  RESUME_SESSION_ID,
  COMPLETE_URL,
  RUN_ID,
  EVENT_ERROR_FLAG,
  HEARTBEAT_URL,
  HEARTBEAT_INTERVAL,
  AGENT_LOG_FILE,
  CLI_AGENT_TYPE,
  OPENAI_MODEL,
  API_START_TIME,
  validateConfig,
  recordSandboxOp,
} from "./lib/common.js";
import { logInfo, logError, logDebug } from "./lib/log.js";
import { sendEvent } from "./lib/events.js";
import { createCheckpoint } from "./lib/checkpoint.js";
import { httpPostJson } from "./lib/http-client.js";
import { startHeartbeat, requestShutdown } from "./lib/heartbeat.js";
import { startMetricsCollector, stopMetricsCollector } from "./lib/metrics.js";
import {
  startTelemetryUpload,
  stopTelemetryUpload,
  finalTelemetryUpload,
} from "./lib/upload-telemetry.js";

/**
 * Cleanup and notify server.
 * This function is called in the finally block to ensure it always runs.
 */
async function cleanup(exitCode: number, errorMessage: string): Promise<void> {
  logInfo("▷ Cleanup");

  // Perform final telemetry upload before completion
  const telemetryStart = Date.now();
  let telemetrySuccess = true;
  try {
    await finalTelemetryUpload();
  } catch (error) {
    telemetrySuccess = false;
    logError(`Final telemetry upload failed: ${error}`);
  }
  recordSandboxOp(
    "final_telemetry_upload",
    Date.now() - telemetryStart,
    telemetrySuccess,
  );

  // Always call complete API at the end
  logInfo(`Calling complete API with exitCode=${exitCode}`);

  const completePayload: Record<string, unknown> = {
    runId: RUN_ID,
    exitCode,
  };
  if (errorMessage) {
    completePayload.error = errorMessage;
  }

  const completeStart = Date.now();
  let completeSuccess = false;
  try {
    if (await httpPostJson(COMPLETE_URL, completePayload)) {
      logInfo("Complete API called successfully");
      completeSuccess = true;
    } else {
      logError("Failed to call complete API (sandbox may not be cleaned up)");
    }
  } catch (error) {
    logError(`Complete API call failed: ${error}`);
  }
  recordSandboxOp(
    "complete_api_call",
    Date.now() - completeStart,
    completeSuccess,
  );

  // Stop background processes
  requestShutdown();
  stopMetricsCollector();
  stopTelemetryUpload();
  logInfo("Background processes stopped");

  // Log final status
  if (exitCode === 0) {
    logInfo("✓ Sandbox finished successfully");
  } else {
    logInfo(`✗ Sandbox failed (exit code ${exitCode})`);
  }
}

/**
 * Main execution logic.
 * Throws exceptions on failure instead of calling process.exit().
 * Returns [exit_code, error_message] tuple on completion.
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
async function run(): Promise<[number, string]> {
  // Record API-to-agent E2E time (if API start timestamp is available)
  if (API_START_TIME) {
    const apiStartTime = parseInt(API_START_TIME, 10);
    if (!isNaN(apiStartTime)) {
      const e2eTime = Date.now() - apiStartTime;
      recordSandboxOp("api_to_agent_start", e2eTime, true);
      logInfo(`E2E time from API to agent start: ${e2eTime}ms`);
    }
  }

  // Validate configuration - throws if invalid
  validateConfig();

  // Lifecycle: Header
  logInfo(`▶ VM0 Sandbox ${RUN_ID}`);

  // Lifecycle: Initialization
  logInfo("▷ Initialization");
  const initStartTime = Date.now();

  logInfo(`Working directory: ${WORKING_DIR}`);

  // Start heartbeat loop (async, first heartbeat failure rejects heartbeatFailure)
  // This replaces the old preflight check by validating network connectivity
  const heartbeatStart = Date.now();
  const heartbeatFailure = startHeartbeat({
    heartbeatUrl: HEARTBEAT_URL,
    runId: RUN_ID,
    intervalSeconds: HEARTBEAT_INTERVAL,
  });
  // Prevent unhandled rejection - we'll race against this in the main loop
  heartbeatFailure.catch(() => {});
  logInfo("Heartbeat started");
  recordSandboxOp("heartbeat_start", Date.now() - heartbeatStart, true);

  // Start metrics collector
  const metricsStart = Date.now();
  startMetricsCollector();
  logInfo("Metrics collector started");
  recordSandboxOp("metrics_collector_start", Date.now() - metricsStart, true);

  // Start telemetry upload
  const telemetryStart = Date.now();
  startTelemetryUpload();
  logInfo("Telemetry upload started");
  recordSandboxOp("telemetry_upload_start", Date.now() - telemetryStart, true);

  // Create and change to working directory
  const workingDirStart = Date.now();
  try {
    fs.mkdirSync(WORKING_DIR, { recursive: true });
    process.chdir(WORKING_DIR);
  } catch (error) {
    recordSandboxOp(
      "working_dir_setup",
      Date.now() - workingDirStart,
      false,
      String(error),
    );
    throw new Error(
      `Failed to create/change to working directory: ${WORKING_DIR} - ${error}`,
    );
  }
  recordSandboxOp("working_dir_setup", Date.now() - workingDirStart, true);

  // Set up Codex configuration if using Codex CLI
  if (CLI_AGENT_TYPE === "codex") {
    const homeDir = process.env.HOME ?? "/home/user";
    const codexHome = `${homeDir}/.codex`;
    fs.mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    logInfo(`Codex home directory: ${codexHome}`);

    // Login with API key via stdin
    const codexLoginStart = Date.now();
    let codexLoginSuccess = false;
    const apiKey = process.env.OPENAI_API_KEY ?? "";

    if (apiKey) {
      try {
        execSync("codex login --with-api-key", {
          input: apiKey,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        logInfo("Codex authenticated with API key");
        codexLoginSuccess = true;
      } catch (error) {
        logError(`Codex login failed: ${error}`);
      }
    } else {
      logError("OPENAI_API_KEY not set");
    }
    recordSandboxOp(
      "codex_login",
      Date.now() - codexLoginStart,
      codexLoginSuccess,
    );
  }

  const initDurationMs = Date.now() - initStartTime;
  recordSandboxOp("init_total", initDurationMs, true);
  logInfo(`✓ Initialization complete (${Math.floor(initDurationMs / 1000)}s)`);

  // Lifecycle: Execution
  logInfo("▷ Execution");
  const execStartTime = Date.now();

  // Execute CLI agent with JSONL output
  logInfo(`Starting ${CLI_AGENT_TYPE} execution...`);

  // Build command based on CLI agent type
  const useMock = process.env.USE_MOCK_CLAUDE === "true";
  let cmd: string[];

  if (CLI_AGENT_TYPE === "codex") {
    if (useMock) {
      throw new Error("Mock mode not supported for Codex");
    }

    const codexArgs = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      WORKING_DIR,
    ];

    if (OPENAI_MODEL) {
      codexArgs.push("-m", OPENAI_MODEL);
    }

    if (RESUME_SESSION_ID) {
      logInfo(`Resuming session: ${RESUME_SESSION_ID}`);
      codexArgs.push("resume", RESUME_SESSION_ID, PROMPT);
    } else {
      logInfo("Starting new session");
      codexArgs.push(PROMPT);
    }

    cmd = ["codex", ...codexArgs];
  } else {
    // Build Claude command
    const claudeArgs = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];

    if (RESUME_SESSION_ID) {
      logInfo(`Resuming session: ${RESUME_SESSION_ID}`);
      claudeArgs.push("--resume", RESUME_SESSION_ID);
    } else {
      logInfo("Starting new session");
    }

    // Select Claude binary
    const claudeBin = useMock
      ? "/usr/local/bin/vm0-agent/mock-claude.mjs"
      : "claude";

    if (useMock) {
      logInfo("Using mock-claude for testing");
    }

    cmd = [claudeBin, ...claudeArgs, PROMPT];
  }

  // Execute CLI agent and process output stream
  let agentExitCode = 0;
  let executionError = ""; // Capture error from catch block for complete API
  const stderrLines: string[] = [];
  let logFile: fs.WriteStream | null = null;

  try {
    // Open log file
    logFile = fs.createWriteStream(AGENT_LOG_FILE);

    // Validate command
    const cmdExe = cmd[0];
    if (!cmdExe) {
      throw new Error("Empty command");
    }

    // Spawn process
    // Use "ignore" for stdin since we don't send any input to Claude Code
    // Using "pipe" without closing it would cause Claude Code to hang waiting for EOF
    const proc = spawn(cmdExe, cmd.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Create promise to track process exit - register handlers BEFORE reading streams
    // This prevents race condition where process exits before handlers are registered
    const exitPromise = new Promise<number>((resolve) => {
      let resolved = false;

      proc.on("error", (err: Error) => {
        if (!resolved) {
          resolved = true;
          logError(`Failed to spawn ${CLI_AGENT_TYPE}: ${err.message}`);
          stderrLines.push(`Spawn error: ${err.message}`);
          resolve(1);
        }
      });

      proc.on("close", (code: number | null) => {
        if (!resolved) {
          resolved = true;
          resolve(code ?? 1);
        }
      });
    });

    // Read stderr in background
    if (proc.stderr) {
      const stderrRl = readline.createInterface({ input: proc.stderr });
      stderrRl.on("line", (line) => {
        stderrLines.push(line);
        if (logFile && !logFile.destroyed) {
          logFile.write(`[STDERR] ${line}\n`);
        }
      });
    }

    // Process JSONL output line by line from stdout
    if (proc.stdout) {
      const stdoutRl = readline.createInterface({ input: proc.stdout });
      let eventSequence = 0;

      for await (const line of stdoutRl) {
        // Write raw line to log file
        if (logFile && !logFile.destroyed) {
          logFile.write(line + "\n");
        }

        const stripped = line.trim();
        if (!stripped) {
          continue;
        }

        // Check if line is valid JSON
        try {
          const event = JSON.parse(stripped) as Record<string, unknown>;

          // Valid JSONL - send immediately with sequence number (0-based)
          await sendEvent(event, eventSequence);
          eventSequence++;
        } catch {
          // Not valid JSON - log at debug level and skip
          logDebug(`Non-JSON line from agent: ${stripped.slice(0, 100)}`);
        }
      }
    }

    // Wait for process to complete, or fail fast if first heartbeat fails
    // Promise.race ensures we detect network issues even during CLI execution
    agentExitCode = await Promise.race([exitPromise, heartbeatFailure]);
  } catch (error) {
    logError(`Failed to execute ${CLI_AGENT_TYPE}: ${error}`);
    agentExitCode = 1;
    executionError = error instanceof Error ? error.message : String(error);
  } finally {
    if (logFile && !logFile.destroyed) {
      logFile.end();
    }
  }

  // Print newline after output
  console.log();

  // Track final exit code for complete API
  let finalExitCode = agentExitCode;
  let errorMessage = "";

  // Check if any events failed to send
  if (fs.existsSync(EVENT_ERROR_FLAG)) {
    logError("Some events failed to send, marking run as failed");
    finalExitCode = 1;
    errorMessage = "Some events failed to send";
  }

  // Log execution result and record metric
  const execDurationMs = Date.now() - execStartTime;
  recordSandboxOp("cli_execution", execDurationMs, agentExitCode === 0);

  if (agentExitCode === 0 && finalExitCode === 0) {
    logInfo(`✓ Execution complete (${Math.floor(execDurationMs / 1000)}s)`);
  } else {
    logInfo(`✗ Execution failed (${Math.floor(execDurationMs / 1000)}s)`);
  }

  // Handle completion
  if (agentExitCode === 0 && finalExitCode === 0) {
    logInfo(`${CLI_AGENT_TYPE} completed successfully`);

    // Lifecycle: Checkpoint
    logInfo("▷ Checkpoint");
    const checkpointStartTime = Date.now();

    // Create checkpoint - mandatory for successful runs
    const checkpointSuccess = await createCheckpoint();
    const checkpointDuration = Math.floor(
      (Date.now() - checkpointStartTime) / 1000,
    );

    if (checkpointSuccess) {
      logInfo(`✓ Checkpoint complete (${checkpointDuration}s)`);
    } else {
      logInfo(`✗ Checkpoint failed (${checkpointDuration}s)`);
    }

    if (!checkpointSuccess) {
      logError("Checkpoint creation failed, marking run as failed");
      finalExitCode = 1;
      errorMessage = "Checkpoint creation failed";
    }
  } else {
    if (agentExitCode !== 0) {
      logInfo(`${CLI_AGENT_TYPE} failed with exit code ${agentExitCode}`);

      // Get detailed error from execution error, stderr, or generic message
      if (executionError) {
        // Execution error (e.g., heartbeat failure, spawn error)
        errorMessage = executionError;
      } else if (stderrLines.length > 0) {
        // Captured stderr from agent process
        errorMessage = stderrLines.map((line) => line.trim()).join(" ");
        logInfo(`Captured ${stderrLines.length} stderr lines`);
      } else {
        errorMessage = `Agent exited with code ${agentExitCode}`;
      }
    }
  }

  return [finalExitCode, errorMessage];
}

/**
 * Main entry point for agent execution.
 * Uses try/catch/finally to ensure cleanup always runs.
 * Returns exit code (0 for success, non-zero for failure).
 */
async function main(): Promise<number> {
  let exitCode = 1;
  let errorMessage = "Unexpected termination";

  try {
    [exitCode, errorMessage] = await run();
  } catch (error) {
    if (error instanceof Error) {
      exitCode = 1;
      errorMessage = error.message;
      logError(`Error: ${errorMessage}`);
    } else {
      exitCode = 1;
      errorMessage = `Unexpected error: ${error}`;
      logError(errorMessage);
    }
  } finally {
    // Always cleanup and notify server
    await cleanup(exitCode, errorMessage);
  }

  return exitCode;
}

// Run main and exit with the returned code
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
