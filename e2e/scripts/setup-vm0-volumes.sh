#!/bin/bash
set -e

# Setup VM0 volumes for E2E tests
# This script is run in CI environment after CLI authentication

echo "Setting up VM0 test volumes..."

# Create temporary directory for volume content
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Create claude-files volume with CLAUDE.md
echo "Creating claude-files volume..."
mkdir -p "$TEMP_DIR/claude-files"
cat > "$TEMP_DIR/claude-files/CLAUDE.md" << 'EOF'
This is a test file for the claude-files volume.
EOF

# Initialize and push the volume
cd "$TEMP_DIR/claude-files"
vm0 volume init
vm0 volume push

echo "VM0 test volumes setup complete!"
