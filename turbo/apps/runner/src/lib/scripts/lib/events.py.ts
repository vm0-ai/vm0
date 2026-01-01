/**
 * Event sending script for agent execution (Python)
 * Sends JSONL events to the webhook endpoint
 */
export const EVENTS_SCRIPT = `#!/usr/bin/env python3
"""
Event sending module for VM0 agent scripts.
Sends JSONL events to the webhook endpoint.
Masks secrets before sending using client-side masking.
"""
import os
from typing import Dict, Any

from common import (
    RUN_ID, WORKING_DIR, WEBHOOK_URL, CLI_AGENT_TYPE,
    SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE, EVENT_ERROR_FLAG
)
from log import log_info, log_error
from http_client import http_post_json
from secret_masker import mask_data


def send_event(event: Dict[str, Any], sequence_number: int) -> bool:
    """
    Send single event immediately to webhook.
    Masks secrets before sending.

    Args:
        event: Event dictionary to send
        sequence_number: Sequence number for this event (1-based, maintained by caller)

    Returns:
        True on success, False on failure
    """
    # Extract session ID from init event based on CLI agent type
    event_type = event.get("type", "")
    event_subtype = event.get("subtype", "")

    # Claude Code: session_id from system/init event
    # Codex: thread_id from thread.started event
    session_id = None
    if CLI_AGENT_TYPE == "codex":
        if event_type == "thread.started":
            session_id = event.get("thread_id", "")
    else:
        if event_type == "system" and event_subtype == "init":
            session_id = event.get("session_id", "")

    if session_id and not os.path.exists(SESSION_ID_FILE):
        log_info(f"Captured session ID: {session_id}")

        # Save to temp file to persist across subprocesses
        with open(SESSION_ID_FILE, "w") as f:
            f.write(session_id)

        # Calculate session history path based on CLI agent type
        home_dir = os.environ.get("HOME", "/home/user")

        if CLI_AGENT_TYPE == "codex":
            # Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
            # We'll store a marker path here; checkpoint.py will search for the actual file
            codex_home = os.environ.get("CODEX_HOME", f"{home_dir}/.codex")
            # Use special marker format that checkpoint.py will recognize
            session_history_path = f"CODEX_SEARCH:{codex_home}/sessions:{session_id}"
        else:
            # Claude Code uses ~/.claude (default, no CLAUDE_CONFIG_DIR override)
            # Path encoding: e.g., /home/user/workspace -> -home-user-workspace
            project_name = WORKING_DIR.lstrip("/").replace("/", "-")
            session_history_path = f"{home_dir}/.claude/projects/-{project_name}/{session_id}.jsonl"

        with open(SESSION_HISTORY_PATH_FILE, "w") as f:
            f.write(session_history_path)

        log_info(f"Session history will be at: {session_history_path}")

    # Add sequence number to event
    event["sequenceNumber"] = sequence_number

    # Mask secrets in event data before sending
    # This ensures secrets are never sent to the server in plaintext
    masked_event = mask_data(event)

    # Build payload with masked event
    payload = {
        "runId": RUN_ID,
        "events": [masked_event]
    }

    # Send event using HTTP request function
    result = http_post_json(WEBHOOK_URL, payload)

    if result is None:
        log_error("Failed to send event after retries")
        # Mark that event sending failed - run-agent will check this
        with open(EVENT_ERROR_FLAG, "w") as f:
            f.write("1")
        return False

    return True
`;
