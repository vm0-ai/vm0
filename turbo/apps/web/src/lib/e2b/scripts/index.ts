/**
 * Agent execution scripts
 * Re-exports all script constants for use by e2b-service
 */
export { COMMON_SCRIPT } from "./common";
export { SEND_EVENT_SCRIPT } from "./send-event";
export { GIT_SNAPSHOT_SCRIPT } from "./git-snapshot";
export { VM0_SNAPSHOT_SCRIPT } from "./vm0-snapshot";
export { CREATE_CHECKPOINT_SCRIPT } from "./create-checkpoint";
export { RUN_AGENT_SCRIPT } from "./run-agent";

/**
 * Script paths in the E2B sandbox
 */
export const SCRIPT_PATHS = {
  baseDir: "/usr/local/bin/vm0-agent",
  libDir: "/usr/local/bin/vm0-agent/lib",
  runAgent: "/usr/local/bin/vm0-agent/run-agent.sh",
  common: "/usr/local/bin/vm0-agent/lib/common.sh",
  sendEvent: "/usr/local/bin/vm0-agent/lib/send-event.sh",
  gitSnapshot: "/usr/local/bin/vm0-agent/lib/git-snapshot.sh",
  vm0Snapshot: "/usr/local/bin/vm0-agent/lib/vm0-snapshot.sh",
  createCheckpoint: "/usr/local/bin/vm0-agent/lib/create-checkpoint.sh",
} as const;
