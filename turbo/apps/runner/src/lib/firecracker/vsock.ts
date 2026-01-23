/**
 * Vsock Client for Firecracker VMs
 *
 * Provides host-side communication with guest via virtio-vsock.
 * Firecracker exposes vsock as a Unix Domain Socket (UDS) with a simple protocol:
 * 1. Connect to UDS
 * 2. Send "CONNECT port\n"
 * 3. Receive "OK host_port\n" on success
 * 4. Socket becomes bidirectional stream to guest
 *
 * After Firecracker handshake, uses length-prefixed JSON protocol:
 * - 4-byte length prefix (big endian) + JSON message
 * - Message types: ready, ping, pong, exec, exec_result, error
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { ExecResult, GuestClient } from "./guest.js";

const VSOCK_PORT = 1000;
const CONNECT_TIMEOUT_MS = 5000;
const HEADER_SIZE = 4;
const MAX_MESSAGE_SIZE = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 300000; // 5 minutes

// Message types matching the guest agent
type MessageType = "ready" | "ping" | "pong" | "exec" | "exec_result" | "error";

interface Message<T = unknown> {
  type: MessageType;
  id: string;
  payload: T;
}

interface ExecPayload {
  command: string;
  timeoutMs: number;
}

interface ExecResultPayload {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ErrorPayload {
  message: string;
}

// Encode message with length prefix
function encode<T>(msg: Message<T>): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf-8");
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Message decoder with buffering
class Decoder {
  private buf = Buffer.alloc(0);

  decode(data: Buffer): Message[] {
    this.buf = Buffer.concat([this.buf, data]);
    const messages: Message[] = [];

    while (this.buf.length >= HEADER_SIZE) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_MESSAGE_SIZE) throw new Error(`Message too large: ${len}`);

      const total = HEADER_SIZE + len;
      if (this.buf.length < total) break;

      const json = this.buf.subarray(HEADER_SIZE, total);
      messages.push(JSON.parse(json.toString("utf-8")));
      this.buf = this.buf.subarray(total);
    }
    return messages;
  }
}

/**
 * Connect to guest via vsock and wait for ready signal
 * Returns when guest agent is ready and responds to ping
 */
async function testVsockReady(vsockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(vsockPath)) {
      reject(new Error(`Vsock socket not found: ${vsockPath}`));
      return;
    }

    const socket = net.createConnection(vsockPath);
    const decoder = new Decoder();
    let fcConnected = false; // Firecracker handshake done
    let gotReady = false; // Guest agent ready signal received
    let pingId: string | null = null;

    const timeout = setTimeout(() => {
      console.log(`[Vsock] Timeout waiting for ready`);
      socket.destroy();
      reject(new Error("Vsock connection timeout"));
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      console.log(`[Vsock] Connected to UDS, sending CONNECT ${VSOCK_PORT}`);
      socket.write(`CONNECT ${VSOCK_PORT}\n`);
    });

    socket.on("data", (data: Buffer) => {
      if (!fcConnected) {
        // Waiting for Firecracker OK response
        const str = data.toString();
        if (str.startsWith("OK ")) {
          fcConnected = true;
          console.log(
            `[Vsock] Firecracker connected, waiting for ready signal`,
          );
        } else {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`Firecracker connect failed: ${str.trim()}`));
        }
        return;
      }

      // Parse length-prefixed JSON messages
      try {
        for (const msg of decoder.decode(data)) {
          console.log(`[Vsock] Received: type=${msg.type} id=${msg.id}`);

          if (msg.type === "ready") {
            gotReady = true;
            // Send ping to verify bidirectional communication
            pingId = crypto.randomUUID();
            const ping: Message = { type: "ping", id: pingId, payload: {} };
            console.log(`[Vsock] Got ready, sending ping id=${pingId}`);
            socket.write(encode(ping));
          } else if (msg.type === "pong" && msg.id === pingId) {
            // Success - guest agent is ready and responding
            console.log(`[Vsock] Got pong, agent ready`);
            clearTimeout(timeout);
            socket.end();
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error(`Vsock error: ${JSON.stringify(msg.payload)}`));
          }
        }
      } catch (e) {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error(`Failed to parse message: ${e}`));
      }
    });

    socket.on("error", (err) => {
      console.log(`[Vsock] Error: ${err.message}`);
      clearTimeout(timeout);
      reject(new Error(`Vsock error: ${err.message}`));
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      if (!gotReady) {
        reject(new Error("Vsock closed before ready"));
      }
    });
  });
}

/**
 * Wait for vsock to become ready by attempting connections with retry
 */
export async function waitForVsock(
  vsockPath: string,
  timeoutMs: number = 30000,
  intervalMs: number = 500,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      await testVsockReady(vsockPath);
      return; // Success
    } catch (e) {
      // Expected during VM boot, keep retrying
      console.log(`[Vsock] Retry: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Vsock not ready after ${timeoutMs}ms`);
}

/**
 * Vsock Client for VM communication
 *
 * Implements GuestClient interface for protocol-agnostic usage.
 * Maintains a persistent connection to the guest agent.
 */
