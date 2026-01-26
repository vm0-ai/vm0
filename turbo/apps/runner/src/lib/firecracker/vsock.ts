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
 * Binary Protocol:
 *   [4-byte length][1-byte type][4-byte seq][payload]
 *
 *   - length: size of (type + seq + payload), big-endian
 *   - type: message type
 *   - seq: sequence number for request/response matching, big-endian
 *   - payload: type-specific binary data
 *
 * Message Types:
 *   0x00 ready          G→H  (empty)
 *   0x01 ping           H→G  (empty)
 *   0x02 pong           G→H  (empty)
 *   0x03 exec           H→G  [4-byte timeout_ms][4-byte cmd_len][command]
 *   0x04 exec_result    G→H  [4-byte exit_code][4-byte stdout_len][stdout][4-byte stderr_len][stderr]
 *   0x05 write_file     H→G  [2-byte path_len][path][1-byte flags][4-byte content_len][content]
 *   0x06 write_file_result G→H [1-byte success][2-byte error_len][error]
 *   0xFF error          G→H  [2-byte error_len][error]
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type { ExecResult, GuestClient } from "./guest.js";

const VSOCK_PORT = 1000;
const HEADER_SIZE = 4;
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16MB max
const DEFAULT_EXEC_TIMEOUT_MS = 300000; // 5 minutes

// Message types (see protocol docs in header)
const MSG_READY = 0x00;
const MSG_PING = 0x01;
const MSG_PONG = 0x02;
const MSG_EXEC = 0x03;
const MSG_WRITE_FILE = 0x05;
const MSG_ERROR = 0xff;

// Write file flags
const FLAG_SUDO = 0x01;

interface DecodedMessage {
  type: number;
  seq: number;
  payload: Buffer;
}

interface PendingRequest {
  resolve: (msg: DecodedMessage) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Encode a message with binary protocol
 */
function encode(
  type: number,
  seq: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const body = Buffer.alloc(5 + payload.length);
  body.writeUInt8(type, 0);
  body.writeUInt32BE(seq, 1);
  payload.copy(body, 5);

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(body.length, 0);

  return Buffer.concat([header, body]);
}

/**
 * Encode exec message payload
 */
function encodeExecPayload(command: string, timeoutMs: number): Buffer {
  const cmdBuf = Buffer.from(command, "utf-8");
  const payload = Buffer.alloc(8 + cmdBuf.length);
  payload.writeUInt32BE(timeoutMs, 0);
  payload.writeUInt32BE(cmdBuf.length, 4);
  cmdBuf.copy(payload, 8);
  return payload;
}

/**
 * Encode write_file message payload
 */
function encodeWriteFilePayload(
  path: string,
  content: Buffer,
  sudo: boolean,
): Buffer {
  const pathBuf = Buffer.from(path, "utf-8");
  if (pathBuf.length > 65535) {
    throw new Error(`Path too long: ${pathBuf.length} bytes (max 65535)`);
  }
  const payload = Buffer.alloc(2 + pathBuf.length + 1 + 4 + content.length);
  let offset = 0;

  payload.writeUInt16BE(pathBuf.length, offset);
  offset += 2;

  pathBuf.copy(payload, offset);
  offset += pathBuf.length;

  payload.writeUInt8(sudo ? FLAG_SUDO : 0, offset);
  offset += 1;

  payload.writeUInt32BE(content.length, offset);
  offset += 4;

  content.copy(payload, offset);

  return payload;
}

/**
 * Decode exec_result payload
 */
function decodeExecResult(payload: Buffer): ExecResult {
  if (payload.length < 8) {
    return { exitCode: 1, stdout: "", stderr: "Invalid exec_result payload" };
  }

  const exitCode = payload.readInt32BE(0);
  const stdoutLen = payload.readUInt32BE(4);
  const stdout = payload.subarray(8, 8 + stdoutLen).toString("utf-8");
  const stderrLenOffset = 8 + stdoutLen;
  const stderrLen = payload.readUInt32BE(stderrLenOffset);
  const stderr = payload
    .subarray(stderrLenOffset + 4, stderrLenOffset + 4 + stderrLen)
    .toString("utf-8");

  return { exitCode, stdout, stderr };
}

/**
 * Decode write_file_result payload
 */
function decodeWriteFileResult(payload: Buffer): {
  success: boolean;
  error: string;
} {
  if (payload.length < 3) {
    return { success: false, error: "Invalid write_file_result payload" };
  }

  const success = payload.readUInt8(0) === 1;
  const errorLen = payload.readUInt16BE(1);
  const error = payload.subarray(3, 3 + errorLen).toString("utf-8");

  return { success, error };
}

/**
 * Decode error payload
 */
function decodeError(payload: Buffer): string {
  if (payload.length < 2) {
    return "Invalid error payload";
  }
  const errorLen = payload.readUInt16BE(0);
  return payload.subarray(2, 2 + errorLen).toString("utf-8");
}

/**
 * Message decoder with buffering
 */
class Decoder {
  private buf = Buffer.alloc(0);

  decode(data: Buffer): DecodedMessage[] {
    this.buf = Buffer.concat([this.buf, data]);
    const messages: DecodedMessage[] = [];

    while (this.buf.length >= HEADER_SIZE) {
      const length = this.buf.readUInt32BE(0);
      if (length > MAX_MESSAGE_SIZE) {
        throw new Error(`Message too large: ${length}`);
      }
      if (length < 5) {
        throw new Error(`Message too small: ${length}`);
      }

      const total = HEADER_SIZE + length;
      if (this.buf.length < total) break;

      const body = this.buf.subarray(HEADER_SIZE, total);
      const type = body.readUInt8(0);
      const seq = body.readUInt32BE(1);
      const payload = body.subarray(5);

      messages.push({ type, seq, payload });
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
  private nextSeq = 1;
  private pendingRequests = new Map<number, PendingRequest>();

  constructor(vsockPath: string) {
    this.vsockPath = vsockPath;
  }

  /**
   * Get next sequence number
   */
  private getNextSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffffffff;
    if (this.nextSeq === 0) this.nextSeq = 1; // Skip 0
    return seq;
  }

  /**
   * Handle incoming message and route to pending request
   */
  private handleMessage(msg: DecodedMessage): void {
    const pending = this.pendingRequests.get(msg.seq);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.seq);
      pending.resolve(msg);
    }
  }

  /**
   * Send a request and wait for response
   */
  private async request(
    type: number,
    payload: Buffer,
    timeoutMs: number,
  ): Promise<DecodedMessage> {
    if (!this.connected || !this.socket) {
      throw new Error("Not connected - call waitForGuestConnection() first");
    }

    const seq = this.getNextSeq();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(seq);
        reject(new Error(`Request timeout: type=0x${type.toString(16)}`));
      }, timeoutMs);

      this.pendingRequests.set(seq, { resolve, reject, timeout });

      this.socket!.write(encode(type, seq, payload));
    });
  }

  /**
   * Execute a command on the remote VM
   */
  async exec(command: string, timeoutMs?: number): Promise<ExecResult> {
    const actualTimeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    try {
      const payload = encodeExecPayload(command, actualTimeout);
      const response = await this.request(
        MSG_EXEC,
        payload,
        actualTimeout + 5000, // Add buffer for network latency
      );

      if (response.type === MSG_ERROR) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: decodeError(response.payload),
        };
      }

      return decodeExecResult(response.payload);
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
  private async writeFileInternal(
    remotePath: string,
    content: string,
    sudo: boolean,
  ): Promise<void> {
    const contentBuf = Buffer.from(content, "utf-8");
    if (contentBuf.length > MAX_MESSAGE_SIZE - 1024) {
      throw new Error(
        `Content too large: ${contentBuf.length} bytes (max ${MAX_MESSAGE_SIZE - 1024})`,
      );
    }
    const payload = encodeWriteFilePayload(remotePath, contentBuf, sudo);
    const response = await this.request(
      MSG_WRITE_FILE,
      payload,
      DEFAULT_EXEC_TIMEOUT_MS,
    );

    if (response.type === MSG_ERROR) {
      throw new Error(`Write file failed: ${decodeError(response.payload)}`);
    }

    const result = decodeWriteFileResult(response.payload);
    if (!result.success) {
      throw new Error(`Write file failed: ${result.error}`);
    }
  }

  /**
   * Write content to a file on the remote VM
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    return this.writeFileInternal(remotePath, content, false);
  }

  /**
   * Write content to a file on the remote VM using sudo
   */
  async writeFileWithSudo(remotePath: string, content: string): Promise<void> {
    return this.writeFileInternal(remotePath, content, true);
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
        let pingSeq = 0;

        socket.on("data", (data: Buffer) => {
          try {
            for (const msg of decoder.decode(data)) {
              if (state === State.WaitingForReady && msg.type === MSG_READY) {
                state = State.WaitingForPong;
                pingSeq = this.getNextSeq();
                socket.write(encode(MSG_PING, pingSeq));
              } else if (
                state === State.WaitingForPong &&
                msg.type === MSG_PONG &&
                msg.seq === pingSeq
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
