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

interface MockChildProcessWithOutput extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

/**
 * Creates a mock child process with stdout/stderr streams.
 * Used for testing scenarios where command output matters (e.g., cook, onboard).
 *
 * @param exitCode - The exit code to emit
 * @param stdout - Data to emit on stdout (default: "")
 * @param stderr - Data to emit on stderr (default: "")
 */
export function createMockChildProcessWithOutput(
  exitCode: number,
  stdout = "",
  stderr = "",
): MockChildProcessWithOutput {
  const child = new EventEmitter() as MockChildProcessWithOutput;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  // Emit data and close events asynchronously
  setImmediate(() => {
    if (stdout) {
      child.stdout.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    child.emit("close", exitCode);
  });

  return child;
}
