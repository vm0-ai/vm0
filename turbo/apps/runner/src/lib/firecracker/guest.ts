/**
 * Guest Communication Client
 *
 * Provides type definitions for VM guest communication.
 * The actual implementation is in vsock.ts (VsockClient).
 */

/**
 * Result of command execution
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Result of spawnAndWatch - contains the spawned process PID
 */
export interface SpawnResult {
  pid: number;
}

/**
 * Event emitted when a spawned process exits
 */
export interface ProcessExitEvent {
  pid: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Guest Client Interface
 *
 * Common interface for VM communication clients.
 * Allows swapping communication protocols without affecting consumers.
 */
/**
 * Environment variables to pass to a guest command.
 */
export type EnvVars = Record<string, string>;

export interface GuestClient {
  exec(
    command: string,
    timeoutMs?: number,
    env?: EnvVars,
    sudo?: boolean,
  ): Promise<ExecResult>;
  /** Execute a command as root via the sudo protocol flag. */
  execAsRoot(command: string, timeoutMs?: number): Promise<ExecResult>;
  execOrThrow(command: string): Promise<string>;
  writeFile(remotePath: string, content: string): Promise<void>;
  writeFileWithSudo(remotePath: string, content: string): Promise<void>;
  readFile(remotePath: string): Promise<string>;
  isReachable(): Promise<boolean>;
  /** Wait for guest to connect (Guest-initiated, zero-latency mode) */
  waitForGuestConnection(timeoutMs?: number): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
  exists(remotePath: string): Promise<boolean>;

  /**
   * Spawn a process and monitor for exit (event-driven mode)
   *
   * Returns immediately with the PID. Use waitForExit() to wait for completion.
   * When the process exits, the agent sends an unsolicited notification.
   */
  spawnAndWatch(
    command: string,
    timeoutMs?: number,
    env?: EnvVars,
    sudo?: boolean,
  ): Promise<SpawnResult>;

  /**
   * Wait for a spawned process to exit
   *
   * Blocks until the process exits or timeout is reached.
   * The exit event is pushed by the guest agent (no polling).
   */
  waitForExit(pid: number, timeoutMs?: number): Promise<ProcessExitEvent>;
}
