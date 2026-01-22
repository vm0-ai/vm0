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
 * - Listens on VSOCK_PORT for host connections (Firecracker creates vsock.sock_PORT on host)
 * - Sends ready signal when host connects, then handles requests
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
 * Start a Unix socket server to handle connections forwarded from socat
 *
 * Flow:
 * 1. Create Unix socket server
 * 2. Start socat to listen on vsock and forward to our Unix socket
 * 3. When host connects to vsock.sock_1000, socat accepts and connects to our Unix socket
 * 4. We handle the connection and send ready signal
 */
async function startVsockServer(): Promise<void> {
  logInfo(`Starting vsock agent server...`);

  const socketPath = `/tmp/vsock-bridge-${process.pid}.sock`;

  // Clean up any existing socket
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  // Create Unix socket server
  const server = net.createServer((socket) => {
    logInfo("Host connected via vsock");
    const decoder = new MessageDecoder();

    // Send ready signal immediately upon connection
    const readyMessage: VsockMessage = {
      type: "ready",
      id: crypto.randomUUID(),
      payload: {},
    };
    socket.write(encodeMessage(readyMessage));
    logInfo("Sent ready signal to host");

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
      logInfo("Host disconnected");
    });
  });

  // Start listening on Unix socket
  server.listen(socketPath, () => {
    logInfo(`Unix socket server listening on ${socketPath}`);

    // Start socat to bridge vsock to our Unix socket
    // VSOCK-LISTEN:PORT listens for vsock connections from host
    // UNIX-CONNECT:path forwards the connection to our Unix socket server
    const socatArgs = [
      "-d",
      "-d",
      `VSOCK-LISTEN:${VSOCK_PORT},reuseaddr,fork`,
      `UNIX-CONNECT:${socketPath}`,
    ];
    logInfo(`Starting socat: socat ${socatArgs.join(" ")}`);

    const socatProc = spawn("socat", socatArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stdout for debugging
    if (socatProc.stdout) {
      socatProc.stdout.on("data", (data: Buffer) => {
        logInfo(`socat: ${data.toString().trim()}`);
      });
    }

    socatProc.on("error", (err) => {
      logError(`socat error: ${err.message}`);
    });

    if (socatProc.stderr) {
      socatProc.stderr.on("data", (data: Buffer) => {
        // socat -d -d outputs to stderr, treat as info
        logInfo(`socat: ${data.toString().trim()}`);
      });
    }

    socatProc.on("exit", (code) => {
      logError(`socat exited with code ${code}`);
    });

    logInfo(`Started socat vsock listener on port ${VSOCK_PORT}`);
  });

  server.on("error", (err) => {
    logError(`Server error: ${err.message}`);
  });
}

/**
 * Load virtio-vsock kernel module if needed and verify /dev/vsock exists
 */
function ensureVsockModule(): void {
  logInfo("Checking virtio-vsock kernel module...");
  try {
    execSync("modprobe virtio-vsock 2>/dev/null || true", { stdio: "ignore" });
    logInfo("virtio-vsock module loaded");

    // Verify /dev/vsock exists
    if (fs.existsSync("/dev/vsock")) {
      logInfo("/dev/vsock device exists");
    } else {
      logError("/dev/vsock device does NOT exist - vsock will not work");
    }
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

  // Start vsock server and wait for host connections
  try {
    await startVsockServer();
  } catch (error) {
    logError(`Failed to start vsock server: ${error}`);
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
