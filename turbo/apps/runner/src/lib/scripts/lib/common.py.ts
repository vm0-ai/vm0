/**
 * Common utilities and environment variables for agent scripts (Python)
 * This module is imported by other scripts to share common functionality
 */
export const COMMON_SCRIPT = `#!/usr/bin/env python3
"""
Common environment variables and utilities for VM0 agent scripts.
This module should be imported by other scripts.
"""
import os

# Environment variables
RUN_ID = os.environ.get("VM0_RUN_ID", "")
API_URL = os.environ.get("VM0_API_URL", "")
API_TOKEN = os.environ.get("VM0_API_TOKEN", "")
PROMPT = os.environ.get("VM0_PROMPT", "")
VERCEL_BYPASS = os.environ.get("VERCEL_PROTECTION_BYPASS", "")
RESUME_SESSION_ID = os.environ.get("VM0_RESUME_SESSION_ID", "")

# CLI agent type - determines which CLI to invoke (claude-code or codex)
CLI_AGENT_TYPE = os.environ.get("CLI_AGENT_TYPE", "claude-code")

# OpenAI model override - used for OpenRouter/custom endpoints with Codex
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "")

# Working directory is required - no fallback allowed
WORKING_DIR = os.environ.get("VM0_WORKING_DIR", "")

# Artifact configuration (replaces GIT_VOLUMES and VM0_VOLUMES)
ARTIFACT_DRIVER = os.environ.get("VM0_ARTIFACT_DRIVER", "")
ARTIFACT_MOUNT_PATH = os.environ.get("VM0_ARTIFACT_MOUNT_PATH", "")
ARTIFACT_VOLUME_NAME = os.environ.get("VM0_ARTIFACT_VOLUME_NAME", "")
ARTIFACT_VERSION_ID = os.environ.get("VM0_ARTIFACT_VERSION_ID", "")

# Construct webhook endpoint URLs
WEBHOOK_URL = f"{API_URL}/api/webhooks/agent/events"
CHECKPOINT_URL = f"{API_URL}/api/webhooks/agent/checkpoints"
COMPLETE_URL = f"{API_URL}/api/webhooks/agent/complete"
HEARTBEAT_URL = f"{API_URL}/api/webhooks/agent/heartbeat"
TELEMETRY_URL = f"{API_URL}/api/webhooks/agent/telemetry"
PROXY_URL = f"{API_URL}/api/webhooks/agent/proxy"

# Direct S3 upload endpoints (webhook versions for sandbox - uses JWT auth)
STORAGE_PREPARE_URL = f"{API_URL}/api/webhooks/agent/storages/prepare"
STORAGE_COMMIT_URL = f"{API_URL}/api/webhooks/agent/storages/commit"

# Proxy configuration (for experimental_network_security feature)
PROXY_ENABLED = os.environ.get("VM0_PROXY_ENABLED", "false").lower() == "true"

# Heartbeat configuration
HEARTBEAT_INTERVAL = 60  # seconds

# Telemetry upload configuration
TELEMETRY_INTERVAL = 30  # seconds

# HTTP request configuration
HTTP_CONNECT_TIMEOUT = 10
HTTP_MAX_TIME = 30
HTTP_MAX_TIME_UPLOAD = 60
HTTP_MAX_RETRIES = 3

# Variables for checkpoint (use temp files to persist across subprocesses)
SESSION_ID_FILE = f"/tmp/vm0-session-{RUN_ID}.txt"
SESSION_HISTORY_PATH_FILE = f"/tmp/vm0-session-history-{RUN_ID}.txt"

# Event error flag file - used to track if any events failed to send
EVENT_ERROR_FLAG = f"/tmp/vm0-event-error-{RUN_ID}"

# Log file for persistent logging (directly in /tmp with vm0- prefix)
SYSTEM_LOG_FILE = f"/tmp/vm0-main-{RUN_ID}.log"
AGENT_LOG_FILE = f"/tmp/vm0-agent-{RUN_ID}.log"

# Metrics log file for system resource metrics (JSONL format)
METRICS_LOG_FILE = f"/tmp/vm0-metrics-{RUN_ID}.jsonl"

# Network log file for proxy request logs (JSONL format)
NETWORK_LOG_FILE = f"/tmp/vm0-network-{RUN_ID}.jsonl"

# Telemetry position tracking files (to avoid duplicate uploads)
TELEMETRY_LOG_POS_FILE = f"/tmp/vm0-telemetry-log-pos-{RUN_ID}.txt"
TELEMETRY_METRICS_POS_FILE = f"/tmp/vm0-telemetry-metrics-pos-{RUN_ID}.txt"
TELEMETRY_NETWORK_POS_FILE = f"/tmp/vm0-telemetry-network-pos-{RUN_ID}.txt"

# Metrics collection configuration
METRICS_INTERVAL = 5  # seconds

def validate_config() -> bool:
    """
    Validate required configuration.
    Raises ValueError if configuration is invalid.
    Returns True if valid.
    """
    if not WORKING_DIR:
        raise ValueError("VM0_WORKING_DIR is required but not set")
    return True
`;
