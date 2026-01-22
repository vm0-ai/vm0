/**
 * Vsock Agent - Guest-side communication daemon for Firecracker VMs
 *
 * This script runs inside the guest VM and handles communication with the host
 * via vsock (virtio-vsock). It provides:
 * - Ready signal to host when VM is ready for commands
 * - Command execution with stdout/stderr capture
 * - File read/write operations
 *
 * Design:
 * - Uses socat to bridge vsock to Unix socket (Node.js lacks native vsock support)
 * - Connects to host CID 2 on VSOCK_PORT to signal readiness
 * - Handles incoming requests and sends responses
 * - Runs as a systemd service for automatic restart on failure
 */
import * as fs from "fs";
import * as net from "net";
import { spawn, execSync, type SpawnOptions } from "child_process";
import * as crypto from "crypto";

/**
 * Vsock protocol constants (must match host-side constants)
 */
const VSOCK_PORT = 1000;
const HOST_CID = 2;
const HEADER_SIZE = 4;
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

/**
 * Message types for vsock communication
 */
type VsockMessageType =
  | "ready"
  | "exec"
  | "exec_result"
  | "write_file"
  | "write_ack"
  | "read_file"
  | "file_content"
  | "error";

interface VsockMessage<T = unknown> {
  type: VsockMessageType;
  id: string;
  payload: T;
}

interface ExecPayload {
  command: string;
  timeoutMs?: number;
  sudo?: boolean;
}

interface ExecResultPayload {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WriteFilePayload {
  path: string;
  content: string; // base64 encoded
  sudo?: boolean;
}

interface WriteAckPayload {
  path: string;
  success: boolean;
}

interface ReadFilePayload {
  path: string;
}

interface FileContentPayload {
  path: string;
  content: string; // base64 encoded
}

interface ErrorPayload {
  message: string;
  code?: string;
}

/**
 * Logger utility with timestamps
 */
function log(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

function logInfo(message: string): void {
  log("INFO", message);
}

function logError(message: string): void {
  log("ERROR", message);
}

function logDebug(message: string): void {
  if (process.env.VSOCK_DEBUG === "1") {
    log("DEBUG", message);
  }
}

/**
 * Encode a message for wire transmission
 * Format: [4 bytes length (big endian)] [JSON message]
 */
function encodeMessage<T>(message: VsockMessage<T>): Buffer {
  const jsonStr = JSON.stringify(message);
  const jsonBuffer = Buffer.from(jsonStr, "utf-8");

  if (jsonBuffer.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${jsonBuffer.length} bytes`);
  }

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(jsonBuffer.length, 0);

  return Buffer.concat([header, jsonBuffer]);
}

/**
 * Message decoder that buffers incoming data and extracts complete messages
 */
class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Add data to the buffer and return any complete messages
   */
  decode(data: Buffer): VsockMessage[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages: VsockMessage[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const messageLength = this.buffer.readUInt32BE(0);

      if (messageLength > MAX_MESSAGE_SIZE) {
        throw new Error(`Message too large: ${messageLength} bytes`);
      }

      const totalLength = HEADER_SIZE + messageLength;
      if (this.buffer.length < totalLength) {
        break; // Need more data
      }

      const jsonBuffer = this.buffer.slice(HEADER_SIZE, totalLength);
      const message = JSON.parse(jsonBuffer.toString("utf-8")) as VsockMessage;
      messages.push(message);

      this.buffer = this.buffer.slice(totalLength);
    }

    return messages;
  }
}

/**
 * Execute a command and return the result
 */
async function executeCommand(
  payload: ExecPayload,
): Promise<ExecResultPayload> {
  const { command, timeoutMs = 300000, sudo = false } = payload;

  logInfo(
    `Executing command: ${command.slice(0, 100)}${command.length > 100 ? "..." : ""}`,
  );

  return new Promise((resolve) => {
    const actualCommand = sudo ? `sudo ${command}` : command;
    const options: SpawnOptions = {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    };

    const proc = spawn(actualCommand, [], options);

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGKILL");
        resolve({
          exitCode: 124, // Timeout exit code (like timeout command)
          stdout,
          stderr: stderr + `\nCommand timed out after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
    }

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          exitCode: 1,
          stdout,
          stderr: `Spawn error: ${err.message}`,
        });
      }
    });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      }
    });
  });
}

/**
 * Write content to a file
 */
function writeFileContent(payload: WriteFilePayload): WriteAckPayload {
  const { path: filePath, content, sudo = false } = payload;

  logInfo(`Writing file: ${filePath}`);

  try {
    const decodedContent = Buffer.from(content, "base64");

    if (sudo) {
      // Write to temp file then move with sudo
      const tempPath = `/tmp/vsock-write-${crypto.randomUUID()}`;
      fs.writeFileSync(tempPath, decodedContent);
      execSync(`sudo mv '${tempPath}' '${filePath}'`, { stdio: "ignore" });
    } else {
      fs.writeFileSync(filePath, decodedContent);
    }

    return { path: filePath, success: true };
  } catch (error) {
    logError(`Failed to write file ${filePath}: ${error}`);
    return { path: filePath, success: false };
  }
}

/**
 * Read content from a file
 */
function readFileContent(
  payload: ReadFilePayload,
): FileContentPayload | ErrorPayload {
  const { path: filePath } = payload;

  logInfo(`Reading file: ${filePath}`);

  try {
    const content = fs.readFileSync(filePath);
    return {
      path: filePath,
      content: content.toString("base64"),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(`Failed to read file ${filePath}: ${errorMessage}`);
    return {
      message: `Failed to read file: ${errorMessage}`,
      code: "READ_ERROR",
    };
  }
}

/**
 * Handle incoming message and return response
 */
async function handleMessage(
  message: VsockMessage,
): Promise<VsockMessage | null> {
  logDebug(`Received message: type=${message.type}, id=${message.id}`);

  switch (message.type) {
    case "exec": {
      const result = await executeCommand(message.payload as ExecPayload);
      return {
        type: "exec_result",
        id: message.id,
        payload: result,
      };
    }

    case "write_file": {
      const result = writeFileContent(message.payload as WriteFilePayload);
      return {
        type: "write_ack",
        id: message.id,
        payload: result,
      };
    }

    case "read_file": {
      const result = readFileContent(message.payload as ReadFilePayload);
      const isError = "message" in result;
      return {
        type: isError ? "error" : "file_content",
        id: message.id,
        payload: result,
      };
    }

    default:
      logError(`Unknown message type: ${message.type}`);
      return {
        type: "error",
        id: message.id,
        payload: {
          message: `Unknown message type: ${message.type}`,
          code: "UNKNOWN_TYPE",
        },
      };
  }
}

/**
 * Start socat to bridge vsock to Unix socket
 * Returns the path to the Unix socket
 */
function startSocatBridge(): string {
  const socketPath = `/tmp/vsock-bridge-${process.pid}.sock`;

  // Clean up any existing socket
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  // Start socat in background
  // vsock-connect:CID:PORT connects to host (CID 2) on specified port
  const socatProc = spawn(
    "socat",
    [
      `UNIX-LISTEN:${socketPath},fork`,
      `VSOCK-CONNECT:${HOST_CID}:${VSOCK_PORT}`,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    },
  );

  socatProc.unref();

  socatProc.on("error", (err) => {
    logError(`Socat error: ${err.message}`);
  });

  if (socatProc.stderr) {
    socatProc.stderr.on("data", (data: Buffer) => {
      logError(`Socat stderr: ${data.toString()}`);
    });
  }

  // Wait a bit for socat to start
  logInfo(`Started socat bridge on ${socketPath}`);
  return socketPath;
}

/**
 * Connect to host via vsock bridge and handle communication
 */
async function connectToHost(): Promise<void> {
  logInfo(`Connecting to host CID ${HOST_CID} port ${VSOCK_PORT}...`);

  // Start socat bridge
  const socketPath = startSocatBridge();

  // Wait for socket to be created
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(socketPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!fs.existsSync(socketPath)) {
    throw new Error(`Socat socket not created at ${socketPath}`);
  }

  // Connect to the Unix socket
  const socket = net.createConnection(socketPath);
  const decoder = new MessageDecoder();

  socket.on("connect", () => {
    logInfo("Connected to host via vsock bridge");

    // Send ready signal
    const readyMessage: VsockMessage = {
      type: "ready",
      id: crypto.randomUUID(),
      payload: {},
    };
    socket.write(encodeMessage(readyMessage));
    logInfo("Sent ready signal to host");
  });

  socket.on("data", (data: Buffer) => {
    const processData = async (): Promise<void> => {
      try {
        const messages = decoder.decode(data);

        for (const message of messages) {
          const response = await handleMessage(message);
          if (response) {
            socket.write(encodeMessage(response));
          }
        }
      } catch (error) {
        logError(`Error processing data: ${error}`);
      }
    };

    processData().catch((err) => logError(`Unhandled error: ${err}`));
  });

  socket.on("error", (err) => {
    logError(`Socket error: ${err.message}`);
  });

  socket.on("close", () => {
    logInfo("Connection closed by host");
    // Clean up socket file
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  });
}

/**
 * Load virtio-vsock kernel module if needed
 */
function ensureVsockModule(): void {
  logInfo("Checking virtio-vsock kernel module...");
  try {
    execSync("modprobe virtio-vsock 2>/dev/null || true", { stdio: "ignore" });
    logInfo("virtio-vsock module loaded");
  } catch {
    logInfo("virtio-vsock module already loaded or not needed");
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logInfo("VM0 Vsock Agent starting...");

  // Ensure virtio-vsock module is loaded
  ensureVsockModule();

  // Connect to host and handle communication
  try {
    await connectToHost();
  } catch (error) {
    logError(`Failed to connect to host: ${error}`);
    process.exit(1);
  }

  // Keep the process running
  // The socket connection will handle all communication
  process.on("SIGTERM", () => {
    logInfo("Received SIGTERM, shutting down...");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logInfo("Received SIGINT, shutting down...");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
