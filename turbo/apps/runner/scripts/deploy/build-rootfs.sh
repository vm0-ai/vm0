#!/bin/bash
#
# Build Firecracker rootfs from Dockerfile
#
# This script builds a Docker image and converts it to a squashfs rootfs
# suitable for Firecracker VMs with OverlayFS support.
#
# Usage: ./build-rootfs.sh [output_path]
#
# Arguments:
#   output_path  Path for the output rootfs.squashfs file (default: ./rootfs.squashfs)
#
# Requirements:
# - Docker
# - Root privileges (sudo) for filesystem operations
# - squashfs-tools (mksquashfs)
#
# The output squashfs is read-only and shared across all VMs.
# Each VM creates a sparse ext4 overlay for writes (handled by vm.ts).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_PATH="${1:-${SCRIPT_DIR}/rootfs.squashfs}"
IMAGE_NAME="vm0-rootfs"
CONTAINER_NAME="vm0-rootfs-tmp"

# Docker command (may need sudo if user not in docker group)
DOCKER="docker"

echo "=== Firecracker Rootfs Builder (OverlayFS) ==="
echo "Output: ${OUTPUT_PATH}"
echo ""

# Check dependencies
check_dependencies() {
    echo "[CHECK] Checking dependencies..."

    if ! command -v docker &> /dev/null; then
        echo "ERROR: Docker is required but not installed"
        echo "Run ./install-firecracker.sh first to install Docker"
        exit 1
    fi

    # Check if docker works without sudo
    if ! docker info &> /dev/null; then
        echo "[INFO] Docker requires sudo (user not in docker group yet)"
        DOCKER="sudo docker"
    fi

    if ! command -v mksquashfs &> /dev/null; then
        echo "[INSTALL] Installing squashfs-tools..."
        sudo apt-get update && sudo apt-get install -y squashfs-tools
    fi

    echo "[OK] All dependencies available"
}

# Build Docker image
build_image() {
    echo "[BUILD] Building Docker image..."

    $DOCKER build -t "$IMAGE_NAME" "$SCRIPT_DIR"

    echo "[OK] Docker image built: ${IMAGE_NAME}"
}

# Export filesystem from Docker container
# Returns the path to the exported tar file via global variable
export_filesystem() {
    echo "[EXPORT] Exporting filesystem from container..." >&2

    # Remove any existing container
    $DOCKER rm -f "$CONTAINER_NAME" 2>/dev/null || true

    # Create container (don't start it)
    $DOCKER create --name "$CONTAINER_NAME" "$IMAGE_NAME" >&2

    # Export to tar
    EXPORTED_TAR=$(mktemp)
    $DOCKER export "$CONTAINER_NAME" -o "$EXPORTED_TAR"

    # Cleanup container
    $DOCKER rm -f "$CONTAINER_NAME" >&2

    echo "[OK] Filesystem exported to temporary tar: $EXPORTED_TAR" >&2
}

