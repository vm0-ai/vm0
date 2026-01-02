/**
 * Vsock Client for VM Communication
 *
 * Provides vsock-based command execution for Firecracker VMs.
 * Uses Firecracker's vsock device which exposes a Unix socket on the host.
 *
 * Architecture:
 * - Host: Connects to Unix socket created by Firecracker
 * - Guest: vm0-agent daemon listens on vsock port 5000
 */

import net from "node:net";
import fs from "node:fs";

/**
 * Vsock connection configuration
 */
export interface VsockConfig {
  socketPath: string; // Path to Firecracker's vsock Unix socket
  port: number; // Guest port (default: 5000)
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
 * Message types for vm0-agent protocol
 */
interface AgentRequest {
  type: "exec" | "write_file" | "read_file" | "ping";
  command?: string;
  path?: string;
  content?: string;
}

interface AgentResponse {
  type: "result" | "error" | "pong";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  content?: string;
  error?: string;
}

/**
 * Vsock Client for VM communication
 * Communicates with vm0-agent daemon running in the guest
 */
export class VsockClient {
  private config: VsockConfig;

  constructor(config: VsockConfig) {
    this.config = config;
  }

  /**
   * Connect to the vsock and send a request
   *
   * Firecracker vsock protocol:
   * 1. Connect to the Unix socket at socketPath
   * 2. Send "CONNECT <port>\n" to initiate connection to guest
   * 3. Wait for "OK <hostside_port>\n" response
   * 4. Send JSON request, receive JSON response
   */
  private async sendRequest(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      // Connect to Firecracker's vsock Unix socket directly
      const socket = net.createConnection(this.config.socketPath, () => {
        // Send CONNECT command to establish connection to guest port
        socket.write(`CONNECT ${this.config.port}\n`);
      });

      let phase: "connect" | "response" = "connect";
      let data = "";

      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString();

        if (phase === "connect") {
          // Check for OK response from Firecracker
          const newlineIdx = data.indexOf("\n");
          if (newlineIdx !== -1) {
            const connectResponse = data.substring(0, newlineIdx);
            if (connectResponse.startsWith("OK")) {
              // Connection established, send the actual request
              phase = "response";
              data = data.substring(newlineIdx + 1); // Keep any remaining data
              socket.write(JSON.stringify(request) + "\n");
            } else {
              socket.destroy();
              reject(
                new Error(
                  `Vsock CONNECT failed: ${connectResponse || "connection closed"}`,
                ),
              );
            }
          }
        }
      });

      socket.on("end", () => {
        if (phase === "connect") {
          reject(new Error("Vsock connection closed before CONNECT completed"));
          return;
        }

        try {
          const response = JSON.parse(data) as AgentResponse;
          resolve(response);
        } catch {
          reject(new Error(`Invalid response from agent: ${data}`));
        }
      });

      socket.on("error", (err: Error) => {
        reject(new Error(`Vsock connection error: ${err.message}`));
      });

      // Timeout after 60 seconds
      socket.setTimeout(60000, () => {
        socket.destroy();
        reject(new Error("Vsock connection timeout"));
      });
    });
  }

  /**
   * Execute a command on the guest VM
   */
  async exec(command: string): Promise<ExecResult> {
    const response = await this.sendRequest({
      type: "exec",
      command,
    });

    if (response.type === "error") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: response.error || "Unknown error",
      };
    }

    return {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout || "",
      stderr: response.stderr || "",
    };
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
   * Write content to a file on the guest
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    const response = await this.sendRequest({
      type: "write_file",
      path: remotePath,
      content,
    });

    if (response.type === "error") {
      throw new Error(`Failed to write file: ${response.error}`);
    }
  }

  /**
   * Read a file from the guest
   */
  async readFile(remotePath: string): Promise<string> {
    const response = await this.sendRequest({
      type: "read_file",
      path: remotePath,
    });

    if (response.type === "error") {
      throw new Error(`Failed to read file: ${response.error}`);
    }

    return response.content || "";
  }

  /**
   * Check if the agent is reachable
   */
  async isReachable(): Promise<boolean> {
    try {
      const response = await this.sendRequest({ type: "ping" });
      return response.type === "pong";
    } catch {
      return false;
    }
  }

  /**
   * Wait for the agent to become available
   */
  async waitUntilReachable(
    timeoutMs: number = 60000,
    intervalMs: number = 1000,
  ): Promise<void> {
    const start = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - start < timeoutMs) {
      try {
        if (await this.isReachable()) {
          return;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Wait before retry using a promise
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
      `Agent not reachable after ${timeoutMs}ms at ${this.config.socketPath}: ${lastError?.message || "timeout"}`,
    );
  }

  /**
   * Create a directory on the guest (mkdir -p)
   */
  async mkdir(remotePath: string): Promise<void> {
    await this.execOrThrow(`mkdir -p ${remotePath}`);
  }

  /**
   * Check if a file/directory exists on the guest
   */
  async exists(remotePath: string): Promise<boolean> {
    const result = await this.exec(`test -e ${remotePath}`);
    return result.exitCode === 0;
  }
}

/**
 * Create a vsock client for a VM
 */
export function createVMVsockClient(
  vsockSocketPath: string,
  port: number = 5000,
): VsockClient {
  return new VsockClient({
    socketPath: vsockSocketPath,
    port,
  });
}

/**
 * Check if vsock socket exists
 */
export function vsockSocketExists(socketPath: string): boolean {
  return fs.existsSync(socketPath);
}
