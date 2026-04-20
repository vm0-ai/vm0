#!/bin/bash
set -e

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org"
    exit 1
fi

# Detect which package manager has vm0 installed
detect_package_manager() {
    if command -v pnpm &> /dev/null; then
        pnpm_bin=$(pnpm bin -g 2>/dev/null)
        if [ -n "$pnpm_bin" ] && [ -x "$pnpm_bin/vm0" ]; then
            echo "pnpm"
            return
        fi
    fi
    echo "npm"
}

# Install
pkg_manager=$(detect_package_manager)
echo "Installing @vm0/cli using $pkg_manager..."

case "$pkg_manager" in
    pnpm)
        pnpm add -g @vm0/cli
        ;;
    *)
        npm install -g @vm0/cli
        # Warn about orphaned pnpm binary
        if [ -x "${HOME}/.local/share/pnpm/vm0" ]; then
            echo "Warning: Found old vm0 in ~/.local/share/pnpm/. Consider removing it."
        fi
        ;;
esac

echo "Done! Starting onboard..."
exec vm0 onboard
