#!/bin/bash
#
# Install vm0-agent to a Firecracker rootfs image
#
# Usage: ./install-agent.sh /path/to/rootfs.ext4
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOTFS_PATH="${1:-}"

if [ -z "$ROOTFS_PATH" ]; then
    echo "Usage: $0 /path/to/rootfs.ext4"
    exit 1
fi

if [ ! -f "$ROOTFS_PATH" ]; then
    echo "Error: Rootfs not found: $ROOTFS_PATH"
    exit 1
fi

# Create temporary mount point
MOUNT_POINT=$(mktemp -d)
echo "Mount point: $MOUNT_POINT"

cleanup() {
    echo "Cleaning up..."
    sudo umount "$MOUNT_POINT" 2>/dev/null || true
    rmdir "$MOUNT_POINT" 2>/dev/null || true
}

trap cleanup EXIT

# Mount the rootfs
echo "Mounting rootfs..."
sudo mount -o loop "$ROOTFS_PATH" "$MOUNT_POINT"

# Install vm0-agent (C binary, static linked)
echo "Installing vm0-agent..."
sudo cp "$SCRIPT_DIR/vm0-agent" "$MOUNT_POINT/usr/local/bin/vm0-agent"
sudo chmod +x "$MOUNT_POINT/usr/local/bin/vm0-agent"

# Install systemd service
echo "Installing systemd service..."
sudo tee "$MOUNT_POINT/etc/systemd/system/vm0-agent.service" > /dev/null << 'EOF'
[Unit]
Description=VM0 Agent - Vsock communication daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vm0-agent
Restart=always
RestartSec=1
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyS0

[Install]
WantedBy=multi-user.target
EOF

# Enable the service
echo "Enabling service..."
sudo ln -sf /etc/systemd/system/vm0-agent.service "$MOUNT_POINT/etc/systemd/system/multi-user.target.wants/vm0-agent.service"

# Verify installation
echo ""
echo "Installation complete. Verifying..."
ls -la "$MOUNT_POINT/usr/local/bin/vm0-agent"
ls -la "$MOUNT_POINT/etc/systemd/system/vm0-agent.service"
ls -la "$MOUNT_POINT/etc/systemd/system/multi-user.target.wants/vm0-agent.service"

echo ""
echo "Success! vm0-agent installed to $ROOTFS_PATH"
echo "The agent will start automatically when the VM boots."
