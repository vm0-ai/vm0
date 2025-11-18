FROM node:22-slim

# Install basic tools and dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@2.0.24

# Verify Claude Code installation
RUN claude --version

# Copy run-agent.sh script to /usr/local/bin
COPY run-agent.sh /usr/local/bin/run-agent.sh
RUN chmod +x /usr/local/bin/run-agent.sh

# Switch to non-root user
USER 1000

# Create workspace in home directory (guaranteed writable)
RUN mkdir -p $HOME/workspace

# Set working directory to user's home workspace
WORKDIR /home/user/workspace
