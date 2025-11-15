#!/bin/bash

# Simple setup script for dev container (based on uspark setup)
set -e

echo "🚀 Setting up dev container..."

# Setup PostgreSQL (handled by postgresql feature)
sudo chown -R postgres:postgres /var/lib/postgresql 2>/dev/null || true
sudo service postgresql start 2>/dev/null || true

# Setup directories - fix ownership for all mounted volumes
# This is the key difference - uspark fixes all directories at once
sudo mkdir -p /home/vscode/.local/bin
sudo chown -R vscode:vscode /home/vscode/.config /home/vscode/.cache /home/vscode/.local

# Setup Git to use GitHub CLI for authentication
echo "Configuring Git credential helper..."
gh auth setup-git 2>/dev/null || true

# Install dependencies
echo "Installing dependencies..."
cd /workspaces/vm0/turbo && pnpm install

echo "✅ Dev container ready!"