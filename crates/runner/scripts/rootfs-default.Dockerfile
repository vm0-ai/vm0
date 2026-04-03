# Firecracker VM rootfs image
# Based on Ubuntu 24.04 with pre-installed language runtimes and databases
#
# Language runtimes:
# - Node.js 24 (npm, npx)
# - Python 3.x (pip)
# - Ruby 3.x (gem, bundler)
# - PHP 8.x (composer)
# - Java (OpenJDK + Maven + Gradle)
# - Go (latest stable)
# - Rust (stable toolchain + cargo)
# - C++ (GCC + Clang + CMake)
#
# Databases:
# - PostgreSQL 16
# - Redis 7.0
#
# Included CLIs:
# - Claude Code CLI (@anthropic-ai/claude-code)
# - GitHub CLI (gh)
# - agent-browser (Chromium browser automation)
# - Google Workspace CLI (@googleworkspace/cli)
# - xurl (X/Twitter official CLI)
#
# Build: docker build -t vm0-rootfs .
# Export: See build-rootfs.sh

FROM ubuntu:24.04

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    procps \
    curl \
    wget \
    git \
    ripgrep \
    jq \
    file \
    iproute2 \
    ca-certificates \
    sudo \
    gnupg \
    libnss3 \
    p11-kit-modules

# Make NSS-based applications (Chromium, Firefox) trust the system CA store.
# By default NSS uses a built-in trust module (libnssckbi.so) with Mozilla's
# root CAs. Replacing it with p11-kit's module makes NSS read from the same
# store as OpenSSL (/etc/ssl/certs/), so proxy CA certs injected via
# update-ca-certificates are trusted by all applications.
RUN find /usr/lib -name libnssckbi.so -exec sh -c \
    'p11=$(find /usr/lib -name p11-kit-trust.so | head -1) && ln -sf "$p11" "$1"' _ {} \;

# ---------------------------------------------------------------------------
# User account
# ---------------------------------------------------------------------------
# Ubuntu 24.04 ships with an 'ubuntu' user at UID 1000, so remove it first.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash user \
    && usermod -aG sudo user \
    && echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
    && passwd -d user

# ---------------------------------------------------------------------------
# Node.js 24 (via NodeSource)
# ---------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs

# ---------------------------------------------------------------------------
# Python 3.x
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip

# ---------------------------------------------------------------------------
# Ruby 3.x
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    ruby-full \
    bundler

# ---------------------------------------------------------------------------
# PHP 8.x + Composer
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    php \
    php-cli \
    php-common \
    php-curl \
    php-mbstring \
    php-xml \
    php-zip \
    unzip \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# ---------------------------------------------------------------------------
# Java (OpenJDK + Maven + Gradle)
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    default-jdk \
    maven \
    gradle

# ---------------------------------------------------------------------------
# Go (latest stable via official tarball)
# ---------------------------------------------------------------------------
ARG GO_VERSION=1.26.1
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz \
    && ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && echo 'export PATH=$PATH:$HOME/go/bin' > /etc/profile.d/golang.sh

# ---------------------------------------------------------------------------
# Rust (stable toolchain via rustup)
# ---------------------------------------------------------------------------
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --no-modify-path \
    && for bin in /usr/local/cargo/bin/*; do ln -s "$bin" /usr/local/bin/; done \
    && printf 'export RUSTUP_HOME=/usr/local/rustup\nexport CARGO_HOME=$HOME/.cargo\nexport PATH=$PATH:$HOME/.cargo/bin\n' \
       > /etc/profile.d/rust.sh

# ---------------------------------------------------------------------------
# C++ (GCC + Clang + CMake)
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    clang \
    make \
    cmake

# ---------------------------------------------------------------------------
# PostgreSQL 16
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    postgresql-16 \
    postgresql-contrib

# ---------------------------------------------------------------------------
# Redis 7
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y \
    redis-server

# ---------------------------------------------------------------------------
# Claude Code CLI (standalone Bun-compiled binary)
# ---------------------------------------------------------------------------
ARG CLAUDE_CODE_VERSION=2.1.91
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in amd64) PLATFORM="linux-x64" ;; arm64) PLATFORM="linux-arm64" ;; *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; esac \
    && GCS_BUCKET="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases" \
    && curl -fsSL "${GCS_BUCKET}/${CLAUDE_CODE_VERSION}/${PLATFORM}/claude" -o /usr/local/bin/claude \
    && CHECKSUM=$(curl -fsSL "${GCS_BUCKET}/${CLAUDE_CODE_VERSION}/manifest.json" \
       | jq -r ".platforms[\"$PLATFORM\"].checksum") \
    && echo "${CHECKSUM}  /usr/local/bin/claude" | sha256sum -c - \
    && chmod +x /usr/local/bin/claude

# ---------------------------------------------------------------------------
# GitHub CLI
# ---------------------------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh

# ---------------------------------------------------------------------------
# Google Workspace CLI
# ---------------------------------------------------------------------------
ARG GWS_CLI_VERSION=0.22.5
RUN npm install -g @googleworkspace/cli@${GWS_CLI_VERSION}

# ---------------------------------------------------------------------------
# xurl (X/Twitter official CLI)
# ---------------------------------------------------------------------------
ARG XURL_VERSION=1.0.3
RUN npm install -g @xdevplatform/xurl@${XURL_VERSION}

# ---------------------------------------------------------------------------
# Chromium + agent-browser
# ---------------------------------------------------------------------------
# Ubuntu 24.04's chromium-browser is a snap stub that doesn't work in Docker.
# Install the real Chromium deb from Debian Bookworm's repository instead.
ARG AGENT_BROWSER_VERSION=0.24.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && curl -fsSL https://ftp-master.debian.org/keys/archive-key-12.asc | gpg --dearmor -o /usr/share/keyrings/debian-bookworm.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/debian-bookworm.gpg] http://deb.debian.org/debian bookworm main" > /etc/apt/sources.list.d/debian-bookworm.list \
    && apt-get update \
    && apt-get install -y -t bookworm chromium \
    && rm /etc/apt/sources.list.d/debian-bookworm.list /usr/share/keyrings/debian-bookworm.gpg

# NOTE: DNS configuration is handled in build-rootfs.sh after export
# /etc/resolv.conf is read-only during Docker build

ENV LANG=C.UTF-8

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
# Docker layers don't matter since the image is exported as a flat rootfs.
RUN rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
    && npm cache clean --force
