/**
 * File locking utility using proper-lockfile
 *
 * Provides a simple wrapper around proper-lockfile with sensible defaults
 * for cross-process file locking.
 */
import lockfile from "proper-lockfile";

const DEFAULT_OPTIONS: lockfile.LockOptions = {
  stale: 30000, // Consider lock stale after 30 seconds
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
  },
};

/**
 * Execute a function while holding an exclusive lock on a file
 *
 * @param path - Path to the file to lock
 * @param fn - Function to execute while holding the lock
 * @param options - Optional lock options to override defaults
 * @returns The result of the function
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options?: Partial<lockfile.LockOptions>,
): Promise<T> {
  const release = await lockfile.lock(path, { ...DEFAULT_OPTIONS, ...options });
  try {
    return await fn();
  } finally {
    await release();
  }
}
