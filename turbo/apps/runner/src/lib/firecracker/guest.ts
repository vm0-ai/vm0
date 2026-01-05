/**
 * Guest Communication Client
 *
 * Provides communication with Firecracker VM guests.
 * Uses SSH for command execution and file transfer.
 *
 * This module abstracts the communication protocol (SSH) from the rest of the codebase,
 * allowing for potential future changes (e.g., vsock) without affecting consumers.
 */

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);

/**
 * Result of command execution
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * SSH client configuration
 */
export interface SSHConfig {
  host: string;
  user: string;
  privateKeyPath?: string;
  connectTimeout?: number; // seconds
}

/**
 * Default SSH options for Firecracker VMs
 * - Disable strict host key checking (VMs are ephemeral)
 * - Short timeouts for faster failure detection
 */
const DEFAULT_SSH_OPTIONS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=3",
];

/**
 * SSH Client for VM communication
 */
export class SSHClient {
  private config: SSHConfig;
  private sshOptions: string[];

  constructor(config: SSHConfig) {
    this.config = config;
    this.sshOptions = [...DEFAULT_SSH_OPTIONS];

    if (config.privateKeyPath) {
      this.sshOptions.push("-i", config.privateKeyPath);
    }

    if (config.connectTimeout) {
      // Override default timeout
      const idx = this.sshOptions.indexOf("ConnectTimeout=10");
      if (idx !== -1) {
        this.sshOptions[idx] = `ConnectTimeout=${config.connectTimeout}`;
      }
    }
  }

  /**
   * Build SSH command prefix
   */
  private buildSSHCommand(): string[] {
    return [
      "ssh",
      ...this.sshOptions,
      `${this.config.user}@${this.config.host}`,
    ];
  }

  /**
   * Execute a command on the remote VM
   */
  async exec(command: string): Promise<ExecResult> {
    const sshCmd = this.buildSSHCommand();
    // Quote the command to ensure pipes and redirections run on remote, not local
    const escapedCommand = command.replace(/'/g, "'\\''");
    const fullCmd = [...sshCmd, `'${escapedCommand}'`].join(" ");

    try {
      const { stdout, stderr } = await execAsync(fullCmd, {
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        timeout: 300000, // 5 minute timeout
      });

      return {
        exitCode: 0,
        stdout: stdout || "",
        stderr: stderr || "",
      };
    } catch (error) {
      // exec throws on non-zero exit code
      const execError = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      return {
        exitCode: execError.code ?? 1,
        stdout: execError.stdout || "",
        stderr: execError.stderr || execError.message || "Unknown error",
      };
    }
  }

  /**
   * Execute a command and throw on non-zero exit
   */
  async execOrThrow(command: string): Promise<string> {
    const result = await this.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }
    return result.stdout;
  }

  /**
   * Write content to a file on the remote VM
   * Uses base64 encoding to safely transfer any content
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    // Base64 encode to handle any special characters
    const encoded = Buffer.from(content).toString("base64");

    // Use echo with base64 decode to write the file
    // Split into chunks if content is too large for command line
    const maxChunkSize = 65000; // Safe limit for command line

    if (encoded.length <= maxChunkSize) {
      // Small file - single command
      await this.execOrThrow(`echo '${encoded}' | base64 -d > '${remotePath}'`);
    } else {
      // Large file - use multiple commands with append
      await this.execOrThrow(`rm -f '${remotePath}'`);

      for (let i = 0; i < encoded.length; i += maxChunkSize) {
        const chunk = encoded.slice(i, i + maxChunkSize);
        const operator = i === 0 ? ">" : ">>";
        await this.execOrThrow(
          `echo '${chunk}' | base64 -d ${operator} '${remotePath}'`,
        );
      }
    }
  }

  /**
   * Write content to a file on the remote VM using sudo
   * Used for writing to privileged locations like /usr/local/bin
   */
  async writeFileWithSudo(remotePath: string, content: string): Promise<void> {
    // Base64 encode to handle any special characters
    const encoded = Buffer.from(content).toString("base64");

    // Use sudo tee to write the file
    // Split into chunks if content is too large for command line
    const maxChunkSize = 65000; // Safe limit for command line

    if (encoded.length <= maxChunkSize) {
      // Small file - single command
      await this.execOrThrow(
        `echo '${encoded}' | base64 -d | sudo tee '${remotePath}' > /dev/null`,
      );
    } else {
      // Large file - use multiple commands with append
      await this.execOrThrow(`sudo rm -f '${remotePath}'`);

      for (let i = 0; i < encoded.length; i += maxChunkSize) {
        const chunk = encoded.slice(i, i + maxChunkSize);
        const teeFlag = i === 0 ? "" : "-a"; // -a for append mode
        await this.execOrThrow(
          `echo '${chunk}' | base64 -d | sudo tee ${teeFlag} '${remotePath}' > /dev/null`,
        );
      }
    }
  }

