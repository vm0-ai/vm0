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
 * - Single exit point at the very end
 * - finally block guarantees cleanup runs regardless of success/failure
 * - Complete API passes error message for CLI to display
 */
import * as fs from "fs";
import { spawn } from "child_process";
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
  validateConfig,
} from "./lib/common.js";
import { logInfo, logError, logWarn } from "./lib/log.js";
import { sendEvent } from "./lib/events.js";
import { createCheckpoint } from "./lib/checkpoint.js";
import { httpPostJson } from "./lib/http-client.js";
import { startMetricsCollector, requestShutdown } from "./lib/metrics.js";
import {
  startTelemetryUpload,
  finalTelemetryUpload,
} from "./lib/upload-telemetry.js";

// Global shutdown flag
let heartbeatShouldStop = false;

/**
 * Send periodic heartbeat signals to indicate agent is still alive.
 */
function heartbeatLoop(): void {
  const sendHeartbeat = async (): Promise<void> => {
    if (heartbeatShouldStop) {
      return;
    }

    try {
      const result = await httpPostJson(HEARTBEAT_URL, { runId: RUN_ID });
      if (result) {
        logInfo("Heartbeat sent");
      } else {
        logWarn("Heartbeat failed");
      }
    } catch (e) {
      logWarn(`Heartbeat error: ${e}`);
    }

    // Schedule next heartbeat
    if (!heartbeatShouldStop) {
      setTimeout(() => void sendHeartbeat(), HEARTBEAT_INTERVAL * 1000);
    }
  };

  // Start sending heartbeats
  setTimeout(() => void sendHeartbeat(), HEARTBEAT_INTERVAL * 1000);
}

/**
 * Cleanup and notify server.
 * This function is called in the finally block to ensure it always runs.
 */
