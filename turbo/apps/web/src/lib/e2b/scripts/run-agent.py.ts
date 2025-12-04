/**
 * Python agent execution script
 * This replaces the bash-based run-agent.sh with a more robust Python implementation
 */
export const RUN_AGENT_PYTHON_SCRIPT = `#!/usr/bin/env python3
"""
VM0 Agent Runner - Python Implementation
Executes Claude Code agent and handles event streaming, checkpointing, and completion.
"""

import json
import os
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


# =============================================================================
# Configuration from environment variables
# =============================================================================

class Config:
    def __init__(self):
        self.run_id = os.environ.get("VM0_RUN_ID", "")
        self.api_url = os.environ.get("VM0_API_URL", "")
        self.api_token = os.environ.get("VM0_API_TOKEN", "")
        self.prompt = os.environ.get("VM0_PROMPT", "")
        self.vercel_bypass = os.environ.get("VERCEL_PROTECTION_BYPASS", "")
        self.resume_session_id = os.environ.get("VM0_RESUME_SESSION_ID", "")
        self.working_dir = os.environ.get("VM0_WORKING_DIR", "")
        self.use_mock_claude = os.environ.get("USE_MOCK_CLAUDE", "") == "true"

        # Artifact configuration
        self.artifact_driver = os.environ.get("VM0_ARTIFACT_DRIVER", "")
        self.artifact_mount_path = os.environ.get("VM0_ARTIFACT_MOUNT_PATH", "")
        self.artifact_volume_name = os.environ.get("VM0_ARTIFACT_VOLUME_NAME", "")
        self.artifact_version_id = os.environ.get("VM0_ARTIFACT_VERSION_ID", "")
        self.artifact_manifest_url = os.environ.get("VM0_ARTIFACT_MANIFEST_URL", "")

        # Webhook URLs
        self.webhook_url = f"{self.api_url}/api/webhooks/agent/events"
        self.checkpoint_url = f"{self.api_url}/api/webhooks/agent/checkpoints"
        self.complete_url = f"{self.api_url}/api/webhooks/agent/complete"
        self.storage_webhook_url = f"{self.api_url}/api/webhooks/agent/storages"
        self.incremental_webhook_url = f"{self.api_url}/api/webhooks/agent/storages/incremental"

        # HTTP settings
        self.http_connect_timeout = 10
        self.http_max_time = 30
        self.http_max_retries = 3

        # Validate required fields
        if not self.working_dir:
            raise ValueError("VM0_WORKING_DIR is required but not set")


config = Config()


# =============================================================================
# Logging
# =============================================================================

def log_info(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[INFO {timestamp}] {msg}", file=sys.stderr, flush=True)


def log_error(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[ERROR {timestamp}] {msg}", file=sys.stderr, flush=True)


def log_debug(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[DEBUG {timestamp}] {msg}", file=sys.stderr, flush=True)


# =============================================================================
# HTTP Functions
# =============================================================================

def http_post_json(url: str, data: dict, max_retries: int = None) -> Optional[dict]:
    """POST JSON data with retry logic."""
    if max_retries is None:
        max_retries = config.http_max_retries

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.api_token}",
    }
    if config.vercel_bypass:
        headers["x-vercel-protection-bypass"] = config.vercel_bypass

    body = json.dumps(data).encode("utf-8")

    for attempt in range(1, max_retries + 1):
        try:
            req = Request(url, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=config.http_max_time) as response:
                return json.loads(response.read().decode("utf-8"))
        except (URLError, HTTPError) as e:
            log_error(f"HTTP POST failed (attempt {attempt}/{max_retries}): {e}")
            if attempt < max_retries:
                time.sleep(1)

    return None


def http_post_form(url: str, fields: dict, file_path: str = None, file_field: str = "file") -> Optional[dict]:
    """POST multipart form data with file upload."""
    import mimetypes
    from uuid import uuid4

    boundary = f"----WebKitFormBoundary{uuid4().hex}"
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Authorization": f"Bearer {config.api_token}",
    }
    if config.vercel_bypass:
        headers["x-vercel-protection-bypass"] = config.vercel_bypass

    body_parts = []

    # Add form fields
    for key, value in fields.items():
        body_parts.append(f"--{boundary}\\r\\n".encode())
        body_parts.append(f'Content-Disposition: form-data; name="{key}"\\r\\n\\r\\n'.encode())
        body_parts.append(f"{value}\\r\\n".encode())

    # Add file if provided
    if file_path:
        filename = os.path.basename(file_path)
        mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        body_parts.append(f"--{boundary}\\r\\n".encode())
        body_parts.append(f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\\r\\n'.encode())
        body_parts.append(f"Content-Type: {mime_type}\\r\\n\\r\\n".encode())
        with open(file_path, "rb") as f:
            body_parts.append(f.read())
        body_parts.append(b"\\r\\n")

    body_parts.append(f"--{boundary}--\\r\\n".encode())
    body = b"".join(body_parts)

    for attempt in range(1, config.http_max_retries + 1):
        try:
            req = Request(url, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except (URLError, HTTPError) as e:
            log_error(f"HTTP POST form failed (attempt {attempt}/{config.http_max_retries}): {e}")
            if attempt < config.http_max_retries:
                time.sleep(1)

    return None


# =============================================================================
# Event Handling
# =============================================================================

class EventHandler:
    def __init__(self):
        self.session_id: Optional[str] = None
        self.session_history_path: Optional[str] = None
        self.event_error = False

    def send_event(self, event: dict) -> bool:
        """Send a single event to the webhook."""
        # Extract session ID from init event
        if event.get("type") == "system" and event.get("subtype") == "init":
            session_id = event.get("session_id")
            if session_id and not self.session_id:
                self.session_id = session_id
                log_info(f"Captured session ID: {session_id}")

                # Calculate session history path
                project_name = config.working_dir.lstrip("/").replace("/", "-")
                self.session_history_path = f"{os.environ.get('HOME', '')}/.config/claude/projects/-{project_name}/{session_id}.jsonl"
                log_info(f"Session history will be at: {self.session_history_path}")

        payload = {
            "runId": config.run_id,
            "events": [event]
        }

        result = http_post_json(config.webhook_url, payload)
        if result is None:
            log_error("Failed to send event after retries")
            self.event_error = True
            return False

        return True


event_handler = EventHandler()


# =============================================================================
# Heartbeat
# =============================================================================

class Heartbeat:
    def __init__(self):
        self.running = False
        self.thread: Optional[threading.Thread] = None

    def start(self):
        """Start heartbeat in background thread."""
        self.running = True
        self.thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self.thread.start()
        log_info("Started heartbeat thread")

    def stop(self):
        """Stop heartbeat thread."""
        self.running = False
        if self.thread:
            self.thread.join(timeout=5)
        log_info("Stopped heartbeat thread")

    def _heartbeat_loop(self):
        while self.running:
            time.sleep(30)
            if not self.running:
                break

            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            heartbeat_event = {"type": "vm0_heartbeat", "timestamp": timestamp}
            payload = {"runId": config.run_id, "events": [heartbeat_event]}

            try:
                http_post_json(config.webhook_url, payload, max_retries=1)
            except Exception:
                pass  # Heartbeat failures are non-fatal


heartbeat = Heartbeat()


# =============================================================================
# VAS Snapshot Functions
# =============================================================================

def create_vas_snapshot(mount_path: str, storage_name: str, vas_storage_name: str) -> Optional[dict]:
    """Create a full VAS snapshot by uploading tar.gz."""
    log_info(f"Creating VAS snapshot for storage '{storage_name}' ({vas_storage_name}) at {mount_path}")

    with tempfile.TemporaryDirectory() as temp_dir:
        tar_path = os.path.join(temp_dir, "storage.tar.gz")

        # Create tar.gz excluding .git and .vas
        try:
            with tarfile.open(tar_path, "w:gz") as tar:
                for root, dirs, files in os.walk(mount_path):
                    # Exclude .git and .vas directories
                    dirs[:] = [d for d in dirs if d not in [".git", ".vas"]]

                    for file in files:
                        file_path = os.path.join(root, file)
                        arcname = os.path.relpath(file_path, mount_path)
                        tar.add(file_path, arcname=arcname)
        except Exception as e:
            log_error(f"Failed to create tar.gz: {e}")
            return None

        log_info(f"Created tar.gz for storage '{storage_name}'")

        # Upload to storage webhook
        fields = {
            "runId": config.run_id,
            "storageName": vas_storage_name,
            "message": f"Checkpoint from run {config.run_id}",
        }

        response = http_post_form(config.storage_webhook_url, fields, tar_path)
        if not response:
            log_error(f"Failed to upload snapshot for storage '{storage_name}'")
            return None

        version_id = response.get("versionId")
        if not version_id:
            log_error(f"Invalid response from storage webhook: {response}")
            return None

        log_info(f"VAS snapshot created for '{storage_name}': version {version_id}")
        return {"versionId": version_id}


def compute_local_manifest(dir_path: str) -> dict:
    """Compute SHA-256 manifest for all files in directory."""
    files = []
    for root, dirs, filenames in os.walk(dir_path):
        dirs[:] = [d for d in dirs if d not in [".git", ".vas"]]
        for filename in filenames:
            file_path = os.path.join(root, filename)
            rel_path = os.path.relpath(file_path, dir_path)

            with open(file_path, "rb") as f:
                file_hash = hashlib.sha256(f.read()).hexdigest()

            file_size = os.path.getsize(file_path)
            files.append({"path": rel_path, "hash": file_hash, "size": file_size})

    return {"files": files}


def diff_manifests(old_manifest: dict, new_manifest: dict) -> dict:
    """Compute diff between two manifests."""
    old_files = {f["path"]: f for f in old_manifest.get("files", [])}
    new_files = {f["path"]: f for f in new_manifest.get("files", [])}

    old_paths = set(old_files.keys())
    new_paths = set(new_files.keys())

    added = sorted(new_paths - old_paths)
    deleted = sorted(old_paths - new_paths)
    modified = sorted([
        p for p in old_paths & new_paths
        if old_files[p]["hash"] != new_files[p]["hash"]
    ])

    return {"added": added, "modified": modified, "deleted": deleted}


def create_incremental_snapshot(mount_path: str, storage_name: str, vas_storage_name: str,
                                 base_version_id: str, manifest_url: str) -> Optional[dict]:
    """Create incremental VAS snapshot by uploading only changed files."""
    log_info(f"Attempting incremental upload for '{storage_name}'")

    if not base_version_id or not manifest_url:
        log_info("No base version, falling back to full upload")
        return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

    with tempfile.TemporaryDirectory() as temp_dir:
        # Download base manifest
        log_info("Downloading base manifest...")
        try:
            req = Request(manifest_url)
            with urlopen(req, timeout=30) as response:
                old_manifest = json.loads(response.read().decode("utf-8"))
        except Exception as e:
            log_error(f"Failed to download base manifest: {e}, falling back to full upload")
            return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

        # Compute local manifest
        log_info("Computing local manifest...")
        new_manifest = compute_local_manifest(mount_path)

        # Compute diff
        log_info("Computing diff...")
        changes = diff_manifests(old_manifest, new_manifest)

        added_count = len(changes["added"])
        modified_count = len(changes["modified"])
        deleted_count = len(changes["deleted"])

        log_info(f"Changes: +{added_count} ~{modified_count} -{deleted_count}")

        # If no changes, return base version
        if added_count == 0 and modified_count == 0 and deleted_count == 0:
            log_info("No changes detected, skipping upload")
            return {"versionId": base_version_id, "unchanged": True}

        # Create tar.gz of changed files
        tar_path = os.path.join(temp_dir, "changes.tar.gz")
        changed_files = changes["added"] + changes["modified"]

        if changed_files:
            with tarfile.open(tar_path, "w:gz") as tar:
                for rel_path in changed_files:
                    file_path = os.path.join(mount_path, rel_path)
                    if os.path.exists(file_path):
                        tar.add(file_path, arcname=rel_path)
        else:
            # Create empty tar
            with tarfile.open(tar_path, "w:gz") as tar:
                pass

        # Upload to incremental endpoint
        log_info("Uploading incremental changes...")
        fields = {
            "runId": config.run_id,
            "storageName": vas_storage_name,
            "baseVersion": base_version_id,
            "changes": json.dumps(changes),
            "message": f"Incremental checkpoint from run {config.run_id}",
        }

        response = http_post_form(config.incremental_webhook_url, fields, tar_path)
        if not response:
            log_error("Incremental upload failed, falling back to full upload")
            return create_vas_snapshot(mount_path, storage_name, vas_storage_name)

        version_id = response.get("versionId")
        if not version_id:
            log_error(f"Invalid response from incremental upload: {response}")
            return None

        log_info(f"Incremental snapshot created: version {version_id}")
        return {"versionId": version_id}


# =============================================================================
# Checkpoint Creation
# =============================================================================

def create_checkpoint() -> bool:
    """Create checkpoint with session history and artifact snapshot."""
    log_info("Creating checkpoint...")

    # Check session ID
    if not event_handler.session_id:
        log_error("No session ID found, checkpoint creation failed")
        return False

    # Check session history path
    if not event_handler.session_history_path:
        log_error("No session history path found, checkpoint creation failed")
        return False

    # Read session history
    if not os.path.exists(event_handler.session_history_path):
        log_error(f"Session history file not found at {event_handler.session_history_path}")
        return False

    with open(event_handler.session_history_path, "r") as f:
        session_history = f.read()

    if not session_history:
        log_error("Session history is empty")
        return False

    line_count = len(session_history.splitlines())
    log_info(f"Session history loaded ({line_count} lines)")

    # Check artifact configuration
    if not config.artifact_driver or not config.artifact_volume_name:
        log_error("Artifact is required but not configured")
        return False

    log_info(f"Processing artifact with driver: {config.artifact_driver}")

    if config.artifact_driver != "vas":
        log_error(f"Unknown artifact driver: {config.artifact_driver} (only 'vas' is supported)")
        return False

    # Create VAS snapshot (incremental if possible)
    log_info(f"Creating VAS snapshot for artifact '{config.artifact_volume_name}' at {config.artifact_mount_path}")

    if config.artifact_manifest_url and config.artifact_version_id:
        log_info(f"Attempting incremental upload (base version: {config.artifact_version_id[:8]})")
        snapshot = create_incremental_snapshot(
            config.artifact_mount_path,
            "artifact",
            config.artifact_volume_name,
            config.artifact_version_id,
            config.artifact_manifest_url
        )
    else:
        log_info("Using full upload (no base version available)")
        snapshot = create_vas_snapshot(config.artifact_mount_path, "artifact", config.artifact_volume_name)

    if not snapshot:
        log_error("Failed to create VAS snapshot for artifact")
        return False

    artifact_version = snapshot.get("versionId")
    if not artifact_version:
        log_error("Failed to extract versionId from snapshot")
        return False

    artifact_snapshot = {
        "artifactName": config.artifact_volume_name,
        "artifactVersion": artifact_version
    }

    log_info(f"VAS artifact snapshot created: {config.artifact_volume_name}@{artifact_version}")

    # Call checkpoint API
    log_info("Calling checkpoint API...")
    checkpoint_payload = {
        "runId": config.run_id,
        "cliAgentType": "claude-code",
        "cliAgentSessionId": event_handler.session_id,
        "cliAgentSessionHistory": session_history,
        "artifactSnapshot": artifact_snapshot
    }

    result = http_post_json(config.checkpoint_url, checkpoint_payload)
    if result is None:
        log_error("Failed to create checkpoint")
        return False

    log_info("Checkpoint created successfully")
    return True


# =============================================================================
# Complete API
# =============================================================================

def call_complete_api(exit_code: int, error_message: str = ""):
    """Call the complete API to finalize the run."""
    log_info(f"Calling complete API with exitCode={exit_code}")

    payload = {
        "runId": config.run_id,
        "exitCode": exit_code
    }
    if error_message:
        payload["error"] = error_message

    result = http_post_json(config.complete_url, payload)
    if result is not None:
        log_info("Complete API called successfully")
    else:
        log_error("Failed to call complete API (sandbox may not be cleaned up)")


# =============================================================================
# Claude Execution
# =============================================================================

def run_claude() -> int:
    """Run Claude Code and process its output stream."""
    os.chdir(config.working_dir)
    log_info(f"Working directory: {config.working_dir}")

    # Set Claude config directory
    os.environ["CLAUDE_CONFIG_DIR"] = os.path.expanduser("~/.config/claude")
    log_info(f"Claude config directory: {os.environ['CLAUDE_CONFIG_DIR']}")

    # Build Claude command
    claude_args = ["--print", "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"]
    if config.resume_session_id:
        log_info(f"Resuming session: {config.resume_session_id}")
        claude_args.extend(["--resume", config.resume_session_id])
    else:
        log_info("Starting new session")

    # Select Claude binary
    if config.use_mock_claude:
        claude_bin = "/usr/local/bin/vm0-agent/lib/mock-claude.sh"
        log_info("Using mock-claude for testing")
    else:
        claude_bin = "claude"

    log_info("Starting Claude Code execution...")
    log_info(f"Prompt: {config.prompt}")

    # Start heartbeat
    heartbeat.start()

    # Run Claude as subprocess
    cmd = [claude_bin] + claude_args + [config.prompt]
    log_debug(f"Running command: {' '.join(cmd)}")

    claude_exit_code = 0
    stderr_content = ""

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # Line buffered
        )

        # Read stdout line by line
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue

            # Try to parse as JSON
            try:
                event = json.loads(line)
                event_handler.send_event(event)

                # Check for result event
                event_type = event.get("type")
                if event_type == "result":
                    result_content = event.get("result", "")
                    if result_content:
                        print(result_content)
                    log_info("Received result event, terminating Claude")
                    break

            except json.JSONDecodeError:
                log_debug(f"Non-JSON line: {line}")

        # Terminate Claude after receiving result
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

        claude_exit_code = proc.returncode or 0

        # Capture stderr
        stderr_content = proc.stderr.read()

    except Exception as e:
        log_error(f"Error running Claude: {e}")
        claude_exit_code = 1
        stderr_content = str(e)

    # Stop heartbeat
    heartbeat.stop()

    log_info(f"Claude finished with exit code: {claude_exit_code}")
    print("")  # Newline after output

    return claude_exit_code, stderr_content


# =============================================================================
# Main
# =============================================================================

def main():
    log_info(f"Script started")
    log_info(f"Run ID: {config.run_id}")
    log_info(f"PID: {os.getpid()}")

    # Ignore signals that might terminate the script prematurely
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    # Run Claude
    claude_exit_code, stderr_content = run_claude()

    # Track final exit code
    final_exit_code = claude_exit_code
    error_message = ""

    # Check if any events failed to send
    if event_handler.event_error:
        log_error("Some events failed to send, marking run as failed")
        final_exit_code = 1
        error_message = "Some events failed to send"

    # Handle completion
    log_debug(f"Handling completion: CLAUDE_EXIT_CODE={claude_exit_code}, FINAL_EXIT_CODE={final_exit_code}")

    if claude_exit_code == 0 and final_exit_code == 0:
        log_info("Claude Code completed successfully")

        # Create checkpoint
        log_debug("Starting checkpoint creation...")
        if not create_checkpoint():
            log_error("Checkpoint creation failed, marking run as failed")
            final_exit_code = 1
            error_message = "Checkpoint creation failed"
    else:
        if claude_exit_code != 0:
            log_info(f"Claude Code failed with exit code {claude_exit_code}")
            if stderr_content:
                # Get last few lines of stderr
                error_lines = stderr_content.strip().split("\\n")[-5:]
                error_message = " ".join(error_lines)
                log_info(f"Captured stderr: {error_message}")
            else:
                error_message = f"Agent exited with code {claude_exit_code}"

    # Always call complete API
    log_debug("Preparing to call complete API...")
    call_complete_api(final_exit_code, error_message)

    log_debug(f"Script completed with exit code {final_exit_code}")
    sys.exit(final_exit_code)


if __name__ == "__main__":
    main()
`;
