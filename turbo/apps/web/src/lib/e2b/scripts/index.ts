/**
 * Agent execution scripts
 * Re-exports all script constants for use by e2b-service
 */
export { COMMON_SCRIPT } from "./common";
export { LOG_SCRIPT } from "./log";
export { REQUEST_SCRIPT } from "./request";
export { SEND_EVENT_SCRIPT } from "./send-event";
export { VAS_SNAPSHOT_SCRIPT } from "./vas-snapshot";
export { CREATE_CHECKPOINT_SCRIPT } from "./create-checkpoint";
export { RUN_AGENT_SCRIPT } from "./run-agent";
export { MOCK_CLAUDE_SCRIPT } from "./mock-claude";
export { DOWNLOAD_STORAGES_SCRIPT } from "./download-storages";

/**
 * Script paths in the E2B sandbox
 */
export const SCRIPT_PATHS = {
  baseDir: "/usr/local/bin/vm0-agent",
  libDir: "/usr/local/bin/vm0-agent/lib",
  runAgent: "/usr/local/bin/vm0-agent/run-agent.sh",
  common: "/usr/local/bin/vm0-agent/lib/common.sh",
  log: "/usr/local/bin/vm0-agent/lib/log.sh",
  request: "/usr/local/bin/vm0-agent/lib/request.sh",
  sendEvent: "/usr/local/bin/vm0-agent/lib/send-event.sh",
  vasSnapshot: "/usr/local/bin/vm0-agent/lib/vas-snapshot.sh",
  createCheckpoint: "/usr/local/bin/vm0-agent/lib/create-checkpoint.sh",
  mockClaude: "/usr/local/bin/vm0-agent/lib/mock-claude.sh",
  downloadStorages: "/usr/local/bin/vm0-agent/lib/download-storages.sh",
} as const;
