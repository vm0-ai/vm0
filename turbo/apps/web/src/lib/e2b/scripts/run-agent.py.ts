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
"""
import os
import sys
import subprocess
import json

# Add lib to path for imports
sys.path.insert(0, "/usr/local/bin/vm0-agent/lib")

from common import (
    WORKING_DIR, PROMPT, RESUME_SESSION_ID, COMPLETE_URL, RUN_ID,
    SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE, EVENT_ERROR_FLAG, STDERR_FILE,
    validate_config
)
from log import log_info, log_error
from events import send_event
from checkpoint import create_checkpoint
from http_client import http_post_json


def main():
    """Main entry point for agent execution."""
    # Validate configuration
    validate_config()

    log_info(f"Working directory: {WORKING_DIR}")

    # Change to working directory
    try:
        os.chdir(WORKING_DIR)
    except OSError as e:
        log_error(f"Failed to change to working directory: {WORKING_DIR} - {e}")
        sys.exit(1)

    # Set Claude config directory to ensure consistent session history location
    home_dir = os.environ.get("HOME", "/home/user")
    os.environ["CLAUDE_CONFIG_DIR"] = f"{home_dir}/.config/claude"
    log_info(f"Claude config directory: {os.environ['CLAUDE_CONFIG_DIR']}")

    # Execute Claude Code with JSONL output
    log_info("Starting Claude Code execution...")
    log_info(f"Prompt: {PROMPT}")

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
    use_mock = os.environ.get("USE_MOCK_CLAUDE") == "true"
    if use_mock:
        claude_bin = "/usr/local/bin/vm0-agent/lib/mock_claude.py"
        log_info("Using mock-claude for testing")
    else:
        claude_bin = "claude"

    # Build full command
    cmd = [claude_bin] + claude_args + [PROMPT]

    # Execute Claude and process output stream
    # Redirect stderr to file for error capture, process stdout (JSONL) in pipe
    claude_exit_code = 0

    try:
        with open(STDERR_FILE, "w") as stderr_file:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=stderr_file,
                text=True,
                bufsize=1  # Line buffered for real-time processing
            )

            # Process JSONL output line by line
            for line in proc.stdout:
                line = line.strip()

                # Skip empty lines
                if not line:
                    continue

                # Check if line is valid JSON (stdout should only contain JSONL)
                try:
                    event = json.loads(line)

                    # Valid JSONL - send immediately
                    send_event(event)

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
            claude_exit_code = proc.returncode

    except Exception as e:
        log_error(f"Failed to execute Claude: {e}")
        claude_exit_code = 1

    # Print newline after output
    print()

    # Track final exit code for complete API
    final_exit_code = claude_exit_code
    error_message = ""

    # Check if any events failed to send
    if os.path.exists(EVENT_ERROR_FLAG):
        log_error("Some events failed to send, marking run as failed")
        final_exit_code = 1
        error_message = "Some events failed to send"

    # Handle completion
    if claude_exit_code == 0 and final_exit_code == 0:
        log_info("Claude Code completed successfully")

        # Create checkpoint - this is mandatory for successful runs
        if not create_checkpoint():
            log_error("Checkpoint creation failed, marking run as failed")
            final_exit_code = 1
            error_message = "Checkpoint creation failed"
    else:
        if claude_exit_code != 0:
            log_info(f"Claude Code failed with exit code {claude_exit_code}")

            # Try to get detailed error from stderr file
            if os.path.exists(STDERR_FILE) and os.path.getsize(STDERR_FILE) > 0:
                try:
                    with open(STDERR_FILE) as f:
                        lines = f.readlines()
                        # Get last few lines of stderr, clean up formatting
                        last_lines = lines[-5:] if len(lines) >= 5 else lines
                        error_message = " ".join(line.strip() for line in last_lines)
                    log_info(f"Captured stderr: {error_message}")
                except IOError:
                    error_message = f"Agent exited with code {claude_exit_code}"
            else:
                error_message = f"Agent exited with code {claude_exit_code}"

    # Always call complete API at the end
    # This sends vm0_result (on success) or vm0_error (on failure) and kills the sandbox
    log_info(f"Calling complete API with exitCode={final_exit_code}")

    complete_payload = {
        "runId": RUN_ID,
        "exitCode": final_exit_code
    }
    if error_message:
        complete_payload["error"] = error_message

    if http_post_json(COMPLETE_URL, complete_payload):
        log_info("Complete API called successfully")
    else:
        log_error("Failed to call complete API (sandbox may not be cleaned up)")

    # Cleanup temp files
    for temp_file in [SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE, EVENT_ERROR_FLAG, STDERR_FILE]:
        try:
            os.remove(temp_file)
        except OSError:
            pass

    sys.exit(final_exit_code)


if __name__ == "__main__":
    main()
`;