# Create squashfs image from filesystem
create_squashfs_image() {
    local tar_path="$1"

    echo "[CREATE] Creating squashfs image..."

    # Ensure output directory exists with proper permissions
    OUTPUT_DIR=$(dirname "$OUTPUT_PATH")
    sudo mkdir -p "$OUTPUT_DIR"

    # Remove existing output file
    sudo rm -f "$OUTPUT_PATH"

    # Create temp directory for extraction
    EXTRACT_DIR=$(mktemp -d)

    cleanup() {
        echo "[CLEANUP] Cleaning up..."
        sudo rm -rf "$EXTRACT_DIR" 2>/dev/null || true
        rm -f "$tar_path" 2>/dev/null || true
    }
    trap cleanup EXIT

    echo "[EXTRACT] Extracting filesystem..."
    sudo tar -xf "$tar_path" -C "$EXTRACT_DIR"

    # Configure DNS by creating a static resolv.conf
    sudo rm -f "$EXTRACT_DIR/etc/resolv.conf"
    echo "nameserver 8.8.8.8" | sudo tee "$EXTRACT_DIR/etc/resolv.conf" > /dev/null
    echo "nameserver 8.8.4.4" | sudo tee -a "$EXTRACT_DIR/etc/resolv.conf" > /dev/null
    echo "nameserver 1.1.1.1" | sudo tee -a "$EXTRACT_DIR/etc/resolv.conf" > /dev/null

    # Install guest-init binary (PID 1) - directly as /sbin/guest-init
    echo "[INSTALL] Installing guest-init..."
    sudo cp "$SCRIPT_DIR/guest-init" "$EXTRACT_DIR/sbin/guest-init"
    sudo chmod 755 "$EXTRACT_DIR/sbin/guest-init"

    # Install guest-download binary (storage downloader) - to /usr/local/bin
    echo "[INSTALL] Installing guest-download..."
    sudo cp "$SCRIPT_DIR/guest-download" "$EXTRACT_DIR/usr/local/bin/guest-download"
    sudo chmod 755 "$EXTRACT_DIR/usr/local/bin/guest-download"

    # Install agent files (ESM scripts)
    echo "[INSTALL] Installing agent files..."
    sudo cp "$SCRIPT_DIR/run-agent.mjs" "$EXTRACT_DIR/usr/local/bin/vm0-agent/"
    sudo cp "$SCRIPT_DIR/download.mjs" "$EXTRACT_DIR/usr/local/bin/vm0-agent/"
    sudo cp "$SCRIPT_DIR/mock-claude.mjs" "$EXTRACT_DIR/usr/local/bin/vm0-agent/"
    sudo cp "$SCRIPT_DIR/env-loader.mjs" "$EXTRACT_DIR/usr/local/bin/vm0-agent/"
    sudo chmod +x "$EXTRACT_DIR/usr/local/bin/vm0-agent/"*

    # Install proxy CA certificate (required for MITM mode)
    echo "[INSTALL] Installing proxy CA certificate..."
    CA_CERT_PATH="${SCRIPT_DIR}/proxy-ca/mitmproxy-ca-cert.pem"
    if [ ! -f "$CA_CERT_PATH" ]; then
        echo "ERROR: CA certificate not found at ${CA_CERT_PATH}"
        echo "Run ./generate-proxy-ca.sh first to generate the CA certificate"
        exit 1
    fi
    sudo mkdir -p "$EXTRACT_DIR/usr/local/share/ca-certificates"
    sudo cp "$CA_CERT_PATH" "$EXTRACT_DIR/usr/local/share/ca-certificates/vm0-proxy-ca.crt"
    sudo chmod 644 "$EXTRACT_DIR/usr/local/share/ca-certificates/vm0-proxy-ca.crt"
    sudo chroot "$EXTRACT_DIR" update-ca-certificates
    echo "[OK] Proxy CA certificate installed"

    # Create squashfs with xz compression (best compression ratio)
    echo "[SQUASH] Creating squashfs (this may take a moment)..."
    sudo mksquashfs "$EXTRACT_DIR" "$OUTPUT_PATH" -comp xz -noappend -quiet

    # Cleanup
    sudo rm -rf "$EXTRACT_DIR"
    rm -f "$tar_path"
    trap - EXIT

    echo "[OK] Rootfs created: ${OUTPUT_PATH}"
}

