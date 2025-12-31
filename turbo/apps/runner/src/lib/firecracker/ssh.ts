/**
 * SSH Client for VM Communication
 *
 * Provides SSH-based command execution and file transfer for Firecracker VMs.
 * Uses the system's ssh and scp commands for simplicity.
 */

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * SSH connection configuration
 */
export interface SSHConfig {
  host: string;
  user: string;
  port?: number;
  privateKeyPath?: string;
  connectTimeoutSec?: number;
}

/**
 * Result of command execution
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * SSH Client for VM communication
 */
export class SSHClient {
  private config: SSHConfig;
  private sshOptions: string[];

  constructor(config: SSHConfig) {
    this.config = {
      port: 22,
      connectTimeoutSec: 10,
      ...config,
    };

    // Build common SSH options
    this.sshOptions = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      `ConnectTimeout=${this.config.connectTimeoutSec}`,
      "-p",
      String(this.config.port),
    ];

    if (this.config.privateKeyPath) {
      this.sshOptions.push("-i", this.config.privateKeyPath);
    }
  }

  /**
   * Get SSH connection string
   */
  private getTarget(): string {
    return `${this.config.user}@${this.config.host}`;
  }

  /**
   * Execute a command on the remote VM
   */
  async exec(command: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const args = [...this.sshOptions, this.getTarget(), command];

      const proc = spawn("ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });

      proc.on("error", (err) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
        });
      });
    });
  }

  /**
   * Execute a command and throw on non-zero exit
   */
  async execOrThrow(command: string): Promise<string> {
    const result = await this.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(
        `SSH command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    return result.stdout;
  }

  /**
   * Copy a file to the remote VM
   */
  async copyTo(localPath: string, remotePath: string): Promise<void> {
    const scpOptions = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-P",
      String(this.config.port),
    ];

    if (this.config.privateKeyPath) {
      scpOptions.push("-i", this.config.privateKeyPath);
    }

    const args = [
      ...scpOptions,
      localPath,
      `${this.getTarget()}:${remotePath}`,
    ];

    try {
      await execAsync(`scp ${args.map((a) => `"${a}"`).join(" ")}`);
    } catch (error) {
      const execError = error as { stderr?: string; message?: string };
      throw new Error(`SCP failed: ${execError.stderr || execError.message}`);
    }
  }

  /**
   * Copy a file from the remote VM
   */
  async copyFrom(remotePath: string, localPath: string): Promise<void> {
    const scpOptions = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-P",
      String(this.config.port),
    ];

    if (this.config.privateKeyPath) {
      scpOptions.push("-i", this.config.privateKeyPath);
    }

    const args = [
      ...scpOptions,
      `${this.getTarget()}:${remotePath}`,
      localPath,
    ];

    try {
      await execAsync(`scp ${args.map((a) => `"${a}"`).join(" ")}`);
    } catch (error) {
      const execError = error as { stderr?: string; message?: string };
      throw new Error(`SCP failed: ${execError.stderr || execError.message}`);
    }
  }

  /**
   * Write content directly to a remote file
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    // Use cat with heredoc to write file content
    // Single-quoted heredoc delimiter prevents all shell interpretation
    const command = `cat > ${remotePath} << 'VM0_EOF'\n${content}\nVM0_EOF`;
    await this.execOrThrow(command);
  }

  /**
   * Read a remote file's content
   */
  async readFile(remotePath: string): Promise<string> {
    return this.execOrThrow(`cat ${remotePath}`);
  }

  /**
   * Check if SSH connection is available
   */
  async isReachable(): Promise<boolean> {
    try {
      const result = await this.exec("echo ok");
      return result.exitCode === 0 && result.stdout.trim() === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Wait for SSH to become available
   */
  async waitUntilReachable(
    timeoutMs: number = 60000,
    intervalMs: number = 1000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isReachable()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `SSH not reachable after ${timeoutMs}ms at ${this.config.host}`,
    );
  }

  /**
   * Create a directory on the remote (mkdir -p)
   */
  async mkdir(remotePath: string): Promise<void> {
    await this.execOrThrow(`mkdir -p ${remotePath}`);
  }

  /**
   * Check if a file/directory exists
   */
  async exists(remotePath: string): Promise<boolean> {
    const result = await this.exec(`test -e ${remotePath}`);
    return result.exitCode === 0;
  }
}

/**
 * Create an SSH client for a VM
 * Uses default VM credentials (root with no password)
 */
export function createVMSSHClient(host: string, port: number = 22): SSHClient {
  return new SSHClient({
    host,
    user: "root",
    port,
    connectTimeoutSec: 10,
  });
}
