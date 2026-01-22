/**
 * Vsock Agent - Guest-side communication daemon for Firecracker VMs
 *
 * Handles host-guest communication via vsock (virtio-vsock):
 * - Sends "ready" signal when host connects
 * - Handles ping/pong for connection testing
 * - Executes commands and returns results
 *
 * Protocol: 4-byte length prefix (big endian) + JSON message
 * Uses socat to bridge vsock to Unix socket (Node.js lacks native vsock support)
 */

import * as net from "net";
import * as fs from "fs";
import { spawn } from "child_process";
import * as crypto from "crypto";

// Constants
const VSOCK_PORT = 1000;
const HEADER_SIZE = 4;
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

// Message types
type MessageType = "ready" | "ping" | "pong" | "exec" | "exec_result" | "error";

interface Message<T = unknown> {
  type: MessageType;
  id: string;
  payload: T;
}

interface ExecPayload {
  command: string;
  timeoutMs?: number;
}

interface ExecResultPayload {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Logging
function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [vsock-agent] [${level}] ${msg}`);
}

// Encode message with length prefix
function encode<T>(msg: Message<T>): Buffer {
  const json = Buffer.from(JSON.stringify(msg), "utf-8");
  if (json.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${json.length}`);
  }
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

// Execute command
async function execCommand(payload: ExecPayload): Promise<ExecResultPayload> {
  const { command, timeoutMs = 30000 } = payload;
  log(
    "INFO",
    `Executing: ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}`,
  );

  return new Promise((resolve) => {
    const proc = spawn(command, [], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill("SIGKILL");
        resolve({ exitCode: 124, stdout, stderr: stderr + "\nTimeout" });
      }
    }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });

    proc.on("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve({ exitCode: 1, stdout, stderr: `Error: ${err.message}` });
      }
    });
  });
}

// Handle incoming message
async function handle(msg: Message): Promise<Message | null> {
  log("INFO", `Received: type=${msg.type} id=${msg.id}`);

  switch (msg.type) {
    case "ping":
      return { type: "pong", id: msg.id, payload: {} };

    case "exec": {
      const result = await execCommand(msg.payload as ExecPayload);
      return { type: "exec_result", id: msg.id, payload: result };
    }

    default:
      return {
        type: "error",
        id: msg.id,
        payload: { message: `Unknown type: ${msg.type}` },
      };
  }
}

// Start server
async function main(): Promise<void> {
  log("INFO", "Starting vsock agent...");

  const socketPath = `/tmp/vsock-agent-${process.pid}.sock`;
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  const server = net.createServer((socket) => {
    log("INFO", "Host connected");
    const decoder = new Decoder();

    // Send ready signal
    const ready: Message = {
      type: "ready",
      id: crypto.randomUUID(),
      payload: {},
    };
    socket.write(encode(ready));
    log("INFO", "Sent ready signal");

    socket.on("data", (data: Buffer) => {
      (async () => {
        for (const msg of decoder.decode(data)) {
          const resp = await handle(msg);
          if (resp) socket.write(encode(resp));
        }
      })().catch((e) => log("ERROR", `Handler error: ${e}`));
    });

    socket.on("error", (e) => log("ERROR", `Socket error: ${e.message}`));
    socket.on("close", () => log("INFO", "Host disconnected"));
  });

  server.listen(socketPath, () => {
    log("INFO", `Listening on ${socketPath}`);

    // Start socat to bridge vsock to Unix socket
    const socat = spawn(
      "socat",
      [
        `VSOCK-LISTEN:${VSOCK_PORT},reuseaddr,fork`,
        `UNIX-CONNECT:${socketPath}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    socat.stdout?.on("data", (d: Buffer) =>
      log("INFO", `socat: ${d.toString().trim()}`),
    );
    socat.stderr?.on("data", (d: Buffer) =>
      log("INFO", `socat: ${d.toString().trim()}`),
    );
    socat.on("error", (e) => log("ERROR", `socat error: ${e.message}`));
    socat.on("exit", (code) => log("ERROR", `socat exited: ${code}`));

    log("INFO", `socat listening on vsock port ${VSOCK_PORT}`);
  });

  server.on("error", (e) => log("ERROR", `Server error: ${e.message}`));

  // Handle signals
  process.on("SIGTERM", () => {
    log("INFO", "SIGTERM");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("INFO", "SIGINT");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
