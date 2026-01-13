#!/bin/sh
#
# overlay-init: Set up overlayfs before starting real init
#
# This script runs as PID 1 when the VM boots. It:
# 1. Mounts the squashfs base filesystem (read-only) from /dev/vda
# 2. Mounts the ext4 overlay filesystem (read-write) from /dev/vdb
# 3. Creates an overlayfs combining both
# 4. Switches root to the overlay
# 5. Executes the real init (systemd)
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

# Move mount points into new root so they remain accessible
mkdir -p /mnt/root/rom /mnt/root/rw /mnt/root/oldroot
mount --move /rom /mnt/root/rom
mount --move /rw /mnt/root/rw

# Switch to new root filesystem
# Use /oldroot for old root (not /rom, which already has squashfs mounted)
cd /mnt/root
pivot_root . oldroot

# Clean up old root reference (now at /oldroot after pivot)
umount -l /oldroot 2>/dev/null || true

# Start the real init (systemd)
exec /lib/systemd/systemd "$@"
