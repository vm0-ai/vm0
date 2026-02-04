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
