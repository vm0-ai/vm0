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
    PROXY_ENABLED, validate_config
)
from log import log_header, log_phase, log_detail, log_success, log_failure
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
            http_post_json(HEARTBEAT_URL, {"runId": RUN_ID})
            # Heartbeat logs removed - they add noise
        except Exception:
            pass  # Silently ignore heartbeat errors
        # Wait for interval or until shutdown
        shutdown_event.wait(HEARTBEAT_INTERVAL)


def _cleanup(exit_code: int, error_message: str):
    """
    Cleanup and notify server.
    This function is called in the finally block to ensure it always runs.
    """
    log_phase("Cleaning up")

    # Perform final telemetry upload before completion
    # This ensures all remaining data is captured
    try:
        log_detail("Uploading final telemetry...")
        final_telemetry_upload()
    except Exception as e:
        log_detail(f"Final telemetry upload failed: {e}")

    # Always call complete API at the end
    # This sends vm0_result (on success) or vm0_error (on failure) and kills the sandbox
    log_detail("Calling complete API...")

    complete_payload = {
        "runId": RUN_ID,
        "exitCode": exit_code
    }
    if error_message:
        complete_payload["error"] = error_message

    try:
        if http_post_json(COMPLETE_URL, complete_payload):
            pass  # Success logged at end
        else:
            log_detail("Failed to call complete API")
    except Exception as e:
        log_detail(f"Complete API call failed: {e}")

    # Stop heartbeat thread
    shutdown_event.set()

    # Log final status
    if exit_code == 0:
        log_success("Sandbox finished successfully")
    else:
        log_failure(f"Sandbox failed (exit code {exit_code})")


def _run() -> tuple[int, str]:
    """
    Main execution logic.
    Raises exceptions on failure instead of calling sys.exit().
    Returns (exit_code, error_message) tuple on completion.
    """
    # Validate configuration - raises ValueError if invalid
    validate_config()

    # Log header with run ID
    log_header(RUN_ID)

    # Phase 1: Initialization
    log_phase("Initializing sandbox")
    log_detail(f"Working directory: {WORKING_DIR}")

    # Log proxy mode status
    if PROXY_ENABLED:
        log_detail("Network security mode enabled")

    # Start heartbeat thread (silent)
    heartbeat_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    heartbeat_thread.start()
    log_detail("Starting heartbeat service (60s interval)")

    # Start metrics collector thread
    start_metrics_collector(shutdown_event)
    log_detail("Starting metrics collector (5s interval)")

    # Start telemetry upload thread
    start_telemetry_upload(shutdown_event)
    log_detail("Starting telemetry uploader (30s interval)")

    # Create and change to working directory - raises RuntimeError if fails
    try:
        os.makedirs(WORKING_DIR, exist_ok=True)
        os.chdir(WORKING_DIR)
    except OSError as e:
        raise RuntimeError(f"Failed to create/change to working directory: {WORKING_DIR} - {e}") from e

    log_success("Sandbox initialized")

    # Phase 2: Execute Claude Code
    log_phase("Executing Claude Code")
    log_detail(f"Prompt: {PROMPT}")

    # Build Claude command - unified for both new and resume sessions
    claude_args = [
        "--print", "--verbose",
        "--output-format", "stream-json",
        "--dangerously-skip-permissions"
    ]

    if RESUME_SESSION_ID:
        log_detail(f"Resuming session: {RESUME_SESSION_ID}")
        claude_args.extend(["--resume", RESUME_SESSION_ID])
    else:
        log_detail("Starting new session")

    # Select Claude binary - use mock-claude for testing if USE_MOCK_CLAUDE is set
    use_mock = os.environ.get("USE_MOCK_CLAUDE") == "true"
    if use_mock:
        claude_bin = "/usr/local/bin/vm0-agent/lib/mock_claude.py"
        log_detail("Using mock-claude for testing")
    else:
        claude_bin = "claude"

    # Build full command
    cmd = [claude_bin] + claude_args + [PROMPT]

    # Track execution time
    exec_start_time = time.time()

    # Execute Claude and process output stream
    claude_exit_code = 0
    stderr_lines = []  # Keep stderr in memory for error message extraction
    log_file = None
    session_id_captured = False

    try:
        # Open log file directly in /tmp
        log_file = open(AGENT_LOG_FILE, "w")

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

            # Check if line is valid JSON
            try:
                event = json.loads(stripped)

                # Valid JSONL - send immediately
                send_event(event)

                # Log session ID when captured (from init event)
                if not session_id_captured and event.get("type") == "system" and event.get("subtype") == "init":
                    session_id = event.get("session_id", "")
                    if session_id:
                        log_detail(f"Session ID: {session_id}")
                        session_id_captured = True

                # Extract result from "result" event for stdout
                if event.get("type") == "result":
                    result_content = event.get("result", "")
                    if result_content:
                        print(result_content)

            except json.JSONDecodeError:
                pass

        # Wait for process to complete
        proc.wait()
        stderr_thread.join(timeout=10)
        claude_exit_code = proc.returncode

    except Exception as e:
        log_failure(f"Failed to execute Claude", str(e))
        claude_exit_code = 1
    finally:
        if log_file and not log_file.closed:
            log_file.close()

    # Print newline after output
    print()

    # Calculate duration
    exec_duration = int(time.time() - exec_start_time)

    # Track final exit code for complete API
    final_exit_code = claude_exit_code
    error_message = ""

    # Check if any events failed to send
    if os.path.exists(EVENT_ERROR_FLAG):
        final_exit_code = 1
        error_message = "Some events failed to send"

    # Handle Claude Code completion
    if claude_exit_code == 0 and final_exit_code == 0:
        log_success(f"Claude Code completed in {exec_duration}s")

        # Phase 3: Create checkpoint
        checkpoint_start_time = time.time()
        checkpoint_success = create_checkpoint()
        checkpoint_duration = int(time.time() - checkpoint_start_time)

        if not checkpoint_success:
            final_exit_code = 1
            error_message = "Checkpoint creation failed"
    else:
        # Get detailed error from captured stderr lines
        if stderr_lines:
            error_message = " ".join(line.strip() for line in stderr_lines)
        else:
            error_message = f"Agent exited with code {claude_exit_code}"

        log_failure(f"Claude Code failed (exit code {claude_exit_code})", error_message)

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
        log_failure("Configuration error", error_message)

    except RuntimeError as e:
        # Runtime errors (e.g., working directory not found)
        exit_code = 1
        error_message = str(e)
        log_failure("Runtime error", error_message)

    except Exception as e:
        # Catch-all for unexpected exceptions
        exit_code = 1
        error_message = f"Unexpected error: {e}"
        log_failure("Unexpected error", str(e))

    finally:
        # Always cleanup and notify server
        _cleanup(exit_code, error_message)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
`;
