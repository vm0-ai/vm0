#!/usr/bin/env python3
"""
Vsock Agent for Firecracker VM host-guest communication.

Protocol: 4-byte length prefix (big endian) + JSON message
Messages: ready, ping/pong, exec/exec_result, error

No socat needed - Python has native vsock support via socket.AF_VSOCK.

Guest-initiated connection: Agent connects to Host (CID=2) when ready,
providing zero-latency notification instead of Host polling.

For testing, supports Unix Domain Socket mode with --unix-socket option,
where agent connects to the specified socket path (same as production flow).
"""

import argparse
import json
import socket
import struct
import subprocess
import sys
import uuid
from datetime import datetime

VSOCK_PORT = 1000
HEADER_SIZE = 4
MAX_MESSAGE_SIZE = 1024 * 1024


def log(level: str, msg: str) -> None:
    ts = datetime.now().isoformat()
    print(f"[{ts}] [vsock-agent] [{level}] {msg}", flush=True)


def encode(msg: dict) -> bytes:
    """Encode message with 4-byte length prefix."""
    data = json.dumps(msg).encode("utf-8")
    if len(data) > MAX_MESSAGE_SIZE:
        raise ValueError(f"Message too large: {len(data)}")
    header = struct.pack(">I", len(data))
    return header + data


class Decoder:
    """Decode length-prefixed JSON messages from stream."""

    def __init__(self):
        self.buf = b""

    def decode(self, data: bytes) -> list[dict]:
        self.buf += data
        messages = []
        while len(self.buf) >= HEADER_SIZE:
            length = struct.unpack(">I", self.buf[:HEADER_SIZE])[0]
            if length > MAX_MESSAGE_SIZE:
                raise ValueError(f"Message too large: {length}")
            total = HEADER_SIZE + length
            if len(self.buf) < total:
                break
            payload = self.buf[HEADER_SIZE:total]
            messages.append(json.loads(payload.decode("utf-8")))
            self.buf = self.buf[total:]
        return messages


def exec_command(command: str, timeout_ms: int = 30000) -> dict:
    """Execute shell command and return result."""
    log("INFO", f"Executing: {command[:100]}{'...' if len(command) > 100 else ''}")
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            timeout=timeout_ms / 1000,
        )
        return {
            "exitCode": result.returncode,
            "stdout": result.stdout.decode("utf-8", errors="replace"),
            "stderr": result.stderr.decode("utf-8", errors="replace"),
        }
    except subprocess.TimeoutExpired:
        return {"exitCode": 124, "stdout": "", "stderr": "Timeout"}
    except Exception as e:
        return {"exitCode": 1, "stdout": "", "stderr": f"Error: {e}"}


def handle(msg: dict) -> dict:
    """Handle incoming message and return response."""
    msg_type = msg.get("type", "")
    msg_id = msg.get("id", "")
    log("INFO", f"Received: type={msg_type} id={msg_id}")

    if msg_type == "ping":
        return {"type": "pong", "id": msg_id, "payload": {}}
    elif msg_type == "exec":
        payload = msg.get("payload", {})
        command = payload.get("command", "")
        timeout_ms = payload.get("timeoutMs", 30000)
        result = exec_command(command, timeout_ms)
        return {"type": "exec_result", "id": msg_id, "payload": result}
    else:
        return {"type": "error", "id": msg_id, "payload": {"message": f"Unknown type: {msg_type}"}}


def _handle_messages(conn: socket.socket) -> None:
    """Handle message loop after connection is established."""
    decoder = Decoder()

    # Send ready signal
    ready = {"type": "ready", "id": str(uuid.uuid4()), "payload": {}}
    conn.sendall(encode(ready))
    log("INFO", "Sent ready signal")

    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
            for msg in decoder.decode(data):
                resp = handle(msg)
                if resp:
                    conn.sendall(encode(resp))
    except Exception as e:
        log("ERROR", f"Connection error: {e}")
    finally:
        log("INFO", "Host disconnected")
        conn.close()


def connect(unix_socket: str | None = None) -> None:
    """Connect to host and handle messages."""
    if unix_socket:
        # Unix Domain Socket mode (for testing)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        addr = unix_socket
        log("INFO", f"Connecting to Unix socket: {unix_socket}...")
    else:
        # Vsock mode (production) - CID 2 is always the host
        sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        addr = (2, VSOCK_PORT)
        log("INFO", "Connecting to host (CID=2)...")

    try:
        sock.connect(addr)
        log("INFO", "Connected")
        _handle_messages(sock)
    except Exception as e:
        log("ERROR", f"Failed to connect: {e}")
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Vsock agent for Firecracker VM")
    parser.add_argument(
        "--unix-socket",
        type=str,
        help="Connect to Unix Domain Socket instead of vsock (for testing)",
    )
    args = parser.parse_args()

    log("INFO", "Starting vsock agent...")
    connect(args.unix_socket)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Fatal: {e}", file=sys.stderr)
        sys.exit(1)
