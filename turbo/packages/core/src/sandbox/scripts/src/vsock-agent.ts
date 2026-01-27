/**
 * Vsock Agent for Firecracker VM host-guest communication (TypeScript version)
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
 *
 * For testing, supports Unix Domain Socket mode with --unix-socket option.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

const HEADER_SIZE = 4;
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16MB max

// Message types
const MSG_READY = 0x00;
const MSG_PING = 0x01;
const MSG_PONG = 0x02;
const MSG_EXEC = 0x03;
const MSG_EXEC_RESULT = 0x04;
const MSG_WRITE_FILE = 0x05;
const MSG_WRITE_FILE_RESULT = 0x06;
const MSG_ERROR = 0xff;

// Elapsed time tracking
const startTime = Date.now();

function log(level: string, msg: string): void {
  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const millis = elapsed % 1000;
  const timestamp = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  console.error(`[${timestamp}] [vsock-agent] [${level}] ${msg}`);
}

function encode(
  msgType: number,
  seq: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const body = Buffer.alloc(5 + payload.length);
  body.writeUInt8(msgType, 0);
  body.writeUInt32BE(seq, 1);
  payload.copy(body, 5);

  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);

  return Buffer.concat([header, body]);
}

function encodeError(seq: number, error: string): Buffer {
  const errorBytes = Buffer.from(error, "utf-8").subarray(0, 65535);
  const payload = Buffer.alloc(2 + errorBytes.length);
  payload.writeUInt16BE(errorBytes.length, 0);
  errorBytes.copy(payload, 2);
  return encode(MSG_ERROR, seq, payload);
}

function encodeExecResult(
  seq: number,
  exitCode: number,
  stdout: Buffer,
  stderr: Buffer,
): Buffer {
  const payload = Buffer.alloc(4 + 4 + stdout.length + 4 + stderr.length);
  let offset = 0;
  payload.writeInt32BE(exitCode, offset);
  offset += 4;
  payload.writeUInt32BE(stdout.length, offset);
  offset += 4;
  stdout.copy(payload, offset);
  offset += stdout.length;
  payload.writeUInt32BE(stderr.length, offset);
  offset += 4;
  stderr.copy(payload, offset);
  return encode(MSG_EXEC_RESULT, seq, payload);
}

function encodeWriteFileResult(
  seq: number,
  success: boolean,
  error: string = "",
): Buffer {
  const errorBytes = error
    ? Buffer.from(error, "utf-8").subarray(0, 65535)
    : Buffer.alloc(0);
  const payload = Buffer.alloc(1 + 2 + errorBytes.length);
  payload.writeUInt8(success ? 1 : 0, 0);
  payload.writeUInt16BE(errorBytes.length, 1);
  errorBytes.copy(payload, 3);
  return encode(MSG_WRITE_FILE_RESULT, seq, payload);
}

class Decoder {
  private buf: Buffer = Buffer.alloc(0);

  decode(data: Buffer): Array<{ type: number; seq: number; payload: Buffer }> {
    this.buf = Buffer.concat([this.buf, data]);
    const messages: Array<{ type: number; seq: number; payload: Buffer }> = [];

    while (this.buf.length >= HEADER_SIZE) {
      const length = this.buf.readUInt32BE(0);
      if (length > MAX_MESSAGE_SIZE) {
        throw new Error(`Message too large: ${length}`);
      }
      if (length < 5) {
        throw new Error(`Message too small: ${length}`);
      }
      const total = HEADER_SIZE + length;
      if (this.buf.length < total) {
        break;
      }
      const body = this.buf.subarray(HEADER_SIZE, total);
      const msgType = body.readUInt8(0);
      const seq = body.readUInt32BE(1);
      const payload = body.subarray(5);
      messages.push({ type: msgType, seq, payload });
      this.buf = this.buf.subarray(total);
    }
    return messages;
  }
}

async function handleExec(
  payload: Buffer,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  if (payload.length < 8) {
    return {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("Invalid exec payload"),
    };
  }

  const timeoutMs = payload.readUInt32BE(0);
  const cmdLen = payload.readUInt32BE(4);
  const command = payload.subarray(8, 8 + cmdLen).toString("utf-8");

  // Safe UTF-8 boundary for command preview
  let preview = command;
  if (command.length > 100) {
    let boundary = 100;
    for (const [i] of [...command].entries()) {
      if (i >= 100) break;
      boundary = i + 1;
    }
    preview = command.slice(0, boundary) + "...";
  }
  log("INFO", `exec: ${preview}`);

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let resolved = false;
    let killed = false;

    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        killed = true;
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("close", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);

      if (signal === "SIGKILL" && killed) {
        resolve({ exitCode: 124, stdout, stderr: Buffer.from("Timeout") });
      } else {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(err.message),
      });
    });
  });
}

async function handleWriteFile(
  payload: Buffer,
): Promise<{ success: boolean; error: string }> {
  if (payload.length < 3) {
    return { success: false, error: "Invalid write_file payload" };
  }

  const pathLen = payload.readUInt16BE(0);
  if (payload.length < 2 + pathLen + 1 + 4) {
    return { success: false, error: "Invalid write_file payload: too short" };
  }

  const filePath = payload.subarray(2, 2 + pathLen).toString("utf-8");
  const flags = payload.readUInt8(2 + pathLen);
  const contentLen = payload.readUInt32BE(3 + pathLen);

  if (payload.length < 7 + pathLen + contentLen) {
    return {
      success: false,
      error: "Invalid write_file payload: content truncated",
    };
  }

  const content = payload.subarray(7 + pathLen, 7 + pathLen + contentLen);
  const sudo = (flags & 0x01) !== 0;

  log(
    "INFO",
    `write_file: path=${filePath} size=${content.length} sudo=${sudo}`,
  );

  try {
    if (sudo) {
      // Use sudo tee to write directly
      return new Promise((resolve) => {
        const child = spawn("sudo", ["tee", filePath], {
          stdio: ["pipe", "ignore", "pipe"],
        });

        const stderrChunks: Buffer[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ success: false, error: "sudo tee timeout" });
        }, 30000);

        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString("utf-8");
            resolve({ success: false, error: `sudo tee failed: ${stderr}` });
          } else {
            resolve({ success: true, error: "" });
          }
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ success: false, error: err.message });
        });

        child.stdin.write(content);
        child.stdin.end();
      });
    } else {
      // Ensure parent directory exists
      const dirPath = path.dirname(filePath);
      if (dirPath) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, content);
      return { success: true, error: "" };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `write_file failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

async function handleMessage(
  msgType: number,
  seq: number,
  payload: Buffer,
): Promise<Buffer | null> {
  log(
    "INFO",
    `Received: type=0x${msgType.toString(16).padStart(2, "0")} seq=${seq}`,
  );

  switch (msgType) {
    case MSG_PING:
      return encode(MSG_PONG, seq);
    case MSG_EXEC: {
      const { exitCode, stdout, stderr } = await handleExec(payload);
      return encodeExecResult(seq, exitCode, stdout, stderr);
    }
    case MSG_WRITE_FILE: {
      const { success, error } = await handleWriteFile(payload);
      return encodeWriteFileResult(seq, success, error);
    }
    default:
      return encodeError(
        seq,
        `Unknown message type: 0x${msgType.toString(16).padStart(2, "0")}`,
      );
  }
}

function handleConnection(socket: net.Socket): void {
  const decoder = new Decoder();

  // Send ready signal
  socket.write(encode(MSG_READY, 0));
  log("INFO", "Sent ready signal");

  socket.on("data", (data: Buffer) => {
    (async () => {
      const messages = decoder.decode(data);
      for (const { type, seq, payload } of messages) {
        const resp = await handleMessage(type, seq, payload);
        if (resp) {
          socket.write(resp);
        }
      }
    })().catch((err: unknown) => {
      log(
        "ERROR",
        `Decode error: ${err instanceof Error ? err.message : String(err)}`,
      );
      socket.destroy();
    });
  });

  socket.on("close", () => {
    log("INFO", "Host disconnected");
  });

  socket.on("error", (err) => {
    log("ERROR", `Connection error: ${err.message}`);
  });
}

function connectUnixSocket(socketPath: string): void {
  log("INFO", `Connecting to Unix socket: ${socketPath}...`);

  const socket = net.createConnection(socketPath, () => {
    log("INFO", "Connected");
    handleConnection(socket);
  });

  socket.on("error", (err) => {
    log("ERROR", `Failed to connect: ${err.message}`);
    process.exit(1);
  });
}

function connectVsock(): void {
  // Node.js doesn't have native vsock support
  // For production use socat to bridge: socat UNIX-LISTEN:/tmp/vsock.sock VSOCK-CONNECT:2:1000
  log(
    "ERROR",
    "Direct vsock not supported in Node.js. Use --unix-socket or socat bridge.",
  );
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  let unixSocket: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--unix-socket" && args[i + 1]) {
      unixSocket = args[i + 1] ?? null;
      i++;
    }
  }

  log("INFO", "Starting vsock agent (TypeScript)...");

  if (unixSocket) {
    connectUnixSocket(unixSocket);
  } else {
    connectVsock();
  }
}

main();
