/**
 * Agent execution scripts
 * Re-exports all script constants for use by e2b-service
 */
export { COMMON_SCRIPT } from "./common";
export { SEND_EVENT_SCRIPT } from "./send-event";
export { VAS_SNAPSHOT_SCRIPT } from "./vas-snapshot";
export { CREATE_CHECKPOINT_SCRIPT } from "./create-checkpoint";
export { RUN_AGENT_SCRIPT } from "./run-agent";
export { MOCK_CLAUDE_SCRIPT } from "./mock-claude";

/**
 * Script paths in the E2B sandbox
 */
export const SCRIPT_PATHS = {
  baseDir: "/usr/local/bin/vas-agent",
  libDir: "/usr/local/bin/vas-agent/lib",
  runAgent: "/usr/local/bin/vas-agent/run-agent.sh",
  common: "/usr/local/bin/vas-agent/lib/common.sh",
  sendEvent: "/usr/local/bin/vas-agent/lib/send-event.sh",
  vasSnapshot: "/usr/local/bin/vas-agent/lib/vas-snapshot.sh",
  createCheckpoint: "/usr/local/bin/vas-agent/lib/create-checkpoint.sh",
  mockClaude: "/usr/local/bin/vas-agent/lib/mock-claude.sh",
} as const;
