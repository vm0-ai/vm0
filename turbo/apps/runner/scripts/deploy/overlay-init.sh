#!/bin/sh
#
# overlay-init: Set up overlayfs before starting vsock-agent
#
# This script runs as PID 1 when the VM boots. It:
# 1. Mounts the squashfs base filesystem (read-only) from /dev/vda
# 2. Mounts the ext4 overlay filesystem (read-write) from /dev/vdb
# 3. Creates an overlayfs combining both
# 4. Switches root to the overlay
# 5. Mounts virtual filesystems (/proc, /sys)
# 6. Starts vsock-agent with tini for signal handling
#
# Device mapping:
#   /dev/vda - squashfs base (read-only, shared across VMs)
#   /dev/vdb - ext4 overlay (read-write, per-VM)
#
set -e

# Mount read-only base filesystem (squashfs on /dev/vda)
mkdir -p /rom
mount -t squashfs -o ro /dev/vda /rom

# Mount read-write overlay filesystem (ext4 on /dev/vdb)
mkdir -p /rw
mount -t ext4 /dev/vdb /rw

# Create overlay directories
mkdir -p /rw/upper /rw/work

# Create merged root with overlayfs
mkdir -p /mnt/root
mount -t overlay overlay -o lowerdir=/rom,upperdir=/rw/upper,workdir=/rw/work /mnt/root

# Prepare new root for pivot
mkdir -p /mnt/root/oldroot

# Switch to new root filesystem
cd /mnt/root
/usr/sbin/pivot_root . oldroot

# Now we're in the new root. Move mounts from old root to new locations.
mkdir -p /rom /rw
mount --move /oldroot/rom /rom
mount --move /oldroot/rw /rw

# Move devtmpfs from old root to new root
# This is critical for /dev/vsock and other device nodes created by the kernel
mount --move /oldroot/dev /dev

# Load virtio-vsock kernel module for host-guest communication
# Note: Load before umount oldroot in case module deps are needed
modprobe virtio-vsock 2>/dev/null || true

# Verify /dev/vsock exists (for debugging)
if [ -e /dev/vsock ]; then
    echo "[overlay-init] /dev/vsock exists"
else
    echo "[overlay-init] WARNING: /dev/vsock does not exist after modprobe"
fi

# Clean up old root reference (after modprobe to ensure module deps are available)
umount -l /oldroot 2>/dev/null || true

# Mount virtual filesystems needed by tini and processes
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sys /sys 2>/dev/null || true

# Set PATH to include /usr/local/bin for node and other executables
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Start vsock-agent with tini for proper signal handling and zombie reaping
exec /usr/bin/tini -- /usr/bin/python3 /usr/local/bin/vm0-agent/vsock-agent.py
