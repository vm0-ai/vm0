# Stage 1: Base toolchain for CI/CD and minimal development
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
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version

# Install jq for JSON processing
RUN curl -sL https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64 -o /usr/local/bin/jq \
    && chmod +x /usr/local/bin/jq

# Install global npm packages for CI/CD
RUN npm install -g pnpm@10.15.0 lefthook@1.12.3 vercel@48.11.0 neonctl@2.15.0

# Install Ansible for runner deployment
# Using pip3 to ensure all ansible commands (ansible, ansible-playbook, etc.) are available
RUN apt-get update && apt-get install -y \
    python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install ansible

# Install Rust toolchain with ARM64 cross-compilation support
# Used for building vm-init for Firecracker VMs (ARM64 metal runners)
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y \
    musl-tools \
    gcc-aarch64-linux-gnu \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
    && rustup target add aarch64-unknown-linux-musl \
    && rustup component add rustfmt clippy \
    && rustc --version && cargo --version

# Install Playwright system dependencies for Chromium
# This is needed for e2e tests in CI
RUN npx playwright install-deps chromium

# Stage 2: Development environment with additional tools
FROM toolchain AS development

# Install development tools and user requirements
RUN apt-get update && apt-get install -y \
    sudo \
    zsh \
    vim \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright dependencies
# These are required for running browser automation tests
RUN apt-get update && apt-get install -y \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    xvfb \
    fonts-liberation \
    libu2f-udev \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install mkcert for local SSL certificates
RUN apt-get update && apt-get install -y \
    libnss3-tools \
    && ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then \
        curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/arm64"; \
    else \
        curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"; \
    fi \
    && chmod +x mkcert-v*-linux-* \
    && mv mkcert-v*-linux-* /usr/local/bin/mkcert \
    && rm -rf /var/lib/apt/lists/*

# Install 1Password CLI
RUN curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | tee /etc/apt/sources.list.d/1password.list \
    && mkdir -p /etc/debsig/policies/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol | tee /etc/debsig/policies/AC2D62742012EA22/1password.pol \
    && mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg \
    && apt-get update \
    && apt-get install -y 1password-cli \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser for browser automation
RUN npm install -g agent-browser \
    && agent-browser install --with-deps

# Install AWS CLI v2
RUN apt-get update && apt-get install -y unzip \
    && ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    fi \
    && unzip awscliv2.zip \
    && sudo ./aws/install \
    && rm -rf awscliv2.zip aws/ \
    && rm -rf /var/lib/apt/lists/*

# Create vscode user with standard UID/GID for devcontainer compatibility
# Following Microsoft's devcontainer pattern for better feature compatibility
# Use -f flag to force group creation if GID already exists (1Password CLI creates GID 1000)
RUN groupadd -f --gid 1000 vscode \
    && useradd --uid 1000 --gid vscode --shell /usr/bin/zsh --create-home vscode \
    && echo "vscode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode \
    && mkdir -p /home/vscode/.local/share /home/vscode/.cache /home/vscode/.config \
    && chown -R vscode:vscode /home/vscode

# Install rust-src for rust-analyzer (IDE support for standard library)
RUN rustup component add rust-src

# Install Caddy web server (matches devcontainers-extra/features/caddy)
RUN ARCH=$(dpkg --print-architecture) \
    && CADDY_VERSION=$(curl -s https://api.github.com/repos/caddyserver/caddy/releases/latest | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/') \
    && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/caddy.tar.gz \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy \
    && chmod +x /usr/local/bin/caddy \
    && rm /tmp/caddy.tar.gz

# Install Cloudflared tunnel client via apt (matches joedmck/devcontainer-features/cloudflared)
RUN mkdir -p /usr/share/keyrings \
    && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflared.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflared \
    && rm -rf /var/lib/apt/lists/*

# Default command
CMD ["/usr/bin/zsh"]
