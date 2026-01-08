# Firecracker VM rootfs image
# Based on Node.js 24 with Python 3.11+, SSH server, and Claude Code CLI
#
# This mirrors the e2b template configuration for consistency.
# See: turbo/scripts/e2b/vm0-claude-code/template.ts
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
RUN npm install -g @anthropic-ai/claude-code@latest

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
