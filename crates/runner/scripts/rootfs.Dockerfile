# Firecracker VM rootfs image (Universal)
# Based on Node.js 24 with Python 3.11+, guest-init, and agent CLIs
#
# This is a universal image that supports all frameworks and apps:
# - Claude Code CLI (@anthropic-ai/claude-code) for framework: claude-code
# - Codex CLI (@openai/codex) for framework: codex
# - GitHub CLI (gh) for apps: [github]
#
# This mirrors the e2b template configurations for consistency.
# See: turbo/scripts/e2b/vm0-*/template.ts
#
# Build: docker build -t vm0-rootfs .
# Export: See build-rootfs.sh

FROM node:24-bookworm-slim

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install required packages
# Core:
# - python3: Python 3.11+ for agent scripts
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
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    procps \
    curl \
    git \
    ripgrep \
    jq \
    file \
    iproute2 \
    ca-certificates \
    sudo \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Claude Code CLI globally (matching e2b template)
RUN npm install -g @anthropic-ai/claude-code@2.1.12

# Install Codex CLI globally (matching e2b template)
# See: turbo/scripts/e2b/vm0-codex/template.ts
RUN npm install -g @openai/codex@latest

# Install GitHub CLI (for apps: [github])
# See: turbo/scripts/e2b/vm0-claude-code-github/template.ts
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Create 'user' account (UID 1000) matching E2B sandbox default
# - Home directory at /home/user
# - Add to sudo group for privileged operations
# Note: node:24-bookworm-slim has 'node' user at UID 1000, so we delete it first
RUN userdel -r node 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash user \
    && usermod -aG sudo user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
    && passwd -d user

# NOTE: DNS configuration is handled in build-rootfs.sh after export
# /etc/resolv.conf is read-only during Docker build

# Create directories for guest-init (squashfs is read-only at boot)
# These are needed by /sbin/guest-init to set up overlayfs
RUN mkdir -p /rom /rw /mnt/root

ENV LANG=C.UTF-8
