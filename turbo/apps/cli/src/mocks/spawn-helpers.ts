/**
 * Shared test helpers for mocking child_process.spawn
 *
 * These helpers create mock ChildProcess-like EventEmitter objects
 * for testing CLI commands that spawn child processes.
 */
import { EventEmitter } from "events";

/**
 * Creates a mock child process that emits 'close' event after a delay.
 * Used for testing scenarios where only the exit code matters (e.g., auto-upgrade).
 *
 * @param exitCode - The exit code to emit
 * @param delay - Delay in ms before emitting 'close' event (default: 0)
 */
export function createMockChildProcess(
  exitCode: number,
  delay = 0,
): EventEmitter {
  const child = new EventEmitter();
  setTimeout(() => {
    child.emit("close", exitCode);
  }, delay);
  return child;
}
