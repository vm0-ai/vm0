/**
 * Agent execution scripts (TypeScript bundled to ESM .mjs)
 *
 * These are self-contained bundled scripts that run in E2B sandbox or Firecracker VM.
 * Built from TypeScript source in src/ directory via esbuild.
 *
 * Migration from Python to TypeScript (Issue #1045):
 * - 13 Python scripts consolidated into 4 bundled .mjs files
 * - Each script is self-contained with all dependencies bundled
 * - No lib directory needed - no module imports at runtime
 */
export {
  RUN_AGENT_SCRIPT,
  DOWNLOAD_SCRIPT,
  MOCK_CLAUDE_SCRIPT,
  ENV_LOADER_SCRIPT,
} from "./bundled";

/**
 * Script paths in the E2B sandbox / Firecracker VM (TypeScript/ESM)
 *
 * Simplified structure: just the base directory and 4 bundled scripts.
 * No lib directory needed since scripts are self-contained.
 */
export const SCRIPT_PATHS = {
  /** Base directory for agent scripts */
  baseDir: "/usr/local/bin/vm0-agent",
  /** Main agent orchestrator - handles CLI execution, events, checkpoints */
  runAgent: "/usr/local/bin/vm0-agent/run-agent.mjs",
  /** Storage download - downloads volumes/artifacts from S3 via presigned URLs */
  download: "/usr/local/bin/vm0-agent/download.mjs",
  /** Mock Claude CLI for testing - executes prompt as bash, outputs Claude-compatible JSONL */
  mockClaude: "/usr/local/bin/vm0-agent/mock-claude.mjs",
  /** Environment loader for runner - loads env from JSON file before running agent */
  envLoader: "/usr/local/bin/vm0-agent/env-loader.mjs",
} as const;
