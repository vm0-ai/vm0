import type { ContextArtifact } from "../infra/run/types";

// AUTO_MEMORY_MOUNT_PATH: derived from Claude Code's project-name encoding
// of /home/user/workspace (strip leading "/", "/"→"-", prepend "-"). Since
// Zero always runs with workingDir=/home/user/workspace, the encoded folder
// is stable. Mounting memory directly here removes the need for the
// guest-agent symlink bootstrap.
export const AUTO_MEMORY_MOUNT_PATH =
  "/home/user/.claude/projects/-home-user-workspace/memory";

// Storage name used for the auto-synthesized memory artifact. Zero-layer
// runs always include a ContextArtifact entry with this name mounted at
// AUTO_MEMORY_MOUNT_PATH so Claude Code finds persistent memory without
// any in-sandbox symlink bootstrap.
export const AUTO_MEMORY_ARTIFACT_NAME = "memory";

// Seed ContextArtifact entry for auto-memory. Zero session insertion sites
// use this so the row is self-describing from the moment of creation, and
// resume paths resolve memory from session.artifacts without relying on
// Zero re-injecting on every run.
export function buildAutoMemoryArtifact(): ContextArtifact {
  return {
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: AUTO_MEMORY_MOUNT_PATH,
  };
}
