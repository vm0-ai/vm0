#!/bin/bash
set -e

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org"
    exit 1
fi

# Install
echo "Installing @vm0/cli..."
npm install -g @vm0/cli

echo "Done! Starting onboard..."
exec vm0 onboard