# Verify the rootfs
verify_rootfs() {
    echo "[VERIFY] Verifying rootfs..."

    # Check file exists and has reasonable size
    if [ ! -f "$OUTPUT_PATH" ]; then
        echo "ERROR: Output file not created"
        exit 1
    fi

    SIZE=$(stat -c%s "$OUTPUT_PATH")
    if [ "$SIZE" -lt 50000000 ]; then
        echo "WARNING: Rootfs seems too small (${SIZE} bytes)"
    fi

    # Mount squashfs and check key files
    MOUNT_POINT=$(mktemp -d)
    sudo mount -t squashfs -o loop,ro "$OUTPUT_PATH" "$MOUNT_POINT"

    ERRORS=0

    if [ ! -f "$MOUNT_POINT/usr/bin/python3" ]; then
        echo "ERROR: Python3 not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        PYTHON_VERSION=$(sudo chroot "$MOUNT_POINT" /usr/bin/python3 --version 2>/dev/null || echo "unknown")
        echo "  Python: ${PYTHON_VERSION}"
    fi

    if [ ! -f "$MOUNT_POINT/sbin/guest-init" ]; then
        echo "ERROR: guest-init binary not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        echo "  guest-init: installed (Rust binary at /sbin/guest-init)"
    fi

    if [ ! -f "$MOUNT_POINT/usr/local/bin/guest-download" ]; then
        echo "ERROR: guest-download binary not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        echo "  guest-download: installed (Rust binary at /usr/local/bin/guest-download)"
    fi

    # Check for agent scripts
    if [ ! -f "$MOUNT_POINT/usr/local/bin/vm0-agent/run-agent.mjs" ]; then
        echo "ERROR: run-agent.mjs not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        echo "  agent scripts: installed"
    fi

    # Check for Codex CLI (for framework: codex)
    if ! sudo chroot "$MOUNT_POINT" /usr/bin/which codex > /dev/null 2>&1; then
        echo "WARNING: Codex CLI not found in rootfs"
    else
        echo "  Codex CLI: installed"
    fi

    # Check for GitHub CLI (for apps: [github])
    if ! sudo chroot "$MOUNT_POINT" /usr/bin/which gh > /dev/null 2>&1; then
        echo "WARNING: GitHub CLI not found in rootfs"
    else
        echo "  GitHub CLI: installed"
    fi

    # Check proxy CA certificate file exists
    if [ ! -f "$MOUNT_POINT/usr/local/share/ca-certificates/vm0-proxy-ca.crt" ]; then
        echo "ERROR: Proxy CA certificate not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        echo "  Proxy CA file: installed"
    fi

    # Check proxy CA is in system CA bundle (update-ca-certificates worked)
    # Extract a unique line from our CA cert and check if it exists in the bundle
    CA_CERT_LINE=$(sed -n '2p' "$MOUNT_POINT/usr/local/share/ca-certificates/vm0-proxy-ca.crt" 2>/dev/null)
    if [ -z "$CA_CERT_LINE" ] || ! grep -qF "$CA_CERT_LINE" "$MOUNT_POINT/etc/ssl/certs/ca-certificates.crt" 2>/dev/null; then
        echo "ERROR: Proxy CA not found in system CA bundle (update-ca-certificates may have failed)"
        ERRORS=$((ERRORS + 1))
    else
        echo "  Proxy CA bundle: updated"
    fi

    sudo umount "$MOUNT_POINT"
    rmdir "$MOUNT_POINT"

    if [ "$ERRORS" -gt 0 ]; then
        echo "ERROR: Rootfs verification failed with ${ERRORS} errors"
        exit 1
    fi

    echo "[OK] Rootfs verification passed"
}

# Main
main() {
    check_dependencies
    build_image
    export_filesystem
    create_squashfs_image "$EXPORTED_TAR"
    verify_rootfs

    echo ""
    echo "=== Build Complete ==="
    echo "Rootfs: ${OUTPUT_PATH}"
    echo "Size: $(du -h "$OUTPUT_PATH" | cut -f1) (compressed squashfs)"
    echo ""
    echo "To use with Firecracker, specify this path in runner.yaml:"
    echo "  firecracker:"
    echo "    rootfs: ${OUTPUT_PATH}"
    echo ""
    echo "Note: This squashfs is read-only. Each VM creates a sparse overlay"
    echo "for writes, reducing disk usage from ~500MB/VM to only modified files."
}

main "$@"
