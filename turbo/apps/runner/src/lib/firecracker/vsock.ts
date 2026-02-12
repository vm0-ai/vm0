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
 *   0x03 exec           H→G  [4-byte timeout_ms][1-byte flags][4-byte cmd_len][command]([4-byte env_count]([4-byte key_len][key][4-byte val_len][value])*)
 *   0x04 exec_result    G→H  [4-byte exit_code][4-byte stdout_len][stdout][4-byte stderr_len][stderr]
 *   0x05 write_file     H→G  [2-byte path_len][path][1-byte flags][4-byte content_len][content]
 *   0x06 write_file_result G→H [1-byte success][2-byte error_len][error]
 *   0x07 spawn_watch    H→G  [4-byte timeout_ms][1-byte flags][4-byte cmd_len][command]([4-byte env_count]([4-byte key_len][key][4-byte val_len][value])*)
 *   0x08 spawn_watch_result G→H [4-byte pid]
 *   0x09 process_exit   G→H  [4-byte pid][4-byte exit_code][4-byte stdout_len][stdout][4-byte stderr_len][stderr]
 *   0x0A shutdown       H→G  (empty)
 *   0x0B shutdown_ack   G→H  (empty)
 *   0xFF error          G→H  [2-byte error_len][error]
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type {
  EnvVars,
  ExecResult,
  GuestClient,
  SpawnResult,
  ProcessExitEvent,
} from "./guest.js";

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
const MSG_SPAWN_WATCH = 0x07;
const MSG_SPAWN_WATCH_RESULT = 0x08;
const MSG_PROCESS_EXIT = 0x09;
const MSG_SHUTDOWN = 0x0a;
const MSG_SHUTDOWN_ACK = 0x0b;
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

interface PendingExit {
  resolve: (event: ProcessExitEvent) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
}

// Buffer for exit events that arrive before waitForExit is called
interface CachedExitEvent {
  event: ProcessExitEvent;
  timestamp: number;
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
 * Encode exec message payload.
 *
 * The optional env section is only appended when env has entries,
 * keeping the payload backward-compatible with old decoders.
 */
function encodeExecPayload(
  command: string,
  timeoutMs: number,
  env?: EnvVars,
  sudo: boolean = false,
): Buffer {
  const cmdBuf = Buffer.from(command, "utf-8");
  const envEntries = env ? Object.entries(env) : [];

  // Calculate env section size
  let envSize = 0;
  const encodedEntries: Array<[Buffer, Buffer]> = [];
  if (envEntries.length > 0) {
    envSize = 4; // env_count
    for (const [key, val] of envEntries) {
      const keyBuf = Buffer.from(key, "utf-8");
      const valBuf = Buffer.from(val, "utf-8");
      envSize += 4 + keyBuf.length + 4 + valBuf.length;
      encodedEntries.push([keyBuf, valBuf]);
    }
  }

  const payload = Buffer.alloc(9 + cmdBuf.length + envSize);
  payload.writeUInt32BE(timeoutMs, 0);
  payload.writeUInt8(sudo ? FLAG_SUDO : 0, 4);
  payload.writeUInt32BE(cmdBuf.length, 5);
  cmdBuf.copy(payload, 9);

  if (encodedEntries.length > 0) {
    let offset = 9 + cmdBuf.length;
    payload.writeUInt32BE(encodedEntries.length, offset);
    offset += 4;
    for (const [keyBuf, valBuf] of encodedEntries) {
      payload.writeUInt32BE(keyBuf.length, offset);
      offset += 4;
      keyBuf.copy(payload, offset);
      offset += keyBuf.length;
      payload.writeUInt32BE(valBuf.length, offset);
      offset += 4;
      valBuf.copy(payload, offset);
      offset += valBuf.length;
    }
  }

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
  // Minimum: exit_code(4) + stdout_len(4) + stderr_len(4) = 12 bytes
  if (payload.length < 12) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Invalid exec_result payload: too short",
    };
  }

  const exitCode = payload.readInt32BE(0);
  const stdoutLen = payload.readUInt32BE(4);

  // Validate stdout bounds
  const stderrLenOffset = 8 + stdoutLen;
  if (payload.length < stderrLenOffset + 4) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Invalid exec_result payload: stdout truncated",
    };
  }

  const stdout = payload.subarray(8, 8 + stdoutLen).toString("utf-8");
  const stderrLen = payload.readUInt32BE(stderrLenOffset);

  // Validate stderr bounds
  const expectedLen = stderrLenOffset + 4 + stderrLen;
  if (payload.length < expectedLen) {
    return {
      exitCode: 1,
      stdout,
      stderr: "Invalid exec_result payload: stderr truncated",
    };
  }

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
  // Minimum: success(1) + error_len(2) = 3 bytes
  if (payload.length < 3) {
    return {
      success: false,
      error: "Invalid write_file_result payload: too short",
    };
  }

  const success = payload.readUInt8(0) === 1;
  const errorLen = payload.readUInt16BE(1);

  // Validate error string bounds
  if (payload.length < 3 + errorLen) {
    return {
      success: false,
      error: "Invalid write_file_result payload: error truncated",
    };
  }

  const error = payload.subarray(3, 3 + errorLen).toString("utf-8");

  return { success, error };
}

