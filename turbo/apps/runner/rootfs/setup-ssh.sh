#!/bin/bash
#
# Configure SSH server in a Firecracker rootfs image
#
# This script enables SSH access to VMs for command execution.
# It configures:
# - SSH server to start on boot
# - Root login with empty password (for VM communication)
# - Host keys for the SSH server
#
# Usage: ./setup-ssh.sh /path/to/rootfs.ext4
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

# Configure SSH server
echo "Configuring SSH server..."

# Ensure SSH directory exists
sudo mkdir -p "$MOUNT_POINT/etc/ssh"

# Configure sshd_config for root login with empty password
sudo tee "$MOUNT_POINT/etc/ssh/sshd_config" > /dev/null << 'EOF'
# SSH server configuration for Firecracker VMs

Port 22
AddressFamily inet
ListenAddress 0.0.0.0

# Authentication
PermitRootLogin yes
PermitEmptyPasswords yes
PasswordAuthentication yes
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys

# Security (relaxed for ephemeral VMs)
StrictModes no
UsePAM no

# Performance
UseDNS no
GSSAPIAuthentication no

# Subsystems
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

# Generate host keys if they don't exist
# These are baked into the image so all VMs have the same keys
# (acceptable for ephemeral sandboxes)
if [ ! -f "$MOUNT_POINT/etc/ssh/ssh_host_rsa_key" ]; then
    echo "Generating SSH host keys..."
    sudo ssh-keygen -t rsa -b 4096 -f "$MOUNT_POINT/etc/ssh/ssh_host_rsa_key" -N "" -C "vm0-sandbox"
    sudo ssh-keygen -t ecdsa -b 256 -f "$MOUNT_POINT/etc/ssh/ssh_host_ecdsa_key" -N "" -C "vm0-sandbox"
    sudo ssh-keygen -t ed25519 -f "$MOUNT_POINT/etc/ssh/ssh_host_ed25519_key" -N "" -C "vm0-sandbox"
fi

# Set correct permissions
sudo chmod 600 "$MOUNT_POINT/etc/ssh/ssh_host_"*"_key"
sudo chmod 644 "$MOUNT_POINT/etc/ssh/ssh_host_"*"_key.pub"

# Configure root user for passwordless login
echo "Configuring root user..."
# Remove root password (allows empty password login)
sudo sed -i 's/^root:[^:]*:/root::/' "$MOUNT_POINT/etc/shadow" 2>/dev/null || true

# Create root's .ssh directory
sudo mkdir -p "$MOUNT_POINT/root/.ssh"
sudo chmod 700 "$MOUNT_POINT/root/.ssh"

# Create systemd service override to ensure SSH starts early
echo "Enabling SSH service..."
sudo mkdir -p "$MOUNT_POINT/etc/systemd/system/sshd.service.d"
sudo tee "$MOUNT_POINT/etc/systemd/system/sshd.service.d/override.conf" > /dev/null << 'EOF'
[Unit]
After=network.target
Wants=network.target

[Service]
ExecStartPre=/bin/mkdir -p /run/sshd
Restart=always
RestartSec=1
EOF

# Enable SSH service at boot
sudo ln -sf /lib/systemd/system/ssh.service "$MOUNT_POINT/etc/systemd/system/multi-user.target.wants/ssh.service" 2>/dev/null || \
sudo ln -sf /lib/systemd/system/sshd.service "$MOUNT_POINT/etc/systemd/system/multi-user.target.wants/sshd.service" 2>/dev/null || \
echo "Note: Could not enable SSH service symlink, may need manual configuration"

# Configure DNS (remove systemd-resolved symlink and create static config)
echo "Configuring DNS..."
sudo rm -f "$MOUNT_POINT/etc/resolv.conf"
sudo tee "$MOUNT_POINT/etc/resolv.conf" > /dev/null << 'EOF'
# Static DNS configuration for Firecracker VMs
nameserver 8.8.8.8
nameserver 8.8.4.4
nameserver 1.1.1.1
EOF
sudo chmod 644 "$MOUNT_POINT/etc/resolv.conf"

# Verify installation
echo ""
echo "Installation complete. Verifying..."
ls -la "$MOUNT_POINT/etc/ssh/sshd_config"
ls -la "$MOUNT_POINT/etc/ssh/ssh_host_"*"_key" 2>/dev/null || echo "No host keys found"
echo "DNS config:"
cat "$MOUNT_POINT/etc/resolv.conf"

echo ""
echo "Success! SSH and DNS configured in $ROOTFS_PATH"
echo "VMs will accept SSH connections on port 22 with empty root password."
