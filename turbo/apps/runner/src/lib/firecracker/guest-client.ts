/**
 * Guest Client Interface
 *
 * Common interface for host-to-guest communication in Firecracker VMs.
 * Implemented by both SSHClient and VsockClient to provide a consistent API.
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
 * This interface defines the contract for communication with guest VMs.
 * It's designed to be protocol-agnostic, allowing implementations using
 * SSH (SSHClient) or vsock (VsockClient).
 */
export interface GuestClient {
  /**
   * Execute a command on the guest VM
   * @param command - The command to execute
   * @param timeoutMs - Optional timeout in milliseconds (default: 300000ms = 5 minutes)
   * @returns The execution result with exit code, stdout, and stderr
   */
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;

  /**
   * Execute a command and throw on non-zero exit
   * @param command - The command to execute
   * @returns The stdout output
   * @throws Error if command exits with non-zero code
   */
  execOrThrow(command: string): Promise<string>;

  /**
   * Write content to a file on the guest VM
   * @param remotePath - The path on the guest to write to
   * @param content - The content to write
   */
  writeFile(remotePath: string, content: string): Promise<void>;

  /**
   * Write content to a file on the guest VM using sudo
   * @param remotePath - The path on the guest to write to
   * @param content - The content to write
   */
  writeFileWithSudo(remotePath: string, content: string): Promise<void>;

  /**
   * Read a file from the guest VM
   * @param remotePath - The path on the guest to read from
   * @returns The file content
   */
  readFile(remotePath: string): Promise<string>;

  /**
   * Create a directory on the guest VM (mkdir -p)
   * @param remotePath - The path to create
   */
  mkdir(remotePath: string): Promise<void>;

  /**
   * Check if a file/directory exists on the guest VM
   * @param remotePath - The path to check
   * @returns true if exists, false otherwise
   */
  exists(remotePath: string): Promise<boolean>;

  /**
   * Check if the guest is reachable
   * @returns true if reachable, false otherwise
   */
  isReachable(): Promise<boolean>;

  /**
   * Wait for the guest to become reachable
   * @param timeoutMs - Maximum time to wait
   * @param intervalMs - Polling interval (only used for polling-based implementations)
   */
  waitUntilReachable(timeoutMs: number, intervalMs?: number): Promise<void>;

  /**
   * Get the host/IP address of the guest (for logging purposes)
   */
  getHost(): string;
}
