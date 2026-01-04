#!/bin/bash
#
# Deploy runner to Metal machine
#
# This is the main entry point for deploying the runner.
# It handles both initial setup and PR-specific deployments.
#
# Usage: ./deploy.sh <pr_number> <runner_dir>
#
# This script should be run ON the Metal machine (via SSH from GitHub Actions).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PR_NUMBER="${1:?PR number required}"
RUNNER_DIR="${2:?Runner directory required}"

echo "=== VM0 Runner Deployment ==="
echo "PR: #${PR_NUMBER}"
echo "Directory: ${RUNNER_DIR}"
echo ""

# Step 1: Ensure Firecracker is installed (global, one-time)
echo ">>> Step 1: Check/Install Firecracker"
"$SCRIPT_DIR/install-firecracker.sh"
echo ""

# Step 2: Build rootfs for this PR (if not exists or Dockerfile changed)
echo ">>> Step 2: Build rootfs"
ROOTFS_PATH="${RUNNER_DIR}/rootfs.ext4"

# Check if we need to rebuild rootfs
NEED_BUILD=false
if [ ! -f "$ROOTFS_PATH" ]; then
    echo "Rootfs not found, building..."
    NEED_BUILD=true
elif [ "$FORCE_REBUILD_ROOTFS" = "true" ]; then
    echo "Force rebuild requested..."
    NEED_BUILD=true
fi

if [ "$NEED_BUILD" = "true" ]; then
    "$SCRIPT_DIR/build-rootfs.sh" "$ROOTFS_PATH"
else
    echo "Rootfs already exists: ${ROOTFS_PATH}"
fi
echo ""

# Step 3: Verify installation
echo ">>> Step 3: Verification"
echo "Firecracker: $(which firecracker)"
echo "Kernel: /opt/firecracker/vmlinux"
echo "Rootfs: ${ROOTFS_PATH}"

if [ -f "/usr/local/bin/firecracker" ] && [ -f "/opt/firecracker/vmlinux" ] && [ -f "$ROOTFS_PATH" ]; then
    echo ""
    echo "=== Deployment Complete ==="
    echo "Runner is ready to start!"
else
    echo ""
    echo "ERROR: Some components are missing"
    exit 1
fi
