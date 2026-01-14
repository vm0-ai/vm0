/**
 * Checkpoint creation script (Python)
 * Creates checkpoints with conversation history and optional artifact snapshot (VAS only)
 * Uses direct S3 upload to bypass Vercel 4.5MB limit
 */
export const CHECKPOINT_SCRIPT = `#!/usr/bin/env python3
"""
Checkpoint creation module.
Creates checkpoints with conversation history and optional artifact snapshot (VAS only).
Uses direct S3 upload exclusively (no fallback to legacy methods).
"""
import os
import glob
import time
from typing import Optional, Dict, Any

from common import (
    RUN_ID, CHECKPOINT_URL,
    SESSION_ID_FILE, SESSION_HISTORY_PATH_FILE,
    ARTIFACT_DRIVER, ARTIFACT_MOUNT_PATH, ARTIFACT_VOLUME_NAME,
    record_sandbox_op
)
from log import log_info, log_error
from http_client import http_post_json
from direct_upload import create_direct_upload_snapshot


def find_codex_session_file(sessions_dir: str, session_id: str) -> Optional[str]:
    """
    Find Codex session file by searching in date-organized directories.
    Codex stores sessions in: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

    Args:
        sessions_dir: Base sessions directory (e.g., ~/.codex/sessions)
        session_id: Session ID to find (e.g., 019b3aca-2df2-7573-8f88-4240b7bc350a)

    Returns:
        Full path to session file, or None if not found
    """
    # Search for session file containing the session ID
    # Pattern: sessions/YYYY/MM/DD/rollout-*-{session_id_parts}.jsonl
    # The session ID parts may be separated by dashes in the filename

    # First, try searching all JSONL files recursively
    search_pattern = os.path.join(sessions_dir, "**", "*.jsonl")
    files = glob.glob(search_pattern, recursive=True)

    log_info(f"Searching for Codex session {session_id} in {len(files)} files")

    # The session ID in Codex filenames uses the format with dashes
    # e.g., rollout-2025-12-20T08-04-44-019b3aca-2df2-7573-8f88-4240b7bc350a.jsonl
    for filepath in files:
        filename = os.path.basename(filepath)
        # Check if session ID is in the filename
        if session_id in filename or session_id.replace("-", "") in filename.replace("-", ""):
            log_info(f"Found Codex session file: {filepath}")
            return filepath

    # If not found by ID match, get the most recent file (fallback)
    if files:
        # Sort by modification time, newest first
        files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
        most_recent = files[0]
        log_info(f"Session ID not found in filenames, using most recent: {most_recent}")
        return most_recent

    return None


def create_checkpoint() -> bool:
    """
    Create checkpoint after successful run.

    Returns:
        True on success, False on failure
    """
    checkpoint_start = time.time()
    log_info("Creating checkpoint...")

    # Read session ID from temp file
    session_id_start = time.time()
    if not os.path.exists(SESSION_ID_FILE):
        log_error("No session ID found, checkpoint creation failed")
        record_sandbox_op("session_id_read", int((time.time() - session_id_start) * 1000), False, "Session ID file not found")
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
        return False

    with open(SESSION_ID_FILE) as f:
        cli_agent_session_id = f.read().strip()
    record_sandbox_op("session_id_read", int((time.time() - session_id_start) * 1000), True)

    # Read session history path from temp file
    session_history_start = time.time()
    if not os.path.exists(SESSION_HISTORY_PATH_FILE):
        log_error("No session history path found, checkpoint creation failed")
        record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), False, "Session history path file not found")
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
        return False

    with open(SESSION_HISTORY_PATH_FILE) as f:
        session_history_path_raw = f.read().strip()

    # Handle Codex session search marker format: CODEX_SEARCH:{sessions_dir}:{session_id}
    if session_history_path_raw.startswith("CODEX_SEARCH:"):
        parts = session_history_path_raw.split(":", 2)
        if len(parts) != 3:
            log_error(f"Invalid Codex search marker format: {session_history_path_raw}")
            record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), False, "Invalid Codex search marker")
            record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
            return False
        sessions_dir = parts[1]
        codex_session_id = parts[2]
        log_info(f"Searching for Codex session in {sessions_dir}")
        session_history_path = find_codex_session_file(sessions_dir, codex_session_id)
        if not session_history_path:
            log_error(f"Could not find Codex session file for {codex_session_id} in {sessions_dir}")
            record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), False, "Codex session file not found")
            record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
            return False
    else:
        session_history_path = session_history_path_raw

    # Check if session history file exists
    if not os.path.exists(session_history_path):
        log_error(f"Session history file not found at {session_history_path}, checkpoint creation failed")
        record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), False, "Session history file not found")
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
        return False

    # Read session history
    try:
        with open(session_history_path) as f:
            cli_agent_session_history = f.read()
    except IOError as e:
        log_error(f"Failed to read session history: {e}")
        record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), False, str(e))
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
        return False

    if not cli_agent_session_history.strip():
        log_error("Session history is empty, checkpoint creation failed")
        record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), False, "Session history empty")
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
        return False

    line_count = len(cli_agent_session_history.strip().split("\\n"))
    log_info(f"Session history loaded ({line_count} lines)")
    record_sandbox_op("session_history_read", int((time.time() - session_history_start) * 1000), True)

    # CLI agent type (default to claude-code)
    cli_agent_type = os.environ.get("CLI_AGENT_TYPE", "claude-code")

    # Create artifact snapshot (VAS only, optional)
    # If artifact is not configured, checkpoint is created without artifact snapshot
    artifact_snapshot = None

    if ARTIFACT_DRIVER and ARTIFACT_VOLUME_NAME:
        log_info(f"Processing artifact with driver: {ARTIFACT_DRIVER}")

        if ARTIFACT_DRIVER != "vas":
            log_error(f"Unknown artifact driver: {ARTIFACT_DRIVER} (only 'vas' is supported)")
            record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
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
            record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
            return False

        # Extract versionId from snapshot response
        artifact_version = snapshot.get("versionId")
        if not artifact_version:
            log_error("Failed to extract versionId from snapshot")
            record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
            return False

        # Build artifact snapshot JSON with new format (artifactName + artifactVersion)
        artifact_snapshot = {
            "artifactName": ARTIFACT_VOLUME_NAME,
            "artifactVersion": artifact_version
        }

        log_info(f"VAS artifact snapshot created: {ARTIFACT_VOLUME_NAME}@{artifact_version}")
    else:
        log_info("No artifact configured, creating checkpoint without artifact snapshot")

    log_info("Calling checkpoint API...")

    # Build checkpoint payload with new schema
    checkpoint_payload = {
        "runId": RUN_ID,
        "cliAgentType": cli_agent_type,
        "cliAgentSessionId": cli_agent_session_id,
        "cliAgentSessionHistory": cli_agent_session_history
    }

    # Only add artifact snapshot if present
    if artifact_snapshot:
        checkpoint_payload["artifactSnapshot"] = artifact_snapshot

    # Call checkpoint API
    api_call_start = time.time()
    result = http_post_json(CHECKPOINT_URL, checkpoint_payload)

    # Validate response contains checkpointId to confirm checkpoint was actually created
    # Note: result can be {} (empty dict) on network issues, which is not None but invalid
    if result and result.get("checkpointId"):
        checkpoint_id = result.get("checkpointId")
        log_info(f"Checkpoint created successfully: {checkpoint_id}")
        record_sandbox_op("checkpoint_api_call", int((time.time() - api_call_start) * 1000), True)
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), True)
        return True
    else:
        log_error(f"Checkpoint API returned invalid response: {result}")
        record_sandbox_op("checkpoint_api_call", int((time.time() - api_call_start) * 1000), False, "Invalid API response")
        record_sandbox_op("checkpoint_total", int((time.time() - checkpoint_start) * 1000), False)
        return False
`;
