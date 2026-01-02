#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
vm0-agent: Vsock daemon for Firecracker VM communication

This daemon listens on vsock port 5000 and handles commands from the host.
It provides a JSON-based protocol for:
- exec: Execute shell commands
- write_file: Write content to files
- read_file: Read file contents
- ping: Health check

Protocol:
- Host sends JSON followed by newline
- Agent responds with JSON and closes connection

Compatible with Python 2.7 and Python 3.
"""

from __future__ import print_function
import json
import os
import socket
import subprocess
import sys
import signal
import logging

# Vsock constants
AF_VSOCK = 40
VMADDR_CID_ANY = 0xFFFFFFFF  # -1 as unsigned 32-bit (4294967295)
VSOCK_PORT = 5000

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[vm0-agent] %(asctime)s %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
log = logging.getLogger(__name__)


def handle_ping():
    """Handle ping request - health check"""
    return {"type": "pong"}


def handle_exec(request):
    """Handle exec request - run shell command"""
    command = request.get("command", "")
    if not command:
        return {"type": "error", "error": "No command provided"}

    try:
        # Python 2.7 compatible subprocess
        proc = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        stdout, stderr = proc.communicate()

        # Decode bytes to string for Python 2/3 compatibility
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")

        return {
            "type": "result",
            "exitCode": proc.returncode,
            "stdout": stdout,
            "stderr": stderr
        }
    except Exception as e:
        return {"type": "error", "error": str(e)}


def makedirs_exist_ok(path):
    """Python 2.7 compatible makedirs with exist_ok behavior"""
    try:
        os.makedirs(path)
    except OSError as e:
        import errno
        if e.errno != errno.EEXIST:
            raise


def handle_write_file(request):
    """Handle write_file request - write content to file"""
    path = request.get("path", "")
    content = request.get("content", "")

    if not path:
        return {"type": "error", "error": "No path provided"}

    try:
        # Create parent directories if needed
        parent = os.path.dirname(path)
        if parent:
            makedirs_exist_ok(parent)

        with open(path, "w") as f:
            f.write(content)

        return {"type": "result"}
    except Exception as e:
        return {"type": "error", "error": str(e)}


def handle_read_file(request):
    """Handle read_file request - read file contents"""
    path = request.get("path", "")

    if not path:
        return {"type": "error", "error": "No path provided"}

    try:
        with open(path, "r") as f:
            content = f.read()

        return {"type": "result", "content": content}
    except FileNotFoundError:
        return {"type": "error", "error": f"File not found: {path}"}
    except Exception as e:
        return {"type": "error", "error": str(e)}


def handle_request(data):
    """Parse and handle a request"""
    try:
        request = json.loads(data)
    except json.JSONDecodeError as e:
        return {"type": "error", "error": f"Invalid JSON: {e}"}

    req_type = request.get("type", "")

    handlers = {
        "ping": lambda: handle_ping(),
        "exec": lambda: handle_exec(request),
        "write_file": lambda: handle_write_file(request),
        "read_file": lambda: handle_read_file(request),
    }

    handler = handlers.get(req_type)
    if handler:
        return handler()
    else:
        return {"type": "error", "error": f"Unknown request type: {req_type}"}


def handle_connection(conn, addr):
    """Handle a single client connection"""
    log.info(f"Connection from CID {addr[0]}, port {addr[1]}")

    try:
        # Read request (up to 1MB)
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
            # Stop at newline (end of request)
            if b"\n" in data:
                break
            # Prevent unbounded memory usage
            if len(data) > 1024 * 1024:
                break

        if not data:
            log.warning("Empty request received")
            return

        # Parse request (strip newline)
        request_str = data.decode("utf-8").strip()
        log.debug(f"Request: {request_str[:200]}...")

        # Handle request
        response = handle_request(request_str)

        # Send response
        response_str = json.dumps(response)
        conn.sendall(response_str.encode("utf-8"))
        log.debug(f"Response: {response_str[:200]}...")

    except Exception as e:
        log.error(f"Error handling connection: {e}")
        try:
            error_response = json.dumps({"type": "error", "error": str(e)})
            conn.sendall(error_response.encode("utf-8"))
        except:
            pass
    finally:
        conn.close()


def main():
    """Main entry point"""
    log.info(f"Starting vm0-agent on vsock port {VSOCK_PORT}")

    # Handle SIGTERM gracefully
    def signal_handler(signum, frame):
        log.info("Received signal, shutting down...")
        sys.exit(0)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    # Create vsock socket
    try:
        sock = socket.socket(AF_VSOCK, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((VMADDR_CID_ANY, VSOCK_PORT))
        sock.listen(5)
        log.info(f"Listening on vsock port {VSOCK_PORT}")
    except Exception as e:
        log.error(f"Failed to create vsock socket: {e}")
        sys.exit(1)

    # Accept connections
    while True:
        try:
            conn, addr = sock.accept()
            handle_connection(conn, addr)
        except Exception as e:
            log.error(f"Error accepting connection: {e}")


if __name__ == "__main__":
    main()
