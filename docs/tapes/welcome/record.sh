#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup
echo "Setting up..."
rm -rf vm0.yaml AGENTS.md artifact

# Record
echo "Recording..."
~/Developer/vhs/vhs welcome.tape

# Cleanup
echo "Cleaning up..."
rm -rf vm0.yaml AGENTS.md artifact

echo "Done!"
