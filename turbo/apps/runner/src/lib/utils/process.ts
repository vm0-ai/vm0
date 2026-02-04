import { execSync } from "node:child_process";

/**
 * Check if a process is running
 *
 * Uses kill(pid, 0) which checks process existence without sending a signal.
 * - Returns true if process exists (signal would be deliverable)
 * - Returns true if EPERM (process exists but we lack permission)
 * - Returns false if ESRCH (no such process)
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means process exists but we don't have permission to signal it
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      return true;
    }
    // ESRCH or other errors mean process doesn't exist
    return false;
  }
}

/**
 * Kill a process and all its descendants (children, grandchildren, etc.)
 *
 * Uses depth-first traversal to kill children before parents,
 * preventing orphan processes when killing process trees like:
 * sudo -> firecracker
 */
export function killProcessTree(pid: number): void {
  try {
    // Find all child PIDs using pgrep
    const childPidsStr = execSync(`pgrep -P ${pid} 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();

    if (childPidsStr) {
      const childPids = childPidsStr.split("\n").map((p) => parseInt(p, 10));
      // Recursively kill children first
      for (const childPid of childPids) {
        if (!isNaN(childPid)) {
          killProcessTree(childPid);
        }
      }
    }

    // Kill this process
    process.kill(pid, "SIGKILL");
  } catch {
    // Errors are expected during cleanup:
    // - ESRCH: Process already dead (race condition with natural exit)
    // - EPERM: Permission denied (process owned by different user)
    // - pgrep failure: Command not available or other system issues
    // All cases are safe to ignore since we're just cleaning up
  }
}
