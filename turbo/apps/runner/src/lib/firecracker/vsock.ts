/**
 * Vsock Client for Firecracker VMs
 *
 * Provides host-side communication with guest via virtio-vsock.
 * Firecracker exposes vsock as a Unix Domain Socket (UDS) with a simple protocol:
 * 1. Connect to UDS
 * 2. Send "CONNECT port\n"
 * 3. Receive "OK host_port\n" on success
 * 4. Socket becomes bidirectional stream to guest
 */

import * as net from "node:net";
import * as fs from "node:fs";

const VSOCK_PORT = 1000;
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Connect to guest via vsock and send/receive a test message
 * Returns the echoed response or throws on failure
 */
async function testVsockEcho(
  vsockPath: string,
  message: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(vsockPath)) {
      reject(new Error(`Vsock socket not found: ${vsockPath}`));
      return;
    }

    const socket = net.createConnection(vsockPath);
    let connected = false;
    let response = "";

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Vsock connection timeout"));
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      // Send Firecracker vsock CONNECT command
      socket.write(`CONNECT ${VSOCK_PORT}\n`);
    });

    socket.on("data", (data) => {
      const str = data.toString();

      if (!connected) {
        // Waiting for OK response from Firecracker
        if (str.startsWith("OK ")) {
          connected = true;
          // Send test message to guest
          socket.write(message);
          // Close write side to signal end of input
          socket.end();
        } else {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`Vsock connect failed: ${str.trim()}`));
        }
      } else {
        // Collecting response from guest
        response += str;
      }
    });

    socket.on("end", () => {
      clearTimeout(timeout);
      if (connected) {
        resolve(response);
      } else {
        reject(new Error("Vsock connection closed before connect"));
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Vsock error: ${err.message}`));
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      if (!connected) {
        reject(new Error("Vsock socket closed unexpectedly"));
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
  const testMessage = "ping";

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await testVsockEcho(vsockPath, testMessage);
      if (response === testMessage) {
        return; // Success - vsock echo is working
      }
    } catch {
      // Expected during VM boot, keep retrying
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Vsock not ready after ${timeoutMs}ms`);
}
