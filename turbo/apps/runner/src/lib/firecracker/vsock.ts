/**
 * Vsock Client for Firecracker VMs
 *
 * Provides host-side communication with guest via virtio-vsock.
 *
 * Guest-initiated connection (zero-latency mode):
 * - Host listens on "{vsockPath}_{port}" UDS
 * - Guest connects to Host (CID=2) when ready
 * - Firecracker forwards connection to Host's listener
 * - No polling needed - instant notification when guest is ready
 *
 * Protocol: length-prefixed JSON
 * - 4-byte length prefix (big endian) + JSON message
 * - Message types: ready, ping, pong, exec, exec_result, error
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { ExecResult, GuestClient } from "./guest.js";

const VSOCK_PORT = 1000;
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
    if (!this.connected || !this.socket) {
      throw new Error("Not connected - call waitForGuestConnection() first");
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
   * Wait for guest to connect (Guest-initiated mode)
   *
   * Instead of polling, this listens on "{vsockPath}_{port}" and waits
   * for the guest to actively connect. This provides zero-latency
   * notification when the guest is ready.
   *
   * Flow:
   * 1. Host creates UDS server at "{vsockPath}_{port}"
   * 2. Guest boots and vsock-agent connects to CID=2, port
   * 3. Firecracker forwards connection to Host's UDS
   * 4. Host accepts, receives "ready", sends ping/pong
   */
  async waitForGuestConnection(timeoutMs: number = 30000): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }

    const listenerPath = `${this.vsockPath}_${VSOCK_PORT}`;

    // Clean up stale socket file if exists
    if (fs.existsSync(listenerPath)) {
      fs.unlinkSync(listenerPath);
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer();
      const decoder = new Decoder();
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          server.close();
          if (fs.existsSync(listenerPath)) {
            fs.unlinkSync(listenerPath);
          }
          reject(new Error(`Guest connection timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      const cleanup = (err: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          if (fs.existsSync(listenerPath)) {
            fs.unlinkSync(listenerPath);
          }
          reject(err);
        }
      };

      server.on("error", (err) => {
        cleanup(new Error(`Server error: ${err.message}`));
      });

      server.on("connection", (socket) => {
        // Only accept first connection
        server.close();

        // Connection state machine
        const enum State {
          WaitingForReady,
          WaitingForPong,
          Connected,
        }
        let state = State.WaitingForReady;
        let pingId: string | null = null;

        socket.on("data", (data: Buffer) => {
          try {
            for (const msg of decoder.decode(data)) {
              if (state === State.WaitingForReady && msg.type === "ready") {
                state = State.WaitingForPong;
                pingId = crypto.randomUUID();
                socket.write(encode({ type: "ping", id: pingId, payload: {} }));
              } else if (
                state === State.WaitingForPong &&
                msg.type === "pong" &&
                msg.id === pingId
              ) {
                if (settled) {
                  // Timeout already fired, discard this connection
                  socket.destroy();
                  return;
                }
                settled = true;
                clearTimeout(timeout);
                if (fs.existsSync(listenerPath)) {
                  fs.unlinkSync(listenerPath);
                }
                state = State.Connected;
                this.socket = socket;
                this.connected = true;
                resolve();
              } else if (state === State.Connected) {
                this.handleMessage(msg);
              }
            }
          } catch (e) {
            cleanup(new Error(`Failed to parse message: ${e}`));
          }
        });

        socket.on("error", (err) => {
          cleanup(new Error(`Socket error: ${err.message}`));
        });

        socket.on("close", () => {
          if (!settled) {
            cleanup(new Error("Guest disconnected before ready"));
          }
          this.connected = false;
          this.socket = null;
          const pending = Array.from(this.pendingRequests.values());
          this.pendingRequests.clear();
          for (const req of pending) {
            clearTimeout(req.timeout);
            req.reject(new Error("Connection closed"));
          }
        });
      });

      server.listen(listenerPath, () => {
        // Server is ready, waiting for guest connection
      });
    });
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
