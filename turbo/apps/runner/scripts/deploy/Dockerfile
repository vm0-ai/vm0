# Firecracker VM rootfs image (Universal)
# Based on Node.js 24 with Python 3.11+, SSH server, and agent CLIs
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
# - openssh-server: SSH access for runner communication
# - python3: Python 3.11+ for agent scripts
# - systemd: Init system for VM boot
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
    openssh-server \
    python3 \
    python3-pip \
    systemd \
    systemd-sysv \
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

# Configure SSH server for VM communication
# - Allow root and user login with empty password (acceptable for ephemeral sandboxes)
# - Disable DNS lookup for faster connections
# - Create required directories for both root and user
RUN mkdir -p /run/sshd /root/.ssh /home/user/.ssh \
    && chmod 700 /root/.ssh /home/user/.ssh \
    && chown user:user /home/user/.ssh \
    && sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitEmptyPasswords.*/PermitEmptyPasswords yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/UsePAM yes/UsePAM no/' /etc/ssh/sshd_config \
    && echo 'UseDNS no' >> /etc/ssh/sshd_config \
    && passwd -d root

# Generate SSH host keys (baked into image for consistency)
RUN ssh-keygen -A

# Enable SSH service to start on boot
RUN systemctl enable ssh

# NOTE: DNS configuration is handled in build-rootfs.sh after export
# /etc/resolv.conf is read-only during Docker build

# Create working directory for agent scripts
RUN mkdir -p /opt/vm0-scripts/lib

# Create directories for overlay-init (squashfs is read-only at boot)
# These are needed by /sbin/overlay-init to set up overlayfs
RUN mkdir -p /rom /rw /mnt/root

# Set default target for systemd
RUN systemctl set-default multi-user.target

# Clean up unnecessary systemd services for faster boot
RUN rm -f /lib/systemd/system/multi-user.target.wants/* \
    && rm -f /etc/systemd/system/*.wants/* \
    && rm -f /lib/systemd/system/local-fs.target.wants/* \
    && rm -f /lib/systemd/system/sockets.target.wants/*udev* \
    && rm -f /lib/systemd/system/sockets.target.wants/*initctl* \
    && rm -f /lib/systemd/system/basic.target.wants/* \
    && rm -f /lib/systemd/system/anaconda.target.wants/*

# Re-enable essential services
RUN systemctl enable ssh

CMD ["/lib/systemd/systemd"]
