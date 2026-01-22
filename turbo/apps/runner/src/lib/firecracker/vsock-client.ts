/**
 * Vsock Client for Host-Guest Communication
 *
 * Communicates with guest VMs via vsock (virtio-vsock).
 * This provides faster communication than SSH by eliminating
 * TCP/IP stack overhead and SSH protocol overhead.
 *
 * Architecture:
 * - Firecracker creates a Unix socket at {workDir}/vsock.sock
 * - Host connects to vsock.sock_{PORT} to communicate with guest
 * - Guest vsock-agent connects to host CID 2 on the same port
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { GuestClient, ExecResult } from "./guest-client.js";
import {
  type VsockMessage,
  type VsockMessageType,
  type ExecPayload,
  type ExecResultPayload,
  type WriteFilePayload,
  type WriteAckPayload,
  type ReadFilePayload,
  type FileContentPayload,
  type ErrorPayload,
  VSOCK_CONSTANTS,
  encodeVsockMessage,
  decodeVsockMessage,
} from "@vm0/core";

/**
 * Pending request tracker
 */
interface PendingRequest {
  resolve: (message: VsockMessage) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Vsock Client for Firecracker VM communication
 *
 * Uses the vsock Unix socket created by Firecracker for host-guest communication.
 * Firecracker creates per-port sockets at {vsockPath}_{PORT} when a connection
 * is made to that port from the guest.
 */
export class VsockClient implements GuestClient {
  private vsockBasePath: string;
  private guestCid: number;
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private connected: boolean = false;

  /**
   * Create a new VsockClient
   * @param vsockBasePath - Path to Firecracker's vsock Unix socket (e.g., /tmp/vm0-vm-xxx/vsock.sock)
   * @param guestCid - Guest CID (Context ID) for this VM
   */
  constructor(vsockBasePath: string, guestCid: number) {
    this.vsockBasePath = vsockBasePath;
    this.guestCid = guestCid;
  }

  /**
   * Get the vsock socket path for the specified port
   * Firecracker creates sockets at {vsockPath}_{PORT}
   */
  private getSocketPath(port: number = VSOCK_CONSTANTS.PORT): string {
    return `${this.vsockBasePath}_${port}`;
  }

  /**
   * Connect to the vsock socket and set up message handling
   */
  private async connect(): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }

    const socketPath = this.getSocketPath();

    // Wait for socket file to be created by Firecracker when guest connects
    const maxWait = 30000; // 30 seconds
    const startTime = Date.now();