export class VsockClient implements GuestClient {
  private vsockPath: string;
  private socket: net.Socket | null = null;
  private decoder: Decoder | null = null;
  private connected = false;
  private pendingRequests = new Map<
    string,
    {
      resolve: (msg: Message) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(vsockPath: string) {
    this.vsockPath = vsockPath;
  }

  /**
   * Connect to the guest agent via vsock
   */
  private async connect(): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.vsockPath)) {
        reject(new Error(`Vsock socket not found: ${this.vsockPath}`));
        return;
      }

      const socket = net.createConnection(this.vsockPath);
      const decoder = new Decoder();
      let fcConnected = false;
      let gotReady = false;
      let pingId: string | null = null;

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Vsock connection timeout"));
      }, CONNECT_TIMEOUT_MS);

      socket.on("connect", () => {
        socket.write(`CONNECT ${VSOCK_PORT}\n`);
      });

      socket.on("data", (data: Buffer) => {
        if (!fcConnected) {
          const str = data.toString();
          if (str.startsWith("OK ")) {
            fcConnected = true;
          } else {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error(`Firecracker connect failed: ${str.trim()}`));
          }
          return;
        }

        try {
          for (const msg of decoder.decode(data)) {
            if (!gotReady && msg.type === "ready") {
              gotReady = true;
              pingId = crypto.randomUUID();
              const ping: Message = { type: "ping", id: pingId, payload: {} };
              socket.write(encode(ping));
            } else if (msg.type === "pong" && msg.id === pingId) {
              clearTimeout(timeout);
              this.socket = socket;
              this.decoder = decoder;
              this.connected = true;
              this.setupMessageHandler();
              resolve();
            } else if (gotReady) {
              // After connection established, route to pending requests
              this.handleMessage(msg);
            }
          }
        } catch (e) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`Failed to parse message: ${e}`));
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        this.connected = false;
        this.socket = null;
        reject(new Error(`Vsock error: ${err.message}`));
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        this.connected = false;
        this.socket = null;
        if (!gotReady) {
          reject(new Error("Vsock closed before ready"));
        }
        // Reject all pending requests
        for (const [id, req] of this.pendingRequests) {
          clearTimeout(req.timeout);
          req.reject(new Error("Connection closed"));
          this.pendingRequests.delete(id);
        }
      });
    });
  }

  /**
   * Setup message handler for connected socket
   */
  private setupMessageHandler(): void {
    if (!this.socket || !this.decoder) return;

    this.socket.on("data", (data: Buffer) => {
      try {
        for (const msg of this.decoder!.decode(data)) {
          this.handleMessage(msg);
        }
      } catch (e) {
        console.error(`[Vsock] Failed to decode message: ${e}`);
      }
    });
  }

  /**
   * Handle incoming message and route to pending request
   */
  private handleMessage(msg: Message): void {
    const pending = this.pendingRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.id);
      pending.resolve(msg);
    }
  }

  /**
   * Send a request and wait for response
   */
  private async request<T, R>(
    type: MessageType,
    payload: T,
    timeoutMs: number,
  ): Promise<Message<R>> {
    await this.connect();

    if (!this.socket) {
      throw new Error("Not connected");
    }

    const id = crypto.randomUUID();
    const msg: Message<T> = { type, id, payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${type}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (msg: Message) => void,
        reject,
        timeout,
      });

      this.socket!.write(encode(msg));
    });
  }

  /**
   * Execute a command on the remote VM
   */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    const actualTimeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    try {
      const response = await this.request<ExecPayload, ExecResultPayload>(
        "exec",
        { command, timeoutMs: actualTimeout },
        actualTimeout + 5000, // Add buffer for network latency
      );

      if (response.type === "error") {
        const errorPayload = response.payload as unknown as ErrorPayload;
        return {
          exitCode: 1,
          stdout: "",
          stderr: errorPayload.message,
        };
      }

      return {
        exitCode: response.payload.exitCode,
        stdout: response.payload.stdout,
        stderr: response.payload.stderr,
      };
    } catch (e) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
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
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    // Use exec with base64 encoding (same as SSH client)
    const encoded = Buffer.from(content).toString("base64");
    const maxChunkSize = 65000;

    if (encoded.length <= maxChunkSize) {
      await this.execOrThrow(`echo '${encoded}' | base64 -d > '${remotePath}'`);
    } else {
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
   */
  async writeFileWithSudo(remotePath: string, content: string): Promise<void> {
    const encoded = Buffer.from(content).toString("base64");
    const maxChunkSize = 65000;

    if (encoded.length <= maxChunkSize) {
      await this.execOrThrow(
        `echo '${encoded}' | base64 -d | sudo tee '${remotePath}' > /dev/null`,
      );
    } else {
      await this.execOrThrow(`sudo rm -f '${remotePath}'`);
      for (let i = 0; i < encoded.length; i += maxChunkSize) {
        const chunk = encoded.slice(i, i + maxChunkSize);
        const teeFlag = i === 0 ? "" : "-a";
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
   * Check if vsock connection is available
   */
  async isReachable(): Promise<boolean> {
    try {
      const result = await this.exec("echo ok", 15000);
      return result.exitCode === 0 && result.stdout.trim() === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Wait for vsock to become available
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

      await new Promise<void>((resolve) => {
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining > 0) {
          setTimeout(resolve, Math.min(intervalMs, remaining));
        } else {
          resolve();
        }
      });
    }

    throw new Error(`Vsock not reachable after ${timeoutMs}ms`);
  }

  /**
   * Create a directory on the remote VM
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
   * Get the vsock path (for logging/debugging)
   */
  getVsockPath(): string {
    return this.vsockPath;
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
    for (const [id, req] of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error("Connection closed"));
      this.pendingRequests.delete(id);
    }
  }
}
