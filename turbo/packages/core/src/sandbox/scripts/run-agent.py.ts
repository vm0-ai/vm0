/**
 * Main agent execution orchestrator script (Python)
 * This script imports the library modules and coordinates execution
 */
export const RUN_AGENT_SCRIPT = `#!/usr/bin/env python3
"""
Main agent execution orchestrator for VM0.
This script coordinates the execution of Claude Code and handles:
- Working directory setup
- Claude CLI execution with JSONL streaming
- Event sending to webhook
- Checkpoint creation on success
- Complete API call on finish

Design principles:
- Never call sys.exit() in the middle of execution - use raise instead
- Single exit point at the very end of if __name__ == "__main__"
- finally block guarantees cleanup runs regardless of success/failure
- Complete API passes error message for CLI to display
"""
import os
import sys
import subprocess
import json
import threading
import time

# Add lib to path for imports
sys.path.insert(0, "/usr/local/bin/vm0-agent/lib")

from common import (
    WORKING_DIR, PROMPT, RESUME_SESSION_ID, COMPLETE_URL, RUN_ID,
    EVENT_ERROR_FLAG, HEARTBEAT_URL, HEARTBEAT_INTERVAL, AGENT_LOG_FILE,
    CLI_AGENT_TYPE, OPENAI_MODEL, validate_config, record_sandbox_op
)
from log import log_info, log_error, log_warn
from events import send_event
from checkpoint import create_checkpoint
from http_client import http_post_json
from metrics import start_metrics_collector
from upload_telemetry import start_telemetry_upload, final_telemetry_upload

# Global shutdown event for heartbeat thread
shutdown_event = threading.Event()


def heartbeat_loop():
    """Send periodic heartbeat signals to indicate agent is still alive."""
    while not shutdown_event.is_set():
        try:
            if http_post_json(HEARTBEAT_URL, {"runId": RUN_ID}):
                log_info("Heartbeat sent")
            else:
                log_warn("Heartbeat failed")
        except Exception as e:
            log_warn(f"Heartbeat error: {e}")
        # Wait for interval or until shutdown
        shutdown_event.wait(HEARTBEAT_INTERVAL)


def _cleanup(exit_code: int, error_message: str):
    """
    Cleanup and notify server.
    This function is called in the finally block to ensure it always runs.
    """
    log_info("▷ Cleanup")

    # Perform final telemetry upload before completion
    # This ensures all remaining data is captured
    telemetry_start = time.time()
    telemetry_success = True
    try:
        final_telemetry_upload()
    except Exception as e:
        telemetry_success = False
        log_error(f"Final telemetry upload failed: {e}")
    record_sandbox_op("final_telemetry_upload", int((time.time() - telemetry_start) * 1000), telemetry_success)

    # Always call complete API at the end
    # This sends vm0_result (on success) or vm0_error (on failure) and kills the sandbox
    log_info(f"Calling complete API with exitCode={exit_code}")

    complete_payload = {
        "runId": RUN_ID,
        "exitCode": exit_code
    }
    if error_message:
        complete_payload["error"] = error_message

    complete_start = time.time()
    complete_success = False
    try:
        if http_post_json(COMPLETE_URL, complete_payload):
            log_info("Complete API called successfully")
            complete_success = True
        else:
            log_error("Failed to call complete API (sandbox may not be cleaned up)")
    except Exception as e:
        log_error(f"Complete API call failed: {e}")
    record_sandbox_op("complete_api_call", int((time.time() - complete_start) * 1000), complete_success)

    # Stop heartbeat thread
    shutdown_event.set()
    log_info("Heartbeat thread stopped")

    # Log final status
    if exit_code == 0:
        log_info("✓ Sandbox finished successfully")
    else:
        log_info(f"✗ Sandbox failed (exit code {exit_code})")


def _run() -> tuple[int, str]:
    """
    Main execution logic.
    Raises exceptions on failure instead of calling sys.exit().
    Returns (exit_code, error_message) tuple on completion.
    """
    # Validate configuration - raises ValueError if invalid
    validate_config()

    # Lifecycle: Header
    log_info(f"▶ VM0 Sandbox {RUN_ID}")

    # Lifecycle: Initialization
    log_info("▷ Initialization")
    init_start_time = time.time()

    log_info(f"Working directory: {WORKING_DIR}")

    # Start heartbeat thread
    heartbeat_start = time.time()
    heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    heartbeat_thread.start()
    log_info("Heartbeat thread started")
    record_sandbox_op("heartbeat_start", int((time.time() - heartbeat_start) * 1000), True)

    # Start metrics collector thread
    metrics_start = time.time()
    start_metrics_collector(shutdown_event)
    log_info("Metrics collector thread started")
    record_sandbox_op("metrics_collector_start", int((time.time() - metrics_start) * 1000), True)

    # Start telemetry upload thread
    telemetry_start = time.time()
    start_telemetry_upload(shutdown_event)
    log_info("Telemetry upload thread started")
    record_sandbox_op("telemetry_upload_start", int((time.time() - telemetry_start) * 1000), True)

    # Create and change to working directory - raises RuntimeError if fails
    # Directory may not exist if no artifact/storage was downloaded (e.g., first run)
    working_dir_start = time.time()
    working_dir_success = True
    try:
        os.makedirs(WORKING_DIR, exist_ok=True)
        os.chdir(WORKING_DIR)
    except OSError as e:
        working_dir_success = False
        record_sandbox_op("working_dir_setup", int((time.time() - working_dir_start) * 1000), False, str(e))
        raise RuntimeError(f"Failed to create/change to working directory: {WORKING_DIR} - {e}") from e
    record_sandbox_op("working_dir_setup", int((time.time() - working_dir_start) * 1000), working_dir_success)

    # Set up Codex configuration if using Codex CLI
    # Claude Code uses ~/.claude by default (no configuration needed)
    if CLI_AGENT_TYPE == "codex":
        home_dir = os.environ.get("HOME", "/home/user")
        # Codex uses ~/.codex for configuration and session storage
        codex_home = f"{home_dir}/.codex"
        os.makedirs(codex_home, exist_ok=True)
        os.environ["CODEX_HOME"] = codex_home
        log_info(f"Codex home directory: {codex_home}")

        # Login with API key via stdin (recommended method)
        codex_login_start = time.time()
        codex_login_success = False
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if api_key:
            result = subprocess.run(
                ["codex", "login", "--with-api-key"],
                input=api_key,
                text=True,
                capture_output=True
            )
            if result.returncode == 0:
                log_info("Codex authenticated with API key")
                codex_login_success = True
            else:
                log_error(f"Codex login failed: {result.stderr}")
        else:
            log_error("OPENAI_API_KEY not set")
        record_sandbox_op("codex_login", int((time.time() - codex_login_start) * 1000), codex_login_success)

    init_duration_ms = int((time.time() - init_start_time) * 1000)
    record_sandbox_op("init_total", init_duration_ms, True)
    log_info(f"✓ Initialization complete ({init_duration_ms // 1000}s)")

    # Lifecycle: Execution
    log_info("▷ Execution")
    exec_start_time = time.time()

    # Execute CLI agent with JSONL output
    log_info(f"Starting {CLI_AGENT_TYPE} execution...")
    log_info(f"Prompt: {PROMPT}")

    # Build command based on CLI agent type
    use_mock = os.environ.get("USE_MOCK_CLAUDE") == "true"

    if CLI_AGENT_TYPE == "codex":
        # Build Codex command
        if use_mock:
            # Mock mode not yet supported for Codex
            raise RuntimeError("Mock mode not supported for Codex")

        if RESUME_SESSION_ID:
            # Codex resume uses subcommand: codex exec resume <session_id> <prompt>
            log_info(f"Resuming session: {RESUME_SESSION_ID}")
            codex_args = [
                "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "-C", WORKING_DIR,
            ]
            if OPENAI_MODEL:
                codex_args.extend(["-m", OPENAI_MODEL])
            codex_args.extend(["resume", RESUME_SESSION_ID, PROMPT])
            cmd = ["codex"] + codex_args
        else:
            log_info("Starting new session")
            codex_args = [
                "exec",
                "--json",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "-C", WORKING_DIR,
            ]
            if OPENAI_MODEL:
                log_info(f"Using model: {OPENAI_MODEL}")
                codex_args.extend(["-m", OPENAI_MODEL])
            cmd = ["codex"] + codex_args + [PROMPT]
    else:
        # Build Claude command - unified for both new and resume sessions
        claude_args = [
            "--print", "--verbose",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions"
        ]

        if RESUME_SESSION_ID:
            log_info(f"Resuming session: {RESUME_SESSION_ID}")
            claude_args.extend(["--resume", RESUME_SESSION_ID])
        else:
            log_info("Starting new session")

        # Select Claude binary - use mock-claude for testing if USE_MOCK_CLAUDE is set
        if use_mock:
            claude_bin = "/usr/local/bin/vm0-agent/lib/mock_claude.py"
            log_info("Using mock-claude for testing")
        else:
            claude_bin = "claude"

        # Build full command
        cmd = [claude_bin] + claude_args + [PROMPT]

    # Execute CLI agent and process output stream
    # Capture both stdout and stderr, write to log file, keep stderr in memory for error extraction
    agent_exit_code = 0
    stderr_lines = []  # Keep stderr in memory for error message extraction
    log_file = None

    try:
        # Open log file directly in /tmp (no need to create directory)
        log_file = open(AGENT_LOG_FILE, "w")

        # Python subprocess.PIPE can deadlock if buffer fills up
        # Use a background thread to drain stderr while we read stdout
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1  # Line buffered for real-time processing
        )

        # Read stderr in background to prevent buffer deadlock
        def read_stderr():
            try:
                for line in proc.stderr:
                    stderr_lines.append(line)
                    if log_file and not log_file.closed:
                        log_file.write(f"[STDERR] {line}")
                        log_file.flush()
            except Exception:
                pass  # Ignore errors if file closed

        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stderr_thread.start()

        # Sequence counter for events (1-based)
        event_sequence = 0

        # Process JSONL output line by line from stdout
        for line in proc.stdout:
            # Write raw line to log file
            if log_file and not log_file.closed:
                log_file.write(line)
                log_file.flush()

            stripped = line.strip()

            # Skip empty lines
            if not stripped:
                continue

            # Check if line is valid JSON (stdout should only contain JSONL)
            try:
                event = json.loads(stripped)

                # Valid JSONL - send immediately with sequence number
                event_sequence += 1
                send_event(event, event_sequence)

                # Extract result from "result" event for stdout
                if event.get("type") == "result":
                    result_content = event.get("result", "")
                    if result_content:
                        print(result_content)

            except json.JSONDecodeError:
                # Not valid JSON, skip
                pass

        # Wait for process to complete
        proc.wait()
        # Wait for stderr thread to finish (with timeout to avoid hanging)
        stderr_thread.join(timeout=10)
        agent_exit_code = proc.returncode

    except Exception as e:
        log_error(f"Failed to execute {CLI_AGENT_TYPE}: {e}")
        agent_exit_code = 1
    finally:
        if log_file and not log_file.closed:
            log_file.close()

    # Print newline after output
    print()

    # Track final exit code for complete API
    final_exit_code = agent_exit_code
    error_message = ""

    # Check if any events failed to send
    if os.path.exists(EVENT_ERROR_FLAG):
        log_error("Some events failed to send, marking run as failed")
        final_exit_code = 1
        error_message = "Some events failed to send"

    # Log execution result and record metric
    exec_duration_ms = int((time.time() - exec_start_time) * 1000)
    record_sandbox_op("cli_execution", exec_duration_ms, agent_exit_code == 0)
    if agent_exit_code == 0 and final_exit_code == 0:
        log_info(f"✓ Execution complete ({exec_duration_ms // 1000}s)")
    else:
        log_info(f"✗ Execution failed ({exec_duration_ms // 1000}s)")

    # Handle completion
    if agent_exit_code == 0 and final_exit_code == 0:
        log_info(f"{CLI_AGENT_TYPE} completed successfully")

        # Lifecycle: Checkpoint
        log_info("▷ Checkpoint")
        checkpoint_start_time = time.time()

        # Create checkpoint - this is mandatory for successful runs
        checkpoint_success = create_checkpoint()
        checkpoint_duration = int(time.time() - checkpoint_start_time)

        if checkpoint_success:
            log_info(f"✓ Checkpoint complete ({checkpoint_duration}s)")
        else:
            log_info(f"✗ Checkpoint failed ({checkpoint_duration}s)")

        if not checkpoint_success:
            log_error("Checkpoint creation failed, marking run as failed")
            final_exit_code = 1
            error_message = "Checkpoint creation failed"
    else:
        if agent_exit_code != 0:
            log_info(f"{CLI_AGENT_TYPE} failed with exit code {agent_exit_code}")

            # Get detailed error from captured stderr lines in memory
            if stderr_lines:
                error_message = " ".join(line.strip() for line in stderr_lines)
                log_info(f"Captured stderr: {error_message}")
            else:
                error_message = f"Agent exited with code {agent_exit_code}"

    # Note: Keep all temp files for debugging (SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE, EVENT_ERROR_FLAG)

    return final_exit_code, error_message


def main() -> int:
    """
    Main entry point for agent execution.
    Uses try/except/finally to ensure cleanup always runs.
    Returns exit code (0 for success, non-zero for failure).
    """
    exit_code = 1  # Default to failure
    error_message = "Unexpected termination"

    try:
        exit_code, error_message = _run()

    except ValueError as e:
        # Configuration validation errors
        exit_code = 1
        error_message = str(e)
        log_error(f"Configuration error: {error_message}")

    except RuntimeError as e:
        # Runtime errors (e.g., working directory not found)
        exit_code = 1
        error_message = str(e)
        log_error(f"Runtime error: {error_message}")

    except Exception as e:
        # Catch-all for unexpected exceptions
        exit_code = 1
        error_message = f"Unexpected error: {e}"
        log_error(error_message)

    finally:
        # Always cleanup and notify server
        _cleanup(exit_code, error_message)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
`;