/**
 * Decode error payload
 */
function decodeError(payload: Buffer): string {
  if (payload.length < 2) {
    return "Invalid error payload: too short";
  }
  const errorLen = payload.readUInt16BE(0);
  if (payload.length < 2 + errorLen) {
    return "Invalid error payload: message truncated";
  }
  return payload.subarray(2, 2 + errorLen).toString("utf-8");
}

/**
 * Decode spawn_watch_result payload
 */
function decodeSpawnWatchResult(payload: Buffer): SpawnResult {
  if (payload.length < 4) {
    throw new Error("Invalid spawn_watch_result payload");
  }
  return { pid: payload.readUInt32BE(0) };
}

/**
 * Decode process_exit payload (unsolicited notification)
 */
function decodeProcessExit(payload: Buffer): ProcessExitEvent {
  // Minimum: pid(4) + exit_code(4) + stdout_len(4) + stderr_len(4) = 16 bytes
  if (payload.length < 16) {
    throw new Error("Invalid process_exit payload: too short");
  }

  const pid = payload.readUInt32BE(0);
  const exitCode = payload.readInt32BE(4);
  const stdoutLen = payload.readUInt32BE(8);

  // Validate stdout bounds
  const stderrLenOffset = 12 + stdoutLen;
  if (payload.length < stderrLenOffset + 4) {
    throw new Error("Invalid process_exit payload: stdout truncated");
  }

  const stdout = payload.subarray(12, 12 + stdoutLen).toString("utf-8");
  const stderrLen = payload.readUInt32BE(stderrLenOffset);

  // Validate stderr bounds
  const expectedLen = stderrLenOffset + 4 + stderrLen;
  if (payload.length < expectedLen) {
    throw new Error("Invalid process_exit payload: stderr truncated");
  }

  const stderr = payload
    .subarray(stderrLenOffset + 4, stderrLenOffset + 4 + stderrLen)
    .toString("utf-8");

  return { pid, exitCode, stdout, stderr };
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
  private pendingExits = new Map<number, PendingExit>();
  // Cache for exit events that arrive before waitForExit is called
  private cachedExits = new Map<number, CachedExitEvent>();

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
    // Handle unsolicited process_exit notifications (seq=0)
    if (msg.type === MSG_PROCESS_EXIT && msg.seq === 0) {
      const event = decodeProcessExit(msg.payload);
      const pending = this.pendingExits.get(event.pid);
      if (pending) {
        // waitForExit was already called, resolve it
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pendingExits.delete(event.pid);
        pending.resolve(event);
      } else if (!this.cachedExits.has(event.pid)) {
        // waitForExit not called yet, cache the event for later
        // Only cache if not already cached (ignore duplicate exit events)
        this.cachedExits.set(event.pid, {
          event,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Handle regular request/response
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
  async exec(
    command: string,
    timeoutMs?: number,
    env?: EnvVars,
    sudo: boolean = false,
  ): Promise<ExecResult> {
    const actualTimeout = timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    try {
      const payload = encodeExecPayload(command, actualTimeout, env, sudo);
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
   * Execute a command as root via the sudo protocol flag.
   */
  async execAsRoot(command: string, timeoutMs?: number): Promise<ExecResult> {
    return this.exec(command, timeoutMs, undefined, true);
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
   * 2. Guest boots and vsock-guest connects to CID=2, port
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
                // Handle message errors gracefully - don't crash the connection
                try {
                  this.handleMessage(msg);
                } catch (msgErr) {
                  // Log but don't crash - one bad message shouldn't kill connection
                  console.error(`[vsock] Error handling message: ${msgErr}`);
                }
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

          // Clean up pending requests
          const pendingReqs = Array.from(this.pendingRequests.values());
          this.pendingRequests.clear();
          for (const req of pendingReqs) {
            clearTimeout(req.timeout);
            req.reject(new Error("Connection closed"));
          }

          // Clean up pending exits
          const pendingExits = Array.from(this.pendingExits.values());
          this.pendingExits.clear();
          for (const exit of pendingExits) {
            if (exit.timeout) clearTimeout(exit.timeout);
            exit.reject(new Error("Connection closed"));
          }

          // Clean up cached exits
          this.cachedExits.clear();
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
   * Spawn a process and monitor for exit (event-driven mode)
   *
   * Returns immediately with the PID. Use waitForExit() to wait for completion.
   * When the process exits, the agent sends an unsolicited notification.
   */
  async spawnAndWatch(
    command: string,
    timeoutMs: number = 0,
    env?: EnvVars,
    sudo: boolean = false,
  ): Promise<SpawnResult> {
    const payload = encodeExecPayload(command, timeoutMs, env, sudo);
    const response = await this.request(
      MSG_SPAWN_WATCH,
      payload,
      30000, // 30s timeout for spawn acknowledgment
    );

    if (response.type === MSG_ERROR) {
      throw new Error(`spawnAndWatch failed: ${decodeError(response.payload)}`);
    }

    if (response.type !== MSG_SPAWN_WATCH_RESULT) {
      throw new Error(
        `Unexpected response type: 0x${response.type.toString(16)}`,
      );
    }

    return decodeSpawnWatchResult(response.payload);
  }

  /**
   * Wait for a spawned process to exit
   *
   * Blocks until the process exits or timeout is reached.
   * The exit event is pushed by the guest agent (no polling).
   */
  async waitForExit(
    pid: number,
    timeoutMs: number = 0,
  ): Promise<ProcessExitEvent> {
    // Check connection state first
    if (!this.connected || !this.socket) {
      throw new Error("Not connected - cannot wait for process exit");
    }

    // Check if already waiting for this PID
    if (this.pendingExits.has(pid)) {
      throw new Error(`Already waiting for process ${pid} to exit`);
    }

    // Check if exit event was already received (cached)
    const cached = this.cachedExits.get(pid);
    if (cached) {
      this.cachedExits.delete(pid);
      return cached.event;
    }

    return new Promise((resolve, reject) => {
      const pending: PendingExit = { resolve, reject };

      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pendingExits.delete(pid);
          reject(new Error(`Timeout waiting for process ${pid} to exit`));
        }, timeoutMs);
      }

      this.pendingExits.set(pid, pending);
    });
  }

  /**
   * Get the vsock path (for logging/debugging)
   */
  getVsockPath(): string {
    return this.vsockPath;
  }

  /**
   * Request graceful shutdown from guest
   *
   * Sends shutdown command to guest agent, which syncs filesystems
   * and returns acknowledgment. Falls back gracefully on timeout.
   *
   * @param timeoutMs Maximum time to wait for acknowledgment (default: 2000ms)
   * @returns true if guest acknowledged, false on timeout/error
   */
  async shutdown(timeoutMs: number = 2000): Promise<boolean> {
    if (!this.connected || !this.socket) {
      return false;
    }

    try {
      const response = await this.request(
        MSG_SHUTDOWN,
        Buffer.alloc(0),
        timeoutMs,
      );
      return response.type === MSG_SHUTDOWN_ACK;
    } catch {
      return false;
    }
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

    // Clean up pending requests
    const pendingRequests = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const req of pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error("Connection closed"));
    }

    // Clean up pending exits
    const pendingExits = Array.from(this.pendingExits.values());
    this.pendingExits.clear();
    for (const exit of pendingExits) {
      if (exit.timeout) clearTimeout(exit.timeout);
      exit.reject(new Error("Connection closed"));
    }

    // Clean up cached exits
    this.cachedExits.clear();
  }

  /**
   * Send raw bytes directly to the socket (for testing only)
   *
   * This allows tests to send malformed messages to verify the agent's
   * protocol error handling (e.g., oversized messages).
   *
   * @internal This method is only for testing purposes
   */
  sendRawForTesting(data: Buffer): void {
    if (!this.connected || !this.socket) {
      throw new Error("Not connected - call waitForGuestConnection() first");
    }
    this.socket.write(data);
  }
}
