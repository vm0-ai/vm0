/**
 * Event sending script for agent execution (Python)
 * Sends JSONL events to the webhook endpoint
 */
export const EVENTS_SCRIPT = `#!/usr/bin/env python3
"""
Event sending module for VM0 agent scripts.
Sends JSONL events to the webhook endpoint.
"""
import os
from typing import Dict, Any

from common import (
    RUN_ID, WORKING_DIR, WEBHOOK_URL,
    SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE, EVENT_ERROR_FLAG
)
from log import log_info, log_error
from http_client import http_post_json


def send_event(event: Dict[str, Any]) -> bool:
    """
    Send single event immediately to webhook.

    Args:
        event: Event dictionary to send

    Returns:
        True on success, False on failure
    """
    # Extract session ID from init event
    event_type = event.get("type", "")
    event_subtype = event.get("subtype", "")

    if event_type == "system" and event_subtype == "init":
        if not os.path.exists(SESSION_ID_FILE):
            session_id = event.get("session_id", "")
            if session_id:
                log_info(f"Captured session ID: {session_id}")

                # Save to temp file to persist across subprocesses
                with open(SESSION_ID_FILE, "w") as f:
                    f.write(session_id)

                # Calculate session history path
                # Claude Code uses hyphen-separated path encoding
                # e.g., /home/user/workspace -> -home-user-workspace
                project_name = WORKING_DIR.lstrip("/").replace("/", "-")
                home_dir = os.environ.get("HOME", "/home/user")
                session_history_path = f"{home_dir}/.config/claude/projects/-{project_name}/{session_id}.jsonl"

                with open(SESSION_HISTORY_PATH_FILE, "w") as f:
                    f.write(session_history_path)

                log_info(f"Session history will be at: {session_history_path}")

    # Build payload
    payload = {
        "runId": RUN_ID,
        "events": [event]
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
