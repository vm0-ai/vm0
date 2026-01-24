# Firecracker VM rootfs image (Alpine)
# Based on Node.js 24 Alpine with Python 3, vsock-agent, and agent CLIs
#
# This is a universal image that supports all frameworks and apps:
# - Claude Code CLI for framework: claude-code
# - Codex CLI for framework: codex
# - GitHub CLI (gh) for apps: [github]
#
# This mirrors the e2b template configurations for consistency.
# See: turbo/scripts/e2b/vm0-*/template.ts
#
# Build: docker build -t vm0-rootfs .
# Export: See build-rootfs.sh

FROM node:24-alpine

# Install required packages
# Core:
# - python3: Python 3 for vsock-agent
# - py3-pip: Python package manager
# - openrc: Init system for VM boot (lighter than systemd)
# - procps: Process utilities (pgrep, free) needed by metrics and executor
# Development tools (matching e2b template):
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
# Compatibility:
# - libgcc, libstdc++: Required by Claude Code CLI
# - libc6-compat: glibc compatibility for some binaries
RUN apk add --no-cache \
    python3 \
    py3-pip \
    openrc \
    procps \
    curl \
    git \
    ripgrep \
    jq \
    file \
    iproute2 \
    ca-certificates \
    sudo \
    bash \
    libgcc \
    libstdc++ \
    libc6-compat \
    github-cli \
    && mkdir -p /usr/local/share/ca-certificates \
    && update-ca-certificates

# Install Claude Code CLI globally
# Note: Using npm install as native installer requires interactive shell
RUN npm install -g @anthropic-ai/claude-code@latest

# Install Codex CLI globally
# Using npm for simplicity; static musl binary is an alternative
RUN npm install -g @openai/codex@latest

# Create 'user' account (UID 1000) matching E2B sandbox default
# - Home directory at /home/user
# - Add to wheel group for sudo
# Note: node:24-alpine has 'node' user at UID 1000, so we delete it first
RUN deluser --remove-home node 2>/dev/null || true \
    && adduser -D -u 1000 -s /bin/bash user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# NOTE: DNS configuration is handled in build-rootfs.sh after export
# /etc/resolv.conf is read-only during Docker build

# Create working directory for agent scripts
RUN mkdir -p /opt/vm0-scripts/lib

# Create directories for overlay-init (squashfs is read-only at boot)
# These are needed by /sbin/overlay-init to set up overlayfs
RUN mkdir -p /rom /rw /mnt/root

# Configure OpenRC for VM boot
# Remove unnecessary services that slow down boot
RUN rc-update del networking boot 2>/dev/null || true \
    && rc-update del machine-id boot 2>/dev/null || true \
    && rc-update del hwclock boot 2>/dev/null || true \
    && rc-update del modules boot 2>/dev/null || true \
    && rc-update del modloop boot 2>/dev/null || true

# Install vsock-agent (Python, no socat needed - native AF_VSOCK support)
# Protocol: 4-byte length prefix (big endian) + JSON message
# Messages: ready, ping/pong, exec/exec_result
RUN mkdir -p /usr/local/bin/vm0-agent
COPY vsock-agent.py /usr/local/bin/vm0-agent/vsock-agent.py
RUN chmod +x /usr/local/bin/vm0-agent/vsock-agent.py

# Install vsock-agent OpenRC service
COPY vsock-agent.openrc /etc/init.d/vsock-agent
RUN chmod +x /etc/init.d/vsock-agent \
    && rc-update add vsock-agent default

# Environment for Claude Code on musl systems
ENV USE_BUILTIN_RIPGREP=0
ENV LANG=C.UTF-8

CMD ["/sbin/init"]
