#!/bin/bash
#
# Build Firecracker rootfs from Dockerfile
#
# This script builds a Docker image and converts it to an ext4 rootfs
# suitable for Firecracker VMs.
#
# Usage: ./build-rootfs.sh [output_path]
#
# Arguments:
#   output_path  Path for the output rootfs.ext4 file (default: ./rootfs.ext4)
#
# Requirements:
# - Docker
# - Root privileges (sudo) for mounting ext4 image
# - e2fsprogs (mkfs.ext4)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_PATH="${1:-${SCRIPT_DIR}/rootfs.ext4}"
IMAGE_NAME="vm0-rootfs"
CONTAINER_NAME="vm0-rootfs-tmp"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-2048}"

echo "=== Firecracker Rootfs Builder ==="
echo "Output: ${OUTPUT_PATH}"
echo "Size: ${ROOTFS_SIZE_MB}MB"
echo ""

# Check dependencies
check_dependencies() {
    echo "[CHECK] Checking dependencies..."

    if ! command -v docker &> /dev/null; then
        echo "ERROR: Docker is required but not installed"
        exit 1
    fi

    if ! command -v mkfs.ext4 &> /dev/null; then
        echo "ERROR: mkfs.ext4 is required (install e2fsprogs)"
        exit 1
    fi

    echo "[OK] All dependencies available"
}

# Build Docker image
build_image() {
    echo "[BUILD] Building Docker image..."

    docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

    echo "[OK] Docker image built: ${IMAGE_NAME}"
}

# Export filesystem from Docker container
export_filesystem() {
    echo "[EXPORT] Exporting filesystem from container..."

    # Remove any existing container
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

    # Create container (don't start it)
    docker create --name "$CONTAINER_NAME" "$IMAGE_NAME"

    # Export to tar
    TMP_TAR=$(mktemp)
    docker export "$CONTAINER_NAME" -o "$TMP_TAR"

    # Cleanup container
    docker rm -f "$CONTAINER_NAME"

    echo "[OK] Filesystem exported to temporary tar"
    echo "$TMP_TAR"
}

# Create ext4 image and populate with filesystem
create_ext4_image() {
    local tar_path="$1"

    echo "[CREATE] Creating ext4 image (${ROOTFS_SIZE_MB}MB)..."

    # Remove existing output file
    rm -f "$OUTPUT_PATH"

    # Create sparse file
    dd if=/dev/zero of="$OUTPUT_PATH" bs=1M count=0 seek="$ROOTFS_SIZE_MB" 2>/dev/null

    # Format as ext4
    mkfs.ext4 -F -L "rootfs" "$OUTPUT_PATH" >/dev/null 2>&1

    # Mount and extract
    MOUNT_POINT=$(mktemp -d)

    cleanup() {
        echo "[CLEANUP] Cleaning up..."
        sudo umount "$MOUNT_POINT" 2>/dev/null || true
        rmdir "$MOUNT_POINT" 2>/dev/null || true
        rm -f "$tar_path" 2>/dev/null || true
    }
    trap cleanup EXIT

    echo "[MOUNT] Mounting ext4 image..."
    sudo mount -o loop "$OUTPUT_PATH" "$MOUNT_POINT"

    echo "[EXTRACT] Extracting filesystem..."
    sudo tar -xf "$tar_path" -C "$MOUNT_POINT"

    # Ensure resolv.conf is a regular file (not a symlink)
    # This is important because systemd-resolved creates a symlink
    sudo rm -f "$MOUNT_POINT/etc/resolv.conf"
    echo "nameserver 8.8.8.8" | sudo tee "$MOUNT_POINT/etc/resolv.conf" > /dev/null
    echo "nameserver 8.8.4.4" | sudo tee -a "$MOUNT_POINT/etc/resolv.conf" > /dev/null
    echo "nameserver 1.1.1.1" | sudo tee -a "$MOUNT_POINT/etc/resolv.conf" > /dev/null

    echo "[UNMOUNT] Unmounting..."
    sudo umount "$MOUNT_POINT"
    rmdir "$MOUNT_POINT"

    # Remove tar from cleanup since we're done with it
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
    if [ "$SIZE" -lt 100000000 ]; then
        echo "WARNING: Rootfs seems too small (${SIZE} bytes)"
    fi

    # Mount and check key files
    MOUNT_POINT=$(mktemp -d)
    sudo mount -o loop,ro "$OUTPUT_PATH" "$MOUNT_POINT"

    ERRORS=0

    if [ ! -f "$MOUNT_POINT/usr/bin/python3" ]; then
        echo "ERROR: Python3 not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        PYTHON_VERSION=$(sudo chroot "$MOUNT_POINT" /usr/bin/python3 --version 2>/dev/null || echo "unknown")
        echo "  Python: ${PYTHON_VERSION}"
    fi

    if [ ! -f "$MOUNT_POINT/usr/sbin/sshd" ]; then
        echo "ERROR: SSH server not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        echo "  SSH: installed"
    fi

    if [ ! -f "$MOUNT_POINT/lib/systemd/systemd" ]; then
        echo "ERROR: systemd not found in rootfs"
        ERRORS=$((ERRORS + 1))
    else
        echo "  systemd: installed"
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
    TAR_PATH=$(export_filesystem)
    create_ext4_image "$TAR_PATH"
    verify_rootfs

    echo ""
    echo "=== Build Complete ==="
    echo "Rootfs: ${OUTPUT_PATH}"
    echo "Size: $(du -h "$OUTPUT_PATH" | cut -f1)"
    echo ""
    echo "To use with Firecracker, specify this path in runner.yaml:"
    echo "  firecracker:"
    echo "    rootfs: ${OUTPUT_PATH}"
}

main "$@"
