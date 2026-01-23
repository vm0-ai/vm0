#!/usr/bin/env python3
"""
Vsock Agent for Firecracker VM host-guest communication.

Protocol: 4-byte length prefix (big endian) + JSON message
Messages: ready, ping/pong, exec/exec_result, error

No socat needed - Python has native vsock support via socket.AF_VSOCK.
"""

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


def handle_connection(conn: socket.socket) -> None:
    """Handle a single host connection."""
    log("INFO", "Host connected")
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


def main() -> None:
    log("INFO", "Starting vsock agent...")

    # Create vsock socket directly (no socat needed)
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
    sock.listen(5)

    log("INFO", f"Listening on vsock port {VSOCK_PORT}")

    try:
        while True:
            conn, addr = sock.accept()
            log("INFO", f"Accepted connection from CID={addr[0]} port={addr[1]}")
            handle_connection(conn)
    except KeyboardInterrupt:
        log("INFO", "Shutting down")
    finally:
        sock.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Fatal: {e}", file=sys.stderr)
        sys.exit(1)
