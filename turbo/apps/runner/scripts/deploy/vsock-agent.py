#!/usr/bin/env python3
"""
Vsock Agent for Firecracker VM host-guest communication.

Binary Protocol:
  [4-byte length][1-byte type][4-byte seq][payload]

  - length: size of (type + seq + payload), big-endian
  - type: message type
  - seq: sequence number for request/response matching, big-endian
  - payload: type-specific binary data

Message Types:
  0x00 ready          G→H  (empty)
  0x01 ping           H→G  (empty)
  0x02 pong           G→H  (empty)
  0x03 exec           H→G  [4-byte timeout_ms][4-byte cmd_len][command]
  0x04 exec_result    G→H  [4-byte exit_code][4-byte stdout_len][stdout][4-byte stderr_len][stderr]
  0x05 write_file     H→G  [2-byte path_len][path][1-byte flags][4-byte content_len][content]
  0x06 write_file_result G→H [1-byte success][2-byte error_len][error]
  0xFF error          G→H  [2-byte error_len][error]

For testing, supports Unix Domain Socket mode with --unix-socket option.
"""

import argparse
import os
import socket
import struct
import subprocess
import sys
from datetime import datetime

VSOCK_PORT = 1000
HEADER_SIZE = 4
MAX_MESSAGE_SIZE = 16 * 1024 * 1024  # 16MB max

# Message types
MSG_READY = 0x00
MSG_PING = 0x01
MSG_PONG = 0x02
MSG_EXEC = 0x03
MSG_EXEC_RESULT = 0x04
MSG_WRITE_FILE = 0x05
MSG_WRITE_FILE_RESULT = 0x06
MSG_ERROR = 0xFF


def log(level: str, msg: str) -> None:
    ts = datetime.now().isoformat()
    print(f"[{ts}] [vsock-agent] [{level}] {msg}", flush=True)


def encode(msg_type: int, seq: int, payload: bytes = b"") -> bytes:
    """Encode message with binary protocol."""
    body = struct.pack(">BI", msg_type, seq) + payload
    header = struct.pack(">I", len(body))
    return header + body


def encode_error(seq: int, error: str) -> bytes:
    """Encode error message."""
    error_bytes = error.encode("utf-8")[:65535]  # Truncate to fit 2-byte length
    payload = struct.pack(">H", len(error_bytes)) + error_bytes
    return encode(MSG_ERROR, seq, payload)


def encode_exec_result(seq: int, exit_code: int, stdout: bytes, stderr: bytes) -> bytes:
    """Encode exec_result message."""
    payload = struct.pack(">iI", exit_code, len(stdout)) + stdout
    payload += struct.pack(">I", len(stderr)) + stderr
    return encode(MSG_EXEC_RESULT, seq, payload)


def encode_write_file_result(seq: int, success: bool, error: str = "") -> bytes:
    """Encode write_file_result message."""
    error_bytes = error.encode("utf-8")[:65535] if error else b""  # Truncate to fit 2-byte length
    payload = struct.pack(">BH", 1 if success else 0, len(error_bytes)) + error_bytes
    return encode(MSG_WRITE_FILE_RESULT, seq, payload)


class Decoder:
    """Decode binary messages from stream."""

    def __init__(self):
        self.buf = b""

    def decode(self, data: bytes) -> list[tuple[int, int, bytes]]:
        """Decode messages, returns list of (type, seq, payload)."""
        self.buf += data
        messages = []
        while len(self.buf) >= HEADER_SIZE:
            length = struct.unpack(">I", self.buf[:HEADER_SIZE])[0]
            if length > MAX_MESSAGE_SIZE:
                raise ValueError(f"Message too large: {length}")
            if length < 5:  # minimum: 1 byte type + 4 bytes seq
                raise ValueError(f"Message too small: {length}")
            total = HEADER_SIZE + length
            if len(self.buf) < total:
                break
            body = self.buf[HEADER_SIZE:total]
            msg_type, seq = struct.unpack(">BI", body[:5])
            payload = body[5:]
            messages.append((msg_type, seq, payload))
            self.buf = self.buf[total:]
        return messages


def handle_exec(payload: bytes) -> tuple[int, bytes, bytes]:
    """Handle exec message, returns (exit_code, stdout, stderr)."""
    if len(payload) < 8:
        return (1, b"", b"Invalid exec payload")
    timeout_ms, cmd_len = struct.unpack(">II", payload[:8])
    command = payload[8 : 8 + cmd_len].decode("utf-8", errors="replace")

    log("INFO", f"exec: {command[:100]}{'...' if len(command) > 100 else ''}")

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            timeout=timeout_ms / 1000,
        )
        return (
            result.returncode,
            result.stdout,
            result.stderr,
        )
    except subprocess.TimeoutExpired:
        return (124, b"", b"Timeout")
    except Exception as e:
        return (1, b"", str(e).encode("utf-8"))


def handle_write_file(payload: bytes) -> tuple[bool, str]:
    """Handle write_file message, returns (success, error)."""
    if len(payload) < 3:
        return (False, "Invalid write_file payload")

    path_len = struct.unpack(">H", payload[:2])[0]
    if len(payload) < 2 + path_len + 1 + 4:
        return (False, "Invalid write_file payload: too short")

    path = payload[2 : 2 + path_len].decode("utf-8", errors="replace")
    flags = payload[2 + path_len]
    content_len = struct.unpack(">I", payload[3 + path_len : 7 + path_len])[0]

    if len(payload) < 7 + path_len + content_len:
        return (False, "Invalid write_file payload: content truncated")

    content = payload[7 + path_len : 7 + path_len + content_len]

    sudo = bool(flags & 0x01)
    log("INFO", f"write_file: path={path} size={len(content)} sudo={sudo}")

    try:
        if sudo:
            # Use sudo tee to write directly
            result = subprocess.run(
                ["sudo", "tee", path],
                input=content,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=30,
            )
            if result.returncode != 0:
                return (False, f"sudo tee failed: {result.stderr.decode()}")
        else:
            # Ensure parent directory exists
            dir_path = os.path.dirname(path)
            if dir_path:
                os.makedirs(dir_path, exist_ok=True)
            with open(path, "wb") as f:
                f.write(content)
        return (True, "")
    except Exception as e:
        log("ERROR", f"write_file failed: {e}")
        return (False, str(e))


def handle_message(msg_type: int, seq: int, payload: bytes) -> bytes | None:
    """Handle incoming message and return response bytes."""
    log("INFO", f"Received: type=0x{msg_type:02X} seq={seq}")

    if msg_type == MSG_PING:
        return encode(MSG_PONG, seq)
    elif msg_type == MSG_EXEC:
        exit_code, stdout, stderr = handle_exec(payload)
        return encode_exec_result(seq, exit_code, stdout, stderr)
    elif msg_type == MSG_WRITE_FILE:
        success, error = handle_write_file(payload)
        return encode_write_file_result(seq, success, error)
    else:
        return encode_error(seq, f"Unknown message type: 0x{msg_type:02X}")


def _handle_messages(conn: socket.socket) -> None:
    """Handle message loop after connection is established."""
    decoder = Decoder()

    # Send ready signal (seq=0 for ready)
    conn.sendall(encode(MSG_READY, 0))
    log("INFO", "Sent ready signal")

    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            for msg_type, seq, payload in decoder.decode(data):
                resp = handle_message(msg_type, seq, payload)
                if resp:
                    conn.sendall(resp)
    except Exception as e:
        log("ERROR", f"Connection error: {e}")
    finally:
        log("INFO", "Host disconnected")
        conn.close()


def connect(unix_socket: str | None = None) -> None:
    """Connect to host and handle messages."""
    if unix_socket:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        addr = unix_socket
        log("INFO", f"Connecting to Unix socket: {unix_socket}...")
    else:
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
