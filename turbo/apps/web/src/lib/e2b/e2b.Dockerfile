FROM e2b/code-interpreter:latest

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create VM0 directory for scripts
RUN mkdir -p /opt/vm0

# Install required tools (curl and jq for webhook communication)
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace
