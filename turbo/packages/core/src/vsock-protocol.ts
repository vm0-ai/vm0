/**
 * Vsock Protocol Types
 *
 * Shared message protocol for host-guest communication via vsock.
 * Used by both the host VsockClient and the guest VsockAgent.
 */

/**
 * Message types for vsock communication
 */
export type VsockMessageType =
  | "ready" // Guest -> Host: VM ready for commands
  | "exec" // Host -> Guest: Execute command
  | "exec_result" // Guest -> Host: Command result
  | "write_file" // Host -> Guest: Write file content
  | "write_ack" // Guest -> Host: Write confirmation
  | "read_file" // Host -> Guest: Read file request
  | "file_content" // Guest -> Host: File content
  | "error"; // Either direction: Error response

/**
 * Base vsock message structure
 */
export interface VsockMessage<T = unknown> {
  type: VsockMessageType;
  id: string; // UUID for request correlation
  payload: T;
}

/**
 * Ready message - sent by guest when it's ready to receive commands
 * Empty payload - presence of message indicates readiness
 */
export type ReadyPayload = Record<string, never>;

/**
 * Command execution request
 */
export interface ExecPayload {
  command: string;
  timeoutMs?: number;
  sudo?: boolean;
}

/**
 * Command execution result
 */
export interface ExecResultPayload {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Write file request
 */
export interface WriteFilePayload {
  path: string;
  content: string; // base64 encoded for binary safety
  sudo?: boolean;
}

/**
 * Write file acknowledgment
 */
export interface WriteAckPayload {
  path: string;
  success: boolean;
}

/**
 * Read file request
 */
export interface ReadFilePayload {
  path: string;
}

/**
 * File content response
 */
export interface FileContentPayload {
  path: string;
  content: string; // base64 encoded
}

/**
 * Error response
 */
export interface ErrorPayload {
  message: string;
  code?: string;
}

/**
 * Vsock communication constants
 */
export const VSOCK_CONSTANTS = {
  /** Port number for vsock communication */
  PORT: 1000,
  /** Host CID (used by guest to connect to host) */
  HOST_CID: 2,
  /** Message header size (4 bytes for length prefix) */
  HEADER_SIZE: 4,
  /** Maximum message size (1MB) */
  MAX_MESSAGE_SIZE: 1024 * 1024,
} as const;

/**
 * Create a vsock message with length prefix for wire transmission
 * Wire format: [4 bytes length (big endian)] [JSON message]
 */
export function encodeVsockMessage<T>(message: VsockMessage<T>): Buffer {
  const jsonStr = JSON.stringify(message);
  const jsonBuffer = Buffer.from(jsonStr, "utf-8");

  if (jsonBuffer.length > VSOCK_CONSTANTS.MAX_MESSAGE_SIZE) {
    throw new Error(
      `Message too large: ${jsonBuffer.length} bytes (max: ${VSOCK_CONSTANTS.MAX_MESSAGE_SIZE})`,
    );
  }

  const header = Buffer.alloc(VSOCK_CONSTANTS.HEADER_SIZE);
  header.writeUInt32BE(jsonBuffer.length, 0);

  return Buffer.concat([header, jsonBuffer]);
}

/**
 * Decode a vsock message from a buffer
 * Returns the decoded message and remaining buffer
 */
export function decodeVsockMessage(
  buffer: Buffer,
): { message: VsockMessage; remaining: Buffer } | null {
  if (buffer.length < VSOCK_CONSTANTS.HEADER_SIZE) {
    return null; // Need more data
  }

  const messageLength = buffer.readUInt32BE(0);

  if (messageLength > VSOCK_CONSTANTS.MAX_MESSAGE_SIZE) {
    throw new Error(
      `Message too large: ${messageLength} bytes (max: ${VSOCK_CONSTANTS.MAX_MESSAGE_SIZE})`,
    );
  }

  const totalLength = VSOCK_CONSTANTS.HEADER_SIZE + messageLength;
  if (buffer.length < totalLength) {
    return null; // Need more data
  }

  const jsonBuffer = buffer.slice(VSOCK_CONSTANTS.HEADER_SIZE, totalLength);
  const message = JSON.parse(jsonBuffer.toString("utf-8")) as VsockMessage;

  return {
    message,
    remaining: buffer.slice(totalLength),
  };
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return crypto.randomUUID();
}
