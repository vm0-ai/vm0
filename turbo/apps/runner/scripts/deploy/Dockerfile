# Firecracker VM rootfs image (Wolfi)
# Based on Wolfi with Node.js 22, Python 3, tini, and agent CLIs
#
# This is a universal image that supports all frameworks and apps:
# - Claude Code CLI (@anthropic-ai/claude-code) for framework: claude-code
# - Codex CLI (@openai/codex) for framework: codex
# - GitHub CLI (gh) for apps: [github]
#
# Wolfi advantages over Alpine:
# - Uses glibc (better compatibility than musl)
# - Minimal design for fast boot
# - No init system overhead (uses tini + custom init)
#
# Build: docker build -t vm0-rootfs .
# Export: See build-rootfs.sh

FROM cgr.dev/chainguard/wolfi-base

# Install required packages
# Core:
# - nodejs-22: Node.js runtime for Claude Code and Codex CLIs
# - python-3: Python 3 for vsock-agent
# - tini: Lightweight init for signal handling
# Development tools:
# - curl: HTTP client
# - git: Version control
# - ripgrep: Fast code search (used by Claude Code)
# - jq: JSON processing
# - file: File type detection
# System utilities:
# - iproute2: Network utilities (ip command)
# - ca-certificates: SSL certificates for HTTPS
# - sudo: For privileged operations
# - bash: Required by some CLIs
# - kmod: Kernel module loading (modprobe)
RUN apk add --no-cache \
    nodejs-22 \
    npm \
    python-3 \
    py3-pip \
    tini \
    curl \
    git \
    ripgrep \
    jq \
    file \
    iproute2 \
    ca-certificates \
    sudo \
    bash \
    gh \
    kmod \
    procps \
    util-linux

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest

# Install Codex CLI globally
RUN npm install -g @openai/codex@latest

# Clean npm cache to reduce image size
RUN npm cache clean --force

# Create 'user' account (UID 1000) matching E2B sandbox default
RUN adduser -D -u 1000 -s /bin/bash user \
    && mkdir -p /etc/sudoers.d \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user

# Create working directory for agent scripts
RUN mkdir -p /opt/vm0-scripts/lib

# Create directories for overlay-init (squashfs is read-only at boot)
RUN mkdir -p /rom /rw /mnt/root

# Install vsock-agent
RUN mkdir -p /usr/local/bin/vm0-agent
COPY vsock-agent.py /usr/local/bin/vm0-agent/vsock-agent.py
RUN chmod +x /usr/local/bin/vm0-agent/vsock-agent.py

# Environment
ENV LANG=C.UTF-8

# Note: VM boot uses kernel param init=/sbin/overlay-init (copied by build-rootfs.sh)
# overlay-init sets up overlayfs and starts tini + vsock-agent