    while (!fs.existsSync(socketPath)) {
      if (Date.now() - startTime > maxWait) {
        throw new Error(
          `Vsock socket not created at ${socketPath} after ${maxWait}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(socketPath);

      this.socket.on("connect", () => {
        this.connected = true;
        console.log(`[VsockClient] Connected to ${socketPath}`);
        resolve();
      });

      this.socket.on("data", (data: Buffer) => {
        this.handleData(data);
      });

      this.socket.on("error", (err) => {
        console.error(`[VsockClient] Socket error: ${err.message}`);
        if (!this.connected) {
          reject(err);
        }
        this.cleanup();
      });

      this.socket.on("close", () => {
        console.log("[VsockClient] Socket closed");
        this.cleanup();
      });
    });
  }

  /**
   * Handle incoming data from the socket
   */
  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    // Try to decode complete messages
    let result = decodeVsockMessage(this.buffer);
    while (result !== null) {
      const { message, remaining } = result;
      this.buffer = remaining;

      this.handleMessage(message);

      result = decodeVsockMessage(this.buffer);
    }
  }

  /**
   * Handle a decoded message
   */
  private handleMessage(message: VsockMessage): void {
    // Check if this is the ready signal
    if (message.type === "ready") {
      console.log("[VsockClient] Received ready signal from guest");
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
        this.readyReject = null;
      }
      return;
    }

    // Look for pending request with this ID
    const pending = this.pendingRequests.get(message.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(message.id);

      if (message.type === "error") {
        const payload = message.payload as ErrorPayload;
        pending.reject(new Error(payload.message));
      } else {
        pending.resolve(message);
      }
    }
  }

  /**
   * Send a request and wait for response
   */
  private async sendRequest<T>(
    type: VsockMessageType,
    payload: unknown,
    timeoutMs: number = 300000,
  ): Promise<VsockMessage<T>> {
    await this.connect();

    if (!this.socket || !this.connected) {
      throw new Error("Vsock not connected");
    }

    const id = crypto.randomUUID();
    const message: VsockMessage = { type, id, payload };

    return new Promise<VsockMessage<T>>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (message: VsockMessage) => void,
        reject,
        timeoutId,
      });

      const encoded = encodeVsockMessage(message);
      this.socket!.write(encoded);
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Connection closed"));
      this.pendingRequests.delete(id);
    }

    // Reject ready promise if pending
    if (this.readyReject) {
      this.readyReject(new Error("Connection closed"));
      this.readyResolve = null;
      this.readyReject = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Execute a command on the guest VM
   */
  async exec(command: string, timeoutMs: number = 300000): Promise<ExecResult> {
    const payload: ExecPayload = { command, timeoutMs };
    const response = await this.sendRequest<ExecResultPayload>(
      "exec",
      payload,
      timeoutMs + 5000, // Add buffer for network overhead
    );

    const result = response.payload as ExecResultPayload;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
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
   * Write content to a file on the guest VM
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    const payload: WriteFilePayload = {
      path: remotePath,
      content: Buffer.from(content).toString("base64"),
      sudo: false,
    };

    const response = await this.sendRequest<WriteAckPayload>(
      "write_file",
      payload,
    );
    const result = response.payload as WriteAckPayload;

    if (!result.success) {
      throw new Error(`Failed to write file: ${remotePath}`);
    }
  }

  /**
   * Write content to a file on the guest VM using sudo
   */
  async writeFileWithSudo(remotePath: string, content: string): Promise<void> {
    const payload: WriteFilePayload = {
      path: remotePath,
      content: Buffer.from(content).toString("base64"),
      sudo: true,
    };

    const response = await this.sendRequest<WriteAckPayload>(
      "write_file",
      payload,
    );
    const result = response.payload as WriteAckPayload;

    if (!result.success) {
      throw new Error(`Failed to write file with sudo: ${remotePath}`);
    }
  }

  /**
   * Read a file from the guest VM
   */
  async readFile(remotePath: string): Promise<string> {
    const payload: ReadFilePayload = { path: remotePath };
    const response = await this.sendRequest<FileContentPayload>(
      "read_file",
      payload,
    );
    const result = response.payload as FileContentPayload;

    return Buffer.from(result.content, "base64").toString("utf-8");
  }

  /**
   * Create a directory on the guest VM (mkdir -p)
   */
  async mkdir(remotePath: string): Promise<void> {
    await this.execOrThrow(`mkdir -p '${remotePath}'`);
  }

  /**
   * Check if a file/directory exists on the guest VM
   */
  async exists(remotePath: string): Promise<boolean> {
    const result = await this.exec(`test -e '${remotePath}'`);
    return result.exitCode === 0;
  }

  /**
   * Check if the guest is reachable (ready signal received)
   */
  async isReachable(): Promise<boolean> {
    try {
      const socketPath = this.getSocketPath();
      return fs.existsSync(socketPath);
    } catch {
      return false;
    }
  }

  /**
   * Wait for the guest to become reachable
   * Unlike SSH, vsock uses push-based ready signal from guest
   */
  async waitUntilReachable(timeoutMs: number = 120000): Promise<void> {
    // Create ready promise if not already waiting
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }

    // Try to connect and wait for ready signal
    await this.connect();

    // Set up timeout
    const timeout = setTimeout(() => {
      if (this.readyReject) {
        this.readyReject(
          new Error(`Guest not ready after ${timeoutMs}ms via vsock`),
        );
        this.readyResolve = null;
        this.readyReject = null;
      }
    }, timeoutMs);

    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get the host identifier (vsock path and CID)
   */
  getHost(): string {
    return `vsock://${this.guestCid}@${this.vsockBasePath}`;
  }

  /**
   * Close the vsock connection
   */
  close(): void {
    this.cleanup();
  }
}
