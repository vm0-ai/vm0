#!/bin/bash

# Simple setup script for dev container (based on vm0 setup)
set -e

echo "🚀 Setting up dev container..."

# Get the workspace directory dynamically
# Script is in .devcontainer/setup.sh, so workspace is parent directory
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "📁 Workspace directory: $WORKSPACE_DIR"

# Setup PostgreSQL (handled by postgresql feature)
sudo chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true
sudo service postgresql start 2>/dev/null || true

# Generate locale for UTF-8 support
echo "🌐 Setting up locale..."
sudo locale-gen en_US.UTF-8 2>/dev/null || true
sudo update-locale LANG=en_US.UTF-8 2>/dev/null || true
echo "✓ Locale configured"

# Add vm7.ai domains to /etc/hosts (Caddy reverse proxy listens on 127.0.0.1)
echo "🌐 Configuring vm7.ai hosts..."
if ! grep -q "vm7.ai" /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 vm7.ai www.vm7.ai docs.vm7.ai platform.vm7.ai" | sudo tee -a /etc/hosts > /dev/null
  echo "✓ vm7.ai domains added to /etc/hosts"
else
  echo "✓ vm7.ai domains already in /etc/hosts"
fi

# Setup directories - fix ownership for all mounted volumes
sudo mkdir -p /home/vscode/.local/bin /home/vscode/.pki
sudo chown -R vscode:vscode /home/vscode/.config /home/vscode/.cache /home/vscode/.local /home/vscode/.pki /home/vscode/.cloudflared

# Create ~/.claude symlink to ~/.config/claude for Claude Code IDE integration
# The VS Code extension uses ~/.claude/ide/ while CLI respects CLAUDE_CONFIG_DIR
if [ ! -L "$HOME/.claude" ]; then
  rm -rf "$HOME/.claude"
  mkdir -p "$HOME/.config/claude"
  ln -s "$HOME/.config/claude" "$HOME/.claude"
  echo "✓ Linked ~/.claude to ~/.config/claude"
fi

if [ ! -L "$HOME/.claude/downloads" ]; then
  rm -rf "$HOME/.claude/downloads"
  mkdir -p "$HOME/.cache/claude"
  ln -s "$HOME/.cache/claude" "$HOME/.claude/downloads"
  echo "✓ Linked ~/.claude/downloads to ~/.cache/claude"
fi

# Install host mkcert CA if certificates exist
# The rootCA.pem is generated on the host machine and shared via .certs/
if [ -f "$WORKSPACE_DIR/.certs/rootCA.pem" ]; then
  echo "🔐 Installing host mkcert CA..."
  HOST_CA="$WORKSPACE_DIR/.certs/rootCA.pem"

  # Install to system trust store (for curl, Node.js, etc.)
  sudo cp "$HOST_CA" /usr/local/share/ca-certificates/mkcert-host-ca.crt
  sudo update-ca-certificates 2>/dev/null
  echo "✓ Host CA installed to system trust store"

  # Install to Chromium NSS database (~/.pki/nssdb)
  CHROMIUM_NSS="$HOME/.pki/nssdb"
  if [ -d "$CHROMIUM_NSS" ]; then
    certutil -d sql:"$CHROMIUM_NSS" -A -t "C,," -n "mkcert-host" -i "$HOST_CA" 2>/dev/null || true
    echo "✓ Host CA installed to Chromium NSS database"
  fi
elif [ -d "$WORKSPACE_DIR/.certs" ] && [ "$(ls -A $WORKSPACE_DIR/.certs 2>/dev/null)" ]; then
  echo "⚠️  Certificates found but no rootCA.pem. Run 'scripts/generate-certs.sh' on host to include CA."
else
  echo "ℹ️  No certificates found. Run 'scripts/generate-certs.sh' on host to create them."
fi

# Install lefthook git hooks for pre-commit checks
echo "🪝 Installing lefthook git hooks..."
cd "$WORKSPACE_DIR/turbo" && lefthook install
echo "✓ Lefthook hooks installed"

echo "✅ Dev container setup complete!"
