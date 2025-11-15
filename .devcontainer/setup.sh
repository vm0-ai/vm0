#!/bin/bash
set -e

echo "Setting up VM0 development environment..."

# Create necessary directories
echo "Creating directories..."
mkdir -p /home/vscode/.local/bin
mkdir -p /home/vscode/.config
mkdir -p /home/vscode/.cache
mkdir -p /home/vscode/.local/share/pnpm

# Set correct ownership
sudo chown -R vscode:vscode /home/vscode

# Install global tools if not already installed
echo "Installing global tools..."
if ! command -v vercel &> /dev/null; then
    npm install -g vercel
fi

if ! command -v turbo &> /dev/null; then
    npm install -g turbo
fi

# Navigate to workspace
cd /workspaces/vm0

# Install project dependencies
if [ -d "turbo" ]; then
    echo "Installing project dependencies..."
    cd turbo
    pnpm install --frozen-lockfile

    # Setup database if needed
    if [ -f "packages/database/prisma/schema.prisma" ]; then
        echo "Setting up database..."
        pnpm db:generate || true
        pnpm db:push || true
    fi

    cd ..
fi

# Git configuration
git config --global --add safe.directory /workspaces/vm0

echo "Development environment setup complete!"
echo ""
echo "Quick commands:"
echo "  cd turbo          - Navigate to monorepo"
echo "  pnpm dev          - Start development servers"
echo "  pnpm test         - Run tests"
echo "  pnpm lint         - Run linting"
echo "  pnpm build        - Build all apps"
echo ""
echo "Database URL: postgresql://postgres:postgres@localhost:5432/postgres"