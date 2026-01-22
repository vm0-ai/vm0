/**
 * Vsock Client for Host-Guest Communication
 *
 * Communicates with guest VMs via vsock (virtio-vsock).
 * This provides faster communication than SSH by eliminating
 * TCP/IP stack overhead and SSH protocol overhead.
 *
 * Architecture:
 * - Firecracker creates a Unix socket at {workDir}/vsock.sock
 * - Host connects to vsock.sock and sends "CONNECT PORT\n" to reach guest
 * - Guest vsock-agent listens on the vsock port using VSOCK-LISTEN
 * - Firecracker bridges the connection between host and guest
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
 * The host connects to vsock.sock and sends "CONNECT PORT\n" to reach the guest.
 * The guest must be listening on that port using VSOCK-LISTEN.
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
  private handshakeComplete: boolean = false;
  private waitingForReady: boolean = false; // True when awaiting ready signal after successful connect

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
   * Connect to the vsock socket and set up message handling
   *
   * Firecracker vsock protocol for host-to-guest connections:
   * 1. Host connects to the base vsock.sock Unix socket
   * 2. Host sends "CONNECT PORT\n" where PORT is the guest's listening port
   * 3. Firecracker responds with "OK HOST_PORT\n" if guest is listening
   * 4. Connection is then bridged to the guest
   */
  private async connect(): Promise<void> {
    if (this.connected && this.socket && this.handshakeComplete) {
      return;
    }

    // Wait for base socket file to exist
    const maxWait = 30000; // 30 seconds
    const startTime = Date.now();

    while (!fs.existsSync(this.vsockBasePath)) {
      if (Date.now() - startTime > maxWait) {
        throw new Error(
          `Vsock base socket not created at ${this.vsockBasePath} after ${maxWait}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(this.vsockBasePath);
      let handshakeBuffer = "";

      const onConnect = (): void => {
        this.connected = true;
        console.log(`[VsockClient] Connected to ${this.vsockBasePath}`);

        // Send CONNECT command to Firecracker to reach the guest
        const connectCmd = `CONNECT ${VSOCK_CONSTANTS.PORT}\n`;
        console.log(`[VsockClient] Sending: CONNECT ${VSOCK_CONSTANTS.PORT}`);
        this.socket!.write(connectCmd);
      };

      const onData = (data: Buffer): void => {
        if (!this.handshakeComplete) {
          // Still in handshake phase - looking for "OK PORT\n"
          handshakeBuffer += data.toString();
          const lines = handshakeBuffer.split("\n");

          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i] ?? "";
            if (line.startsWith("OK ")) {
              console.log(`[VsockClient] Handshake response: ${line}`);
              this.handshakeComplete = true;

              // Remove handshake data and switch to normal message handling
              this.socket!.removeListener("data", onData);
              this.socket!.on("data", (d: Buffer) => this.handleData(d));

              // Process any remaining data after the handshake
              const remaining = lines.slice(i + 1).join("\n");
              if (remaining.length > 0) {
                this.handleData(Buffer.from(remaining));
              }

              resolve();
              return;
            } else if (line.length > 0) {
              // Unexpected response - connection might have failed
              console.error(
                `[VsockClient] Unexpected handshake response: ${line}`,
              );
            }
          }
          // Keep the incomplete line for next data event
          handshakeBuffer = lines[lines.length - 1] ?? "";
        }
      };

      this.socket.on("connect", onConnect);
      this.socket.on("data", onData);

      this.socket.on("error", (err) => {
        console.error(`[VsockClient] Socket error: ${err.message}`);
        if (!this.handshakeComplete) {
          reject(err);
        }
        this.cleanup();
      });

      this.socket.on("close", () => {
        console.log("[VsockClient] Socket closed");
        if (!this.handshakeComplete) {
          reject(new Error("Connection closed during handshake"));
        }
        this.cleanup();
      });

      // Timeout for handshake (5 seconds - allows faster retries if guest not ready)
      setTimeout(() => {
        if (!this.handshakeComplete) {
          this.cleanup();
          reject(
            new Error(
              `Vsock handshake timeout - guest may not be listening on port ${VSOCK_CONSTANTS.PORT}`,
            ),
          );
        }
      }, 5000);
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
    this.handshakeComplete = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Connection closed"));
      this.pendingRequests.delete(id);
    }

    // Reject ready promise only if we're actually waiting for ready signal
    // During connection phase, let connect() handle its own rejection
    if (this.readyReject && this.waitingForReady) {
      this.readyReject(new Error("Connection closed"));
      this.readyResolve = null;
      this.readyReject = null;
    }
    this.waitingForReady = false;

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
   * Check if the guest is reachable (base vsock socket exists)
   */
  async isReachable(): Promise<boolean> {
    try {
      return fs.existsSync(this.vsockBasePath);
    } catch {
      return false;
    }
  }

  /**
   * Wait for the guest to become reachable
   * Unlike SSH, vsock uses push-based ready signal from guest
   *
   * This method retries connecting until:
   * 1. The connection succeeds and handshake completes
   * 2. The ready signal is received from guest
   * 3. The timeout expires
   */
  async waitUntilReachable(timeoutMs: number = 120000): Promise<void> {
    const startTime = Date.now();
    const retryIntervalMs = 500; // Retry every 500ms if connection fails

    // Create ready promise if not already waiting
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }

    // Retry connecting until success or timeout
    // The guest's vsock-agent may not be ready immediately after VM boots
    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.connect();
        // Connection succeeded, now we're waiting for ready signal
        this.waitingForReady = true;
        break;
      } catch (error) {
        // Connection failed - guest vsock-agent probably not ready yet
        const elapsed = Date.now() - startTime;
        const remaining = timeoutMs - elapsed;

        if (remaining <= 0) {
          throw new Error(
            `Vsock connection failed after ${timeoutMs}ms: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Clean up failed connection state before retry
        this.cleanup();

        // Reset ready promise for next attempt
        this.readyPromise = new Promise<void>((resolve, reject) => {
          this.readyResolve = resolve;
          this.readyReject = reject;
        });

        // Wait before retrying
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(retryIntervalMs, remaining)),
        );
      }
    }

    // Set up timeout for ready signal
    const remaining = timeoutMs - (Date.now() - startTime);
    const timeout = setTimeout(
      () => {
        if (this.readyReject) {
          this.readyReject(
            new Error(`Guest not ready after ${timeoutMs}ms via vsock`),
          );
          this.readyResolve = null;
          this.readyReject = null;
        }
      },
      Math.max(remaining, 0),
    );

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