  /**
   * Read a file from the remote VM
   */
  async readFile(remotePath: string): Promise<string> {
    const result = await this.exec(`cat '${remotePath}'`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file: ${result.stderr}`);
    }
    return result.stdout;
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
    timeoutMs: number = 120000,
    intervalMs: number = 2000,
  ): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (await this.isReachable()) {
        return;
      }

      // Wait before retry
      await new Promise<void>((resolve) => {
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining > 0) {
          setTimeout(resolve, Math.min(intervalMs, remaining));
        } else {
          resolve();
        }
      });
    }

    throw new Error(
      `SSH not reachable after ${timeoutMs}ms at ${this.config.host}`,
    );
  }

  /**
   * Create a directory on the remote VM (mkdir -p)
   */
  async mkdir(remotePath: string): Promise<void> {
    await this.execOrThrow(`mkdir -p '${remotePath}'`);
  }

  /**
   * Check if a file/directory exists on the remote VM
   */
  async exists(remotePath: string): Promise<boolean> {
    const result = await this.exec(`test -e '${remotePath}'`);
    return result.exitCode === 0;
  }

  /**
   * Get the host IP
   */
  getHost(): string {
    return this.config.host;
  }
}

/**
 * Create an SSH client for a VM
 */
export function createVMSSHClient(
  guestIp: string,
  user: string = "root",
  privateKeyPath?: string,
): SSHClient {
  return new SSHClient({
    host: guestIp,
    user,
    privateKeyPath,
  });
}

/**
 * Get the default SSH private key path for the runner
 * The runner uses a dedicated key pair for VM access
 */
export function getRunnerSSHKeyPath(): string {
  // Check for runner-specific key first
  const runnerKeyPath = "/opt/vm0-runner/ssh/id_rsa";
  if (fs.existsSync(runnerKeyPath)) {
    return runnerKeyPath;
  }

  // Fall back to user's SSH key
  const userKeyPath = path.join(os.homedir(), ".ssh", "id_rsa");
  if (fs.existsSync(userKeyPath)) {
    return userKeyPath;
  }

  // No key found - SSH will try default locations
  return "";
}

/**
 * Generate SSH key pair for runner if it doesn't exist
 */
export function ensureRunnerSSHKey(): {
  publicKey: string;
  privateKeyPath: string;
} {
  const keyDir = "/opt/vm0-runner/ssh";
  const privateKeyPath = path.join(keyDir, "id_rsa");
  const publicKeyPath = path.join(keyDir, "id_rsa.pub");

  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    return {
      publicKey: fs.readFileSync(publicKeyPath, "utf-8").trim(),
      privateKeyPath,
    };
  }

  // Create directory
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });

  // Generate key pair
  execSync(
    `ssh-keygen -t rsa -b 4096 -f '${privateKeyPath}' -N '' -C 'vm0-runner'`,
    { stdio: "pipe" },
  );

  // Set correct permissions
  fs.chmodSync(privateKeyPath, 0o600);
  fs.chmodSync(publicKeyPath, 0o644);

  return {
    publicKey: fs.readFileSync(publicKeyPath, "utf-8").trim(),
    privateKeyPath,
  };
}
