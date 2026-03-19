# Firecracker VM rootfs image
# Based on Node.js 24 with Python 3.11+, guest-init, and agent CLIs
#
# Included CLIs:
# - Claude Code CLI (@anthropic-ai/claude-code)
# - GitHub CLI (gh)
# - agent-browser (Chromium browser automation)
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
    libnss3 \
    p11-kit-modules \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Make NSS-based applications (Chromium, Firefox) trust the system CA store.
# By default NSS uses a built-in trust module (libnssckbi.so) with Mozilla's
# root CAs. Replacing it with p11-kit's module makes NSS read from the same
# store as OpenSSL (/etc/ssl/certs/), so proxy CA certs injected via
# update-ca-certificates are trusted by all applications.
RUN find /usr/lib -name libnssckbi.so -exec sh -c \
    'p11=$(find /usr/lib -name p11-kit-trust.so | head -1) && ln -sf "$p11" "$1"' _ {} \;

# Install Claude Code CLI as a standalone Bun-compiled binary.
# The binary bundles Bun runtime (JSC) + application code into a single executable,
# eliminating module resolution overhead and reducing CLI cold-start time.
ARG CLAUDE_CODE_VERSION=2.1.75
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in amd64) PLATFORM="linux-x64" ;; arm64) PLATFORM="linux-arm64" ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac \
    && GCS_BUCKET="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases" \
    && curl -fsSL "${GCS_BUCKET}/${CLAUDE_CODE_VERSION}/${PLATFORM}/claude" -o /usr/local/bin/claude \
    && CHECKSUM=$(curl -fsSL "${GCS_BUCKET}/${CLAUDE_CODE_VERSION}/manifest.json" \
       | jq -r ".platforms[\"$PLATFORM\"].checksum") \
    && echo "${CHECKSUM}  /usr/local/bin/claude" | sha256sum -c - \
    && chmod +x /usr/local/bin/claude

# Install GitHub CLI (included in base image)
# See: turbo/scripts/e2b/vm0-claude-code/template.ts
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

# Install Chromium and agent-browser CLI for browser automation.
# System Chromium is used on all architectures for version consistency.
# squashfs is demand-paged so Chromium binaries don't consume memory unless launched.
ARG AGENT_BROWSER_VERSION=0.21.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
