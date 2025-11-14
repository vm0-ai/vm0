# CI Toolchain Docker Image
# Provides a consistent environment for GitHub Actions CI/CD

FROM node:22-alpine AS base

# Install basic dependencies
RUN apk add --no-cache \
    git \
    bash \
    curl \
    make \
    python3 \
    py3-pip \
    jq

# Install pnpm globally
RUN npm install -g pnpm@10.22.0

# Install turbo globally for turbo-ignore
RUN npm install -g turbo@latest

# Install lefthook globally for linting
RUN npm install -g @evilmartians/lefthook@latest

# Install Vercel CLI globally
RUN npm install -g vercel@latest

# Create workspace directory
WORKDIR /workspace

# Set pnpm store directory
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN pnpm config set store-dir /pnpm-store

# Pre-create common directories
RUN mkdir -p /pnpm-store /workspace

# Add labels for GitHub Container Registry
LABEL org.opencontainers.image.source="https://github.com/vm0-ai/vm0"
LABEL org.opencontainers.image.description="CI Toolchain for VM0 project"
LABEL org.opencontainers.image.licenses="MIT"

# Default command
CMD ["/bin/bash"]