#!/usr/bin/env python3
"""
Vsock Bridge - Forwards vsock connections to Unix socket

This script bridges vsock (virtio-vsock) connections to a local Unix socket.
It's used because socat's VSOCK-LISTEN doesn't work reliably on aarch64,
but Python's native vsock support does.

Usage: vsock-bridge.py <vsock_port> <unix_socket_path>
"""

import socket
import sys
import os
import threading
import select

# Constants
AF_VSOCK = 40  # Address family for vsock
VMADDR_CID_ANY = 0xFFFFFFFF  # Accept from any CID
BUFFER_SIZE = 65536


def log(message: str) -> None:
    """Log a message with timestamp."""
    print(f"[vsock-bridge] {message}", flush=True)


def forward_data(src: socket.socket, dst: socket.socket, direction: str) -> None:
    """Forward data from src to dst until connection closes."""
    try:
        while True:
            data = src.recv(BUFFER_SIZE)
            if not data:
                break
            dst.sendall(data)
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        try:
            src.shutdown(socket.SHUT_RD)
        except OSError:
            pass
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle_connection(vsock_conn: socket.socket, unix_path: str, addr: tuple) -> None:
    """Handle a single vsock connection by forwarding to Unix socket."""
    log(f"Connection from CID={addr[0]}, port={addr[1]}")

    unix_sock = None
    try:
        # Connect to the Unix socket
        unix_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        unix_sock.connect(unix_path)
        log(f"Connected to Unix socket {unix_path}")

        # Create threads to forward data in both directions
        vsock_to_unix = threading.Thread(
            target=forward_data,
            args=(vsock_conn, unix_sock, "vsock->unix"),
            daemon=True
        )
        unix_to_vsock = threading.Thread(
            target=forward_data,
            args=(unix_sock, vsock_conn, "unix->vsock"),
            daemon=True
        )

        vsock_to_unix.start()
        unix_to_vsock.start()

        # Wait for both directions to complete
        vsock_to_unix.join()
        unix_to_vsock.join()

    except Exception as e:
        log(f"Error handling connection: {e}")
    finally:
        if unix_sock:
            try:
                unix_sock.close()
            except OSError:
                pass
        try:
            vsock_conn.close()
        except OSError:
            pass
        log(f"Connection closed for CID={addr[0]}")


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <vsock_port> <unix_socket_path>", file=sys.stderr)
        sys.exit(1)

    vsock_port = int(sys.argv[1])
    unix_path = sys.argv[2]

    log(f"Starting vsock bridge: vsock port {vsock_port} -> {unix_path}")

    # Check if /dev/vsock exists
    if not os.path.exists("/dev/vsock"):
        log("ERROR: /dev/vsock does not exist")
        sys.exit(1)

    # Create vsock listener
    try:
        vsock_sock = socket.socket(AF_VSOCK, socket.SOCK_STREAM)
        vsock_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        vsock_sock.bind((VMADDR_CID_ANY, vsock_port))
        vsock_sock.listen(5)
        log(f"Listening on vsock port {vsock_port}")
    except Exception as e:
        log(f"Failed to create vsock listener: {e}")
        sys.exit(1)

    # Accept connections and handle them in threads
    while True:
        try:
            conn, addr = vsock_sock.accept()
            # Handle each connection in a new thread
            handler = threading.Thread(
                target=handle_connection,
                args=(conn, unix_path, addr),
                daemon=True
            )
            handler.start()
        except Exception as e:
            log(f"Error accepting connection: {e}")


if __name__ == "__main__":
    main()
