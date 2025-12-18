/**
 * Checkpoint creation script (Python)
 * Creates checkpoints with conversation history and artifact snapshot (VAS only)
 * Uses direct S3 upload to bypass Vercel 4.5MB limit
 */
export const CHECKPOINT_SCRIPT = `#!/usr/bin/env python3
"""
Checkpoint creation module.
Creates checkpoints with conversation history and artifact snapshot (VAS only).
Uses direct S3 upload exclusively (no fallback to legacy methods).
"""
import os
from typing import Optional, Dict, Any

from common import (
    RUN_ID, CHECKPOINT_URL,
    SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE,
    ARTIFACT_DRIVER, ARTIFACT_MOUNT_PATH, ARTIFACT_VOLUME_NAME
)
from log import log_info, log_error
from http_client import http_post_json
from direct_upload import create_direct_upload_snapshot


def create_checkpoint() -> bool:
    """
    Create checkpoint after successful run.

    Returns:
        True on success, False on failure
    """
    log_info("Creating checkpoint...")

    # Read session ID from temp file
    if not os.path.exists(SESSION_ID_FILE):
        log_error("No session ID found, checkpoint creation failed")
        return False

    with open(SESSION_ID_FILE) as f:
        cli_agent_session_id = f.read().strip()

    # Read session history path from temp file
    if not os.path.exists(SESSION_HISTORY_PATH_FILE):
        log_error("No session history path found, checkpoint creation failed")
        return False

    with open(SESSION_HISTORY_PATH_FILE) as f:
        session_history_path = f.read().strip()

    # Check if session history file exists
    if not os.path.exists(session_history_path):
        log_error(f"Session history file not found at {session_history_path}, checkpoint creation failed")
        return False

    # Read session history
    try:
        with open(session_history_path) as f:
            cli_agent_session_history = f.read()
    except IOError as e:
        log_error(f"Failed to read session history: {e}")
        return False

    if not cli_agent_session_history.strip():
        log_error("Session history is empty, checkpoint creation failed")
        return False

    line_count = len(cli_agent_session_history.strip().split("\\n"))
    log_info(f"Session history loaded ({line_count} lines)")

    # CLI agent type (default to claude-code)
    cli_agent_type = os.environ.get("CLI_AGENT_TYPE", "claude-code")

    # Create artifact snapshot (VAS only, required)
    if not ARTIFACT_DRIVER or not ARTIFACT_VOLUME_NAME:
        log_error("Artifact is required but not configured")
        return False

    log_info(f"Processing artifact with driver: {ARTIFACT_DRIVER}")

    if ARTIFACT_DRIVER != "vas":
        log_error(f"Unknown artifact driver: {ARTIFACT_DRIVER} (only 'vas' is supported)")
        return False

    # VAS artifact: create snapshot using direct S3 upload (bypasses Vercel 4.5MB limit)
    log_info(f"Creating VAS snapshot for artifact '{ARTIFACT_VOLUME_NAME}' at {ARTIFACT_MOUNT_PATH}")
    log_info("Using direct S3 upload...")

    snapshot = create_direct_upload_snapshot(
        ARTIFACT_MOUNT_PATH,
        ARTIFACT_VOLUME_NAME,
        "artifact",
        RUN_ID,
        f"Checkpoint from run {RUN_ID}"
    )

    if not snapshot:
        log_error("Failed to create VAS snapshot for artifact")
        return False

    # Extract versionId from snapshot response
    artifact_version = snapshot.get("versionId")
    if not artifact_version:
        log_error("Failed to extract versionId from snapshot")
        return False

    # Build artifact snapshot JSON with new format (artifactName + artifactVersion)
    artifact_snapshot = {
        "artifactName": ARTIFACT_VOLUME_NAME,
        "artifactVersion": artifact_version
    }

    log_info(f"VAS artifact snapshot created: {ARTIFACT_VOLUME_NAME}@{artifact_version}")

    log_info("Calling checkpoint API...")

    # Build checkpoint payload with new schema
    checkpoint_payload = {
        "runId": RUN_ID,
        "cliAgentType": cli_agent_type,
        "cliAgentSessionId": cli_agent_session_id,
        "cliAgentSessionHistory": cli_agent_session_history,
        "artifactSnapshot": artifact_snapshot
    }

    # Call checkpoint API
    result = http_post_json(CHECKPOINT_URL, checkpoint_payload)

    # Validate response contains checkpointId to confirm checkpoint was actually created
    # Note: result can be {} (empty dict) on network issues, which is not None but invalid
    if result and result.get("checkpointId"):
        checkpoint_id = result.get("checkpointId")
        log_info(f"Checkpoint created successfully: {checkpoint_id}")
        return True
    else:
        log_error(f"Checkpoint API returned invalid response: {result}")
        return False
`;
