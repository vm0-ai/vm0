#!/bin/bash
#
# Install Firecracker and Linux kernel on a Metal machine
#
# This script checks for existing installations and downloads
# Firecracker binary and kernel if not present.
#
# Usage: ./install-firecracker.sh
#
# Requirements:
# - Root privileges (sudo)
# - curl
# - tar
#

set -e

# Configuration
FIRECRACKER_VERSION="${FIRECRACKER_VERSION:-v1.10.1}"
ARCH=$(uname -m)

# Installation paths
FIRECRACKER_BIN="/usr/local/bin/firecracker"
KERNEL_DIR="/opt/firecracker"
KERNEL_PATH="${KERNEL_DIR}/vmlinux"

# Download URLs
FIRECRACKER_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${ARCH}.tgz"
# Kernel from Firecracker's CI artifacts (minimal kernel for microVMs)
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/${ARCH}/vmlinux-6.1.102"

echo "=== Firecracker Installation Script ==="
echo "Version: ${FIRECRACKER_VERSION}"
echo "Architecture: ${ARCH}"
echo ""

# Check architecture
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ]; then
    echo "ERROR: Unsupported architecture: ${ARCH}"
    echo "Firecracker supports x86_64 and aarch64 only."
    exit 1
fi

# Install Firecracker binary
install_firecracker() {
    if [ -f "$FIRECRACKER_BIN" ]; then
        INSTALLED_VERSION=$($FIRECRACKER_BIN --version 2>/dev/null | head -1 || echo "unknown")
        echo "[OK] Firecracker already installed: ${INSTALLED_VERSION}"
        return 0
    fi

    echo "[INSTALL] Downloading Firecracker ${FIRECRACKER_VERSION}..."

    TMP_DIR=$(mktemp -d)
    trap "rm -rf $TMP_DIR" EXIT

    curl -fsSL "$FIRECRACKER_URL" -o "$TMP_DIR/firecracker.tgz"
    tar -xzf "$TMP_DIR/firecracker.tgz" -C "$TMP_DIR"

    # Find the firecracker binary in extracted files
    FC_BIN=$(find "$TMP_DIR" -name "firecracker-${FIRECRACKER_VERSION}-${ARCH}" -type f | head -1)

    if [ -z "$FC_BIN" ]; then
        echo "ERROR: Could not find firecracker binary in archive"
        exit 1
    fi

    sudo cp "$FC_BIN" "$FIRECRACKER_BIN"
    sudo chmod +x "$FIRECRACKER_BIN"

    echo "[OK] Firecracker installed to ${FIRECRACKER_BIN}"
    $FIRECRACKER_BIN --version
}

# Install Linux kernel
install_kernel() {
    if [ -f "$KERNEL_PATH" ]; then
        echo "[OK] Kernel already installed: ${KERNEL_PATH}"
        return 0
    fi

    echo "[INSTALL] Downloading Linux kernel..."

    sudo mkdir -p "$KERNEL_DIR"
    sudo curl -fsSL "$KERNEL_URL" -o "$KERNEL_PATH"
    sudo chmod 644 "$KERNEL_PATH"

    echo "[OK] Kernel installed to ${KERNEL_PATH}"
}

# Configure KVM access
setup_kvm() {
    if [ ! -e /dev/kvm ]; then
        echo "[ERROR] /dev/kvm not found - Firecracker requires KVM support"
        echo "        Make sure you're running on a bare-metal instance with KVM enabled"
        return 1
    fi

    # Check if user already has access
    if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
        echo "[OK] KVM is available and accessible"
        return 0
    fi

    echo "[SETUP] Configuring KVM access..."

    # Add user to kvm group (for future sessions)
    if ! groups "$USER" | grep -q '\bkvm\b'; then
        echo "[SETUP] Adding $USER to kvm group..."
        sudo usermod -aG kvm "$USER"
    fi

    # Set /dev/kvm permissions for immediate access (current session)
    # This is needed because group membership only takes effect after re-login
    echo "[SETUP] Setting /dev/kvm permissions..."
    sudo chmod 666 /dev/kvm

    # Verify access now works
    if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
        echo "[OK] KVM configured and accessible"
        return 0
    else
        echo "[ERROR] Failed to configure KVM access"
        return 1
    fi
}

# Install required system packages
install_dependencies() {
    echo "[CHECK] Checking system dependencies..."

    MISSING=""

    command -v curl >/dev/null 2>&1 || MISSING="$MISSING curl"
    command -v tar >/dev/null 2>&1 || MISSING="$MISSING tar"
    command -v ip >/dev/null 2>&1 || MISSING="$MISSING iproute2"

    if [ -n "$MISSING" ]; then
        echo "[INSTALL] Installing missing packages:$MISSING"
        sudo apt-get update
        sudo apt-get install -y $MISSING
    fi

    echo "[OK] All dependencies installed"
}

# Install Docker if not present
install_docker() {
    if command -v docker &> /dev/null; then
        echo "[OK] Docker already installed: $(docker --version)"
        return 0
    fi

    echo "[INSTALL] Installing Docker..."

    # Install Docker using official convenience script
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm /tmp/get-docker.sh

    # Add current user to docker group
    sudo usermod -aG docker "$USER"

    # Start Docker service
    sudo systemctl enable docker
    sudo systemctl start docker

    echo "[OK] Docker installed: $(docker --version)"
}

# Install Node.js if not present (required for running the runner)
install_nodejs() {
    if command -v node &> /dev/null; then
        echo "[OK] Node.js already installed: $(node --version)"
    else
        echo "[INSTALL] Installing Node.js 24.x..."

        # Install Node.js using NodeSource repository
        curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
        sudo apt-get install -y nodejs

        echo "[OK] Node.js installed: $(node --version)"
        echo "[OK] npm installed: $(npm --version)"
    fi

    # Install pnpm globally (required for workspace: protocol support)
    if command -v pnpm &> /dev/null; then
        echo "[OK] pnpm already installed: $(pnpm --version)"
    else
        echo "[INSTALL] Installing pnpm..."
        sudo npm install -g pnpm
        echo "[OK] pnpm installed: $(pnpm --version)"
    fi

    # Install pm2 globally for process management
    if command -v pm2 &> /dev/null; then
        echo "[OK] pm2 already installed: $(pm2 --version)"
    else
        echo "[INSTALL] Installing pm2..."
        sudo npm install -g pm2
        echo "[OK] pm2 installed: $(pm2 --version)"
    fi
}

# Main
main() {
    install_dependencies
    install_docker
    install_nodejs
    install_firecracker
    install_kernel
    setup_kvm

    echo ""
    echo "=== Installation Complete ==="
    echo "Firecracker: ${FIRECRACKER_BIN}"
    echo "Kernel: ${KERNEL_PATH}"
    echo "Docker: $(docker --version 2>/dev/null || echo 'not installed')"
    echo "Node.js: $(node --version 2>/dev/null || echo 'not installed')"
    echo "pnpm: $(pnpm --version 2>/dev/null || echo 'not installed')"
    echo "pm2: $(pm2 --version 2>/dev/null || echo 'not installed')"
    echo ""
    echo "Next step: Build rootfs with ./build-rootfs.sh"
}

main "$@"
