#!/bin/bash

# Simple setup script for dev container (based on vm0 setup)
set -e

echo "🚀 Setting up dev container..."

# Get the workspace directory dynamically
# Script is in .devcontainer/setup.sh, so workspace is parent directory
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "📁 Workspace directory: $WORKSPACE_DIR"

# Clear repo-local build caches when recreating the dev container so stale
# Turbo/Next artifacts do not leak across environments.
echo "🧹 Cleaning Turbo/Next caches..."
TURBO_WORKSPACE_DIR="$WORKSPACE_DIR/turbo"
if [ -d "$TURBO_WORKSPACE_DIR" ]; then
  mapfile -t CACHE_DIRS < <(
    find "$TURBO_WORKSPACE_DIR" \
      \( -path '*/node_modules/*' -o -path "$TURBO_WORKSPACE_DIR/node_modules" \) -prune -o \
      \( -name .next -o -name .turbo \) -type d -print
  )

  if [ ${#CACHE_DIRS[@]} -eq 0 ]; then
    echo "✓ No repo-local Turbo/Next caches found"
  else
    rm -rf "${CACHE_DIRS[@]}"
    echo "✓ Removed ${#CACHE_DIRS[@]} repo-local Turbo/Next cache directories"
  fi
else
  echo "✓ Turbo workspace not found, skipping cache cleanup"
fi

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
  echo "127.0.0.1 vm7.ai www.vm7.ai app.vm7.ai platform.vm7.ai" | sudo tee -a /etc/hosts > /dev/null
  echo "✓ vm7.ai domains added to /etc/hosts"
else
  echo "✓ vm7.ai domains already in /etc/hosts"
fi

# Setup directories - fix ownership for all mounted volumes
sudo mkdir -p \
  /home/vscode/.local/bin \
  /home/vscode/.local/lib \
  /home/vscode/.pki \
  /home/vscode/.codex \
  /home/vscode/.codex-switch \
  /home/vscode/.zed_server
sudo chown -R vscode:vscode \
  /home/vscode/.config \
  /home/vscode/.cache \
  /home/vscode/.local \
  /home/vscode/.pki \
  /home/vscode/.cloudflared \
  /home/vscode/.codex \
  /home/vscode/.codex-switch \
  /home/vscode/.zed_server
echo "✓ User-local mounted directories ready"

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

# Install lefthook git hooks for pre-commit checks
echo "🪝 Installing lefthook git hooks..."
cd "$WORKSPACE_DIR/turbo" && lefthook install
echo "✓ Lefthook hooks installed"

# Ensure VNC dependencies are installed (startup moved to start-vnc.sh via postStartCommand)
echo "🖥️ Checking VNC dependencies..."
MISSING=()
command -v x11vnc >/dev/null 2>&1 || MISSING+=(x11vnc)
command -v Xvfb >/dev/null 2>&1 || MISSING+=(xvfb)
command -v i3 >/dev/null 2>&1 || MISSING+=(i3)
command -v websockify >/dev/null 2>&1 || MISSING+=(novnc)
command -v xrandr >/dev/null 2>&1 || MISSING+=(x11-xserver-utils)
if [ ${#MISSING[@]} -gt 0 ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${MISSING[@]}"
fi
echo "✓ VNC dependencies ready"

echo "✅ Dev container setup complete!"
