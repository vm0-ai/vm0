#!/usr/bin/env python3
"""
Vsock Agent for Firecracker VM host-guest communication.

Protocol: 4-byte length prefix (big endian) + JSON message
Messages: ready, ping/pong, exec/exec_result, error

No socat needed - Python has native vsock support via socket.AF_VSOCK.

For testing, supports Unix Domain Socket mode with --unix-socket option,
which simulates Firecracker's vsock proxy handshake (CONNECT/OK).
"""

import argparse
import json
import os
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


def handle_connection(conn: socket.socket, uds_mode: bool = False) -> None:
    """Handle a single host connection."""
    log("INFO", "Host connected")

    # In UDS mode, simulate Firecracker's vsock proxy handshake
    if uds_mode:
        try:
            # Read "CONNECT port\n" from client
            handshake_data = b""
            while b"\n" not in handshake_data:
                chunk = conn.recv(1024)
                if not chunk:
                    log("ERROR", "Connection closed during handshake")
                    conn.close()
                    return
                handshake_data += chunk

            handshake_line = handshake_data.split(b"\n")[0].decode("utf-8")
            if handshake_line.startswith("CONNECT "):
                port = handshake_line.split()[1]
                log("INFO", f"UDS handshake: CONNECT {port}")
                conn.sendall(f"OK {port}\n".encode("utf-8"))
            else:
                log("ERROR", f"Invalid handshake: {handshake_line}")
                conn.close()
                return
        except Exception as e:
            log("ERROR", f"Handshake error: {e}")
            conn.close()
            return

    _handle_messages(conn)


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


def main() -> None:
    parser = argparse.ArgumentParser(description="Vsock agent for Firecracker VM")
    parser.add_argument(
        "--unix-socket",
        type=str,
        help="Use Unix Domain Socket instead of vsock (for testing)",
    )
    args = parser.parse_args()

    uds_mode = args.unix_socket is not None

    log("INFO", "Starting vsock agent...")

    if uds_mode:
        # Unix Domain Socket mode for testing
        socket_path = args.unix_socket
        if os.path.exists(socket_path):
            os.unlink(socket_path)

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(socket_path)
        sock.listen(5)
        log("INFO", f"Listening on Unix socket: {socket_path}")
    else:
        # Real vsock mode for production
        sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((socket.VMADDR_CID_ANY, VSOCK_PORT))
        sock.listen(5)
        log("INFO", f"Listening on vsock port {VSOCK_PORT}")

    try:
        while True:
            conn, addr = sock.accept()
            if uds_mode:
                log("INFO", "Accepted Unix socket connection")
            else:
                log("INFO", f"Accepted connection from CID={addr[0]} port={addr[1]}")
            handle_connection(conn, uds_mode)
    except KeyboardInterrupt:
        log("INFO", "Shutting down")
    finally:
        sock.close()
        if uds_mode and os.path.exists(args.unix_socket):
            os.unlink(args.unix_socket)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Fatal: {e}", file=sys.stderr)
        sys.exit(1)
