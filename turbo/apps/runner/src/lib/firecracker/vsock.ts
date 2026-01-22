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

const VSOCK_PORT = 1000;
const CONNECT_TIMEOUT_MS = 5000;
const HEADER_SIZE = 4;
const MAX_MESSAGE_SIZE = 1024 * 1024;

// Message types matching the guest agent
type MessageType = "ready" | "ping" | "pong" | "exec" | "exec_result" | "error";

interface Message<T = unknown> {
  type: MessageType;
  id: string;
  payload: T;
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
