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
 * Vsock Client for VM communication
 *
 * Implements GuestClient interface for protocol-agnostic usage.
 * Maintains a persistent connection to the guest agent.
 */
export class VsockClient implements GuestClient {
  private vsockPath: string;
  private socket: net.Socket | null = null;
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
   *
   * Connection flow:
   * 1. Connect to Firecracker's vsock UDS
   * 2. Send "CONNECT port\n", receive "OK port\n"
   * 3. Receive "ready" message from guest agent
   * 4. Send "ping", receive "pong" to verify connection
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

      // Connection state machine
      const enum State {
        WaitingForOK,
        WaitingForReady,
        WaitingForPong,
        Connected,
      }
      let state = State.WaitingForOK;
      let pingId: string | null = null;
      let settled = false; // Track if promise is already resolved/rejected

      // Buffer for accumulating incomplete data
      let buffer = Buffer.alloc(0);

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("Vsock connection timeout"));
        }
      }, CONNECT_TIMEOUT_MS);

      const cleanup = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.destroy();
          reject(err);
        }
      };

      socket.on("connect", () => {
        socket.write(`CONNECT ${VSOCK_PORT}\n`);
      });

      // Process length-prefixed messages after handshake
      const processMessages = (): void => {
        try {
          for (const msg of decoder.decode(buffer)) {
            if (state === State.WaitingForReady && msg.type === "ready") {
              state = State.WaitingForPong;
              pingId = crypto.randomUUID();
              socket.write(encode({ type: "ping", id: pingId, payload: {} }));
            } else if (
              state === State.WaitingForPong &&
              msg.type === "pong" &&
              msg.id === pingId
            ) {
              settled = true;
              clearTimeout(timeout);
              state = State.Connected;
              this.socket = socket;
              this.connected = true;
              resolve();
            } else if (state === State.Connected) {
              this.handleMessage(msg);
            }
          }
          // Decoder consumes processed data internally, reset our buffer
          buffer = Buffer.alloc(0);
        } catch (e) {
          cleanup(new Error(`Failed to parse message: ${e}`));
        }
      };

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        // State: WaitingForOK - parse text-based Firecracker handshake
        if (state === State.WaitingForOK) {
          const newlineIdx = buffer.indexOf(0x0a); // '\n'
          if (newlineIdx === -1) {
            return; // Wait for complete line
          }

          const line = buffer.subarray(0, newlineIdx).toString("utf-8");
          buffer = buffer.subarray(newlineIdx + 1);

          if (line.startsWith("OK ")) {
            state = State.WaitingForReady;
            // Process any remaining data (handles packet coalescing)
            if (buffer.length > 0) {
              processMessages();
            }
          } else {
            cleanup(new Error(`Firecracker connect failed: ${line}`));
          }
          return;
        }

        // State: WaitingForReady/WaitingForPong/Connected - parse length-prefixed messages
        processMessages();
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        this.connected = false;
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error(`Vsock error: ${err.message}`));
        }
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        this.connected = false;
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error("Vsock closed before ready"));
        }
        // Reject all pending requests
        const pending = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        for (const req of pending) {
          clearTimeout(req.timeout);
          req.reject(new Error("Connection closed"));
        }
      });
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
    // Use exec with base64 encoding to handle binary content
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
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const req of pending) {
      clearTimeout(req.timeout);
      req.reject(new Error("Connection closed"));
    }
  }
}