async function cleanup(exitCode: number, errorMessage: string): Promise<void> {
  logInfo("▷ Cleanup");

  // Perform final telemetry upload before completion
  // This ensures all remaining data is captured
  try {
    await finalTelemetryUpload();
  } catch (e) {
    logError(`Final telemetry upload failed: ${e}`);
  }

  // Always call complete API at the end
  // This sends vm0_result (on success) or vm0_error (on failure) and kills the sandbox
  logInfo(`Calling complete API with exitCode=${exitCode}`);

  const completePayload: Record<string, unknown> = {
    runId: RUN_ID,
    exitCode,
  };
  if (errorMessage) {
    completePayload.error = errorMessage;
  }

  try {
    const result = await httpPostJson(COMPLETE_URL, completePayload);
    if (result) {
      logInfo("Complete API called successfully");
    } else {
      logError("Failed to call complete API (sandbox may not be cleaned up)");
    }
  } catch (e) {
    logError(`Complete API call failed: ${e}`);
  }

  // Stop heartbeat and metrics threads
  heartbeatShouldStop = true;
  requestShutdown();
  logInfo("Background threads stopped");

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
 * Returns [exitCode, errorMessage] tuple on completion.
 */
async function run(): Promise<[number, string]> {
  // Validate configuration - throws if invalid
  validateConfig();

  // Lifecycle: Header
  logInfo(`▶ VM0 Sandbox ${RUN_ID}`);

  // Lifecycle: Initialization
  logInfo("▷ Initialization");
  const initStartTime = Date.now();

  logInfo(`Working directory: ${WORKING_DIR}`);

  // Start heartbeat loop
  heartbeatLoop();
  logInfo("Heartbeat thread started");

  // Start metrics collector
  startMetricsCollector();
  logInfo("Metrics collector thread started");

  // Start telemetry upload
  startTelemetryUpload();
  logInfo("Telemetry upload thread started");

  // Create and change to working directory - throws if fails
  // Directory may not exist if no artifact/storage was downloaded (e.g., first run)
  try {
    fs.mkdirSync(WORKING_DIR, { recursive: true });
    process.chdir(WORKING_DIR);
  } catch (e) {
    throw new Error(
      `Failed to create/change to working directory: ${WORKING_DIR} - ${e}`,
    );
  }

  // Set up Codex configuration if using Codex CLI
  // Claude Code uses ~/.claude by default (no configuration needed)
  if (CLI_AGENT_TYPE === "codex") {
    const homeDir = process.env.HOME ?? "/home/user";
    // Codex uses ~/.codex for configuration and session storage
    const codexHome = `${homeDir}/.codex`;
    fs.mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    logInfo(`Codex home directory: ${codexHome}`);

    // Login with API key via stdin (recommended method)
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (apiKey) {
      const { execSync } = await import("child_process");
      try {
        execSync("codex login --with-api-key", {
          input: apiKey,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        logInfo("Codex authenticated with API key");
      } catch (e) {
        logError(`Codex login failed: ${e}`);
      }
    } else {
      logError("OPENAI_API_KEY not set");
    }
  }

  const initDuration = Math.floor((Date.now() - initStartTime) / 1000);
  logInfo(`✓ Initialization complete (${initDuration}s)`);

  // Lifecycle: Execution
  logInfo("▷ Execution");
  const execStartTime = Date.now();

  // Execute CLI agent with JSONL output
  logInfo(`Starting ${CLI_AGENT_TYPE} execution...`);
  logInfo(`Prompt: ${PROMPT}`);

  // Build command based on CLI agent type
  const useMock = process.env.USE_MOCK_CLAUDE === "true";
  let cmd: string;
  let args: string[];

  if (CLI_AGENT_TYPE === "codex") {
    // Build Codex command
    if (useMock) {
      // Mock mode not yet supported for Codex
      throw new Error("Mock mode not supported for Codex");
    }

    cmd = "codex";
    args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-C",
      WORKING_DIR,
    ];

    if (OPENAI_MODEL) {
      args.push("-m", OPENAI_MODEL);
    }

    if (RESUME_SESSION_ID) {
      logInfo(`Resuming session: ${RESUME_SESSION_ID}`);
      args.push("resume", RESUME_SESSION_ID, PROMPT);
    } else {
      logInfo("Starting new session");
      args.push(PROMPT);
    }
  } else {
    // Build Claude command - unified for both new and resume sessions
    args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
    ];

    if (RESUME_SESSION_ID) {
      logInfo(`Resuming session: ${RESUME_SESSION_ID}`);
      args.push("--resume", RESUME_SESSION_ID);
    } else {
      logInfo("Starting new session");
    }

    // Select Claude binary - use mock-claude for testing if USE_MOCK_CLAUDE is set
    if (useMock) {
      cmd = "/usr/local/bin/vm0-agent/mock-claude.js";
      logInfo("Using mock-claude for testing");
    } else {
      cmd = "claude";
    }

    args.push(PROMPT);
  }

  // Execute CLI agent and process output stream
  // Capture both stdout and stderr, write to log file, keep stderr in memory for error extraction
  let agentExitCode = 0;
  const stderrLines: string[] = [];
  let logFile: fs.WriteStream | null = null;

  try {
    // Open log file
    logFile = fs.createWriteStream(AGENT_LOG_FILE);

    const proc = spawn(cmd, args, {
      cwd: WORKING_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Track event sequence
    let eventSequence = 0;

    // Process stdout line by line (JSONL)
    let stdoutBuffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logFile?.write(text);
      stdoutBuffer += text;

      // Process complete lines
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const stripped = line.trim();
        if (!stripped) continue;

        try {
          const event = JSON.parse(stripped) as Record<string, unknown>;

          // Valid JSONL - send immediately with sequence number (fire-and-forget)
          // Errors are logged inside sendEvent, no need to handle here
          eventSequence += 1;
          sendEvent(event, eventSequence).catch(() => {});

          // Extract result from "result" event for stdout
          if (event.type === "result") {
            const resultContent = event.result as string | undefined;
            if (resultContent) {
              console.log(resultContent);
            }
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    // Capture stderr
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logFile?.write(`[STDERR] ${text}`);
      stderrLines.push(text);
    });

    // Wait for process to complete
    agentExitCode = await new Promise<number>((resolve) => {
      proc.on("close", (code) => {
        resolve(code ?? 1);
      });
      proc.on("error", (err) => {
        logError(`Failed to execute ${CLI_AGENT_TYPE}: ${err}`);
        resolve(1);
      });
    });
  } finally {
    if (logFile) {
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

  // Log execution result
  const execDuration = Math.floor((Date.now() - execStartTime) / 1000);
  if (agentExitCode === 0 && finalExitCode === 0) {
    logInfo(`✓ Execution complete (${execDuration}s)`);
  } else {
    logInfo(`✗ Execution failed (${execDuration}s)`);
  }

  // Handle completion
  if (agentExitCode === 0 && finalExitCode === 0) {
    logInfo(`${CLI_AGENT_TYPE} completed successfully`);

    // Lifecycle: Checkpoint
    logInfo("▷ Checkpoint");
    const checkpointStartTime = Date.now();

    // Create checkpoint - this is mandatory for successful runs
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

      // Get detailed error from captured stderr lines in memory
      if (stderrLines.length > 0) {
        errorMessage = stderrLines.map((line) => line.trim()).join(" ");
        logInfo(`Captured stderr: ${errorMessage}`);
      } else {
        errorMessage = `Agent exited with code ${agentExitCode}`;
      }
    }
  }

  // Note: Keep all temp files for debugging (SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE, EVENT_ERROR_FLAG)

  return [finalExitCode, errorMessage];
}

/**
 * Main entry point for agent execution.
 * Uses try/catch/finally to ensure cleanup always runs.
 * Returns exit code (0 for success, non-zero for failure).
 */
async function main(): Promise<number> {
  let exitCode = 1; // Default to failure
  let errorMessage = "Unexpected termination";

  try {
    [exitCode, errorMessage] = await run();
  } catch (e) {
    if (e instanceof Error) {
      exitCode = 1;
      errorMessage = e.message;
      logError(`Error: ${errorMessage}`);
    } else {
      exitCode = 1;
      errorMessage = `Unexpected error: ${e}`;
      logError(errorMessage);
    }
  } finally {
    // Always cleanup and notify server
    await cleanup(exitCode, errorMessage);
  }

  return exitCode;
}

// Run main when executed directly
main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
