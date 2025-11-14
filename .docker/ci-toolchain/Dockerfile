# VM0 CI/CD and Development Toolchain
# Multi-stage build for optimized CI and development environments

# Stage 1: CI/CD Toolchain (lightweight for GitHub Actions)
FROM ubuntu:22.04 AS toolchain

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gnupg \
    lsb-release \
    ca-certificates \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable && \
    corepack prepare pnpm@9.15.1 --activate

# Install global npm packages for CI/CD
RUN npm install -g \
    @evilmartians/lefthook@1.10.4 \
    turbo@2.3.3 \
    vercel@39.2.2 \
    neonctl@2.15.0

# Install jq for JSON processing (useful for CI scripts)
RUN curl -sL https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 -o /usr/local/bin/jq \
    && chmod +x /usr/local/bin/jq

# Install Playwright dependencies for E2E tests
# This is essential for running browser automation tests in CI
RUN npx -y playwright@1.49.1 install-deps chromium

# Configure pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN mkdir -p $PNPM_HOME && \
    pnpm config set store-dir /pnpm/store

# Set workspace
WORKDIR /workspace

# Stage 2: Development environment with additional tools
FROM toolchain AS development

# Install development tools
RUN apt-get update && apt-get install -y \
    sudo \
    zsh \
    vim \
    ripgrep \
    htop \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI for PR operations
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install mkcert for local SSL certificates
RUN apt-get update && apt-get install -y libnss3-tools \
    && curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64" \
    && chmod +x mkcert-v*-linux-amd64 \
    && mv mkcert-v*-linux-amd64 /usr/local/bin/mkcert \
    && rm -rf /var/lib/apt/lists/*

# Create vscode user (standard UID/GID for devcontainer compatibility)
RUN groupadd --gid 1000 vscode \
    && useradd --uid 1000 --gid vscode --shell /bin/bash --create-home vscode \
    && echo "vscode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode \
    && mkdir -p /home/vscode/.local/share /home/vscode/.cache /home/vscode/.config \
    && chown -R vscode:vscode /home/vscode

# Default to vscode user for development
USER vscode
WORKDIR /home/vscode/workspace

# Labels
LABEL org.opencontainers.image.source="https://github.com/vm0-ai/vm0"
LABEL org.opencontainers.image.description="CI/CD and development toolchain for VM0 monorepo"
LABEL org.opencontainers.image.licenses="MIT"

# Default command
CMD ["/bin/bash"]