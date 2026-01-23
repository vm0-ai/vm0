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
 * Guest Client Interface
 *
 * Common interface for VM communication clients.
 * Allows swapping communication protocols without affecting consumers.
 */
export interface GuestClient {
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  execOrThrow(command: string): Promise<string>;
  writeFile(remotePath: string, content: string): Promise<void>;
  writeFileWithSudo(remotePath: string, content: string): Promise<void>;
  readFile(remotePath: string): Promise<string>;
  isReachable(): Promise<boolean>;
  /** Wait for guest to connect (Guest-initiated, zero-latency mode) */
  waitForGuestConnection(timeoutMs?: number): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
  exists(remotePath: string): Promise<boolean>;
}
