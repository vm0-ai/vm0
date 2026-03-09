/**
 * Auto-memory symlink setup for Claude Code.
 *
 * Creates a symlink from Claude Code's expected auto-memory directory to the
 * vm0 memory volume mount path. This lets Claude Code natively read/write
 * MEMORY.md through its auto-memory system, and all changes are persisted
 * via vm0's checkpoint mechanism.
 */
import * as fs from "fs";
import * as path from "path";
import { encodeProjectName } from "./common.js";
import { logInfo, logDebug } from "./log.js";

/**
 * Set up Claude Code auto-memory symlink.
 *
 * If a vm0 memory volume is mounted, create a symlink from Claude Code's
 * expected auto-memory directory to the memory mount path.
 *
 * No-op when:
 * - Agent type is not claude-code (codex has no auto-memory equivalent)
 * - No memory volume configured (memoryMountPath empty)
 * - Memory mount path doesn't exist on disk (first run, download failed)
 * - Symlink target already exists (safety guard)
 *
 * @returns true if the symlink was created, false if skipped
 */
export function setupAutoMemorySymlink(
  workingDir: string,
  memoryMountPath: string,
  cliAgentType: string,
): boolean {
  if (cliAgentType !== "claude-code") {
    logDebug("Auto-memory symlink skipped: not claude-code");
    return false;
  }

  if (!memoryMountPath) {
    logDebug("Auto-memory symlink skipped: no memory mount path");
    return false;
  }

  if (!fs.existsSync(memoryMountPath)) {
    logDebug(
      `Auto-memory symlink skipped: mount path does not exist: ${memoryMountPath}`,
    );
    return false;
  }

  const homeDir = process.env.HOME ?? "/home/user";
  const projectName = encodeProjectName(workingDir);
  const autoMemoryDir = path.join(
    homeDir,
    ".claude",
    "projects",
    projectName,
    "memory",
  );

  if (fs.existsSync(autoMemoryDir)) {
    logDebug(
      `Auto-memory symlink skipped: target already exists: ${autoMemoryDir}`,
    );
    return false;
  }

  fs.mkdirSync(path.dirname(autoMemoryDir), { recursive: true });
  fs.symlinkSync(memoryMountPath, autoMemoryDir);
  logInfo(`Auto-memory symlink: ${autoMemoryDir} → ${memoryMountPath}`);
  return true;
}
