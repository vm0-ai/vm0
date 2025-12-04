/**
 * Mock Claude CLI script for testing (Python)
 * Executes the prompt as a bash command and outputs Claude-compatible JSONL
 * This allows e2e tests to run without calling the real Claude LLM API
 *
 * Special test prefixes:
 * - @fail:<message> - Simulate Claude failure, outputs message to stderr and exits with code 1
 */
export const MOCK_CLAUDE_SCRIPT = `#!/usr/bin/env python3
"""
Mock Claude CLI for testing.
Executes prompt as bash and outputs Claude-compatible JSONL.

Usage: mock_claude.py [options] <prompt>
The prompt is executed as a bash command.

Special test prefixes:
  @fail:<message> - Output message to stderr and exit with code 1
"""
import os
import sys
import json
import subprocess
import time
import argparse


def json_escape(s: str) -> str:
    """Escape string for JSON."""
    return json.dumps(s)


def create_session_history(session_id: str, cwd: str) -> str:
    """
    Create session history file for checkpoint compatibility.
    Claude Code stores session history at: ~/.config/claude/projects/-{path}/{session_id}.jsonl
    """
    project_name = cwd.lstrip("/").replace("/", "-")
    home_dir = os.environ.get("HOME", "/home/user")
    session_dir = f"{home_dir}/.config/claude/projects/-{project_name}"
    os.makedirs(session_dir, exist_ok=True)
    return f"{session_dir}/{session_id}.jsonl"


def main():
    """Main entry point for mock Claude."""
    # Generate session ID
    session_id = f"mock-{int(time.time() * 1000000)}"

    # Parse arguments (same as real claude CLI)
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--output-format", default="text")
    parser.add_argument("--print", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--dangerously-skip-permissions", action="store_true")
    parser.add_argument("--resume", default=None)
    parser.add_argument("prompt", nargs="?", default="")

    args, unknown = parser.parse_known_args()

    # Get prompt from remaining args if not set
    prompt = args.prompt
    if not prompt and unknown:
        prompt = unknown[0]

    output_format = args.output_format

    # Special test prefix: @fail:<message> - simulate Claude failure with stderr output
    # Usage: mock-claude "@fail:Session not found"
    # This outputs the message to stderr and exits with code 1
    if prompt.startswith("@fail:"):
        error_msg = prompt[6:]  # Remove "@fail:" prefix
        print(error_msg, file=sys.stderr)
        sys.exit(1)

    # Get current working directory
    cwd = os.getcwd()

    if output_format == "stream-json":
        # Create session history file path
        session_history_file = create_session_history(session_id, cwd)

        events = []

        # 1. System init event
        init_event = {
            "type": "system",
            "subtype": "init",
            "cwd": cwd,
            "session_id": session_id,
            "tools": ["Bash"],
            "model": "mock-claude"
        }
        print(json.dumps(init_event))
        events.append(init_event)

        # 2. Assistant text event
        text_event = {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Executing command..."}]
            },
            "session_id": session_id
        }
        print(json.dumps(text_event))
        events.append(text_event)

        # 3. Assistant tool_use event
        tool_use_event = {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_mock_001",
                    "name": "Bash",
                    "input": {"command": prompt}
                }]
            },
            "session_id": session_id
        }
        print(json.dumps(tool_use_event))
        events.append(tool_use_event)

        # 4. Execute prompt as bash and capture output
        try:
            result = subprocess.run(
                ["bash", "-c", prompt],
                capture_output=True,
                text=True
            )
            output = result.stdout + result.stderr
            exit_code = result.returncode
        except Exception as e:
            output = str(e)
            exit_code = 1

        # 5. User tool_result event
        is_error = exit_code != 0
        tool_result_event = {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_mock_001",
                    "content": output,
                    "is_error": is_error
                }]
            },
            "session_id": session_id
        }
        print(json.dumps(tool_result_event))
        events.append(tool_result_event)

        # 6. Result event
        if exit_code == 0:
            result_event = {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "duration_ms": 100,
                "num_turns": 1,
                "result": output,
                "session_id": session_id,
                "total_cost_usd": 0,
                "usage": {"input_tokens": 0, "output_tokens": 0}
            }
        else:
            result_event = {
                "type": "result",
                "subtype": "error",
                "is_error": True,
                "duration_ms": 100,
                "num_turns": 1,
                "result": output,
                "session_id": session_id,
                "total_cost_usd": 0,
                "usage": {"input_tokens": 0, "output_tokens": 0}
            }
        print(json.dumps(result_event))
        events.append(result_event)

        # Write all events to session history file
        with open(session_history_file, "w") as f:
            for event in events:
                f.write(json.dumps(event) + "\\n")

        sys.exit(exit_code)

    else:
        # Plain text output - just execute the prompt
        try:
            result = subprocess.run(
                ["bash", "-c", prompt],
                capture_output=False
            )
            sys.exit(result.returncode)
        except Exception as e:
            print(str(e), file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
`;
