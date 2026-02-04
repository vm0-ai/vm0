#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup
echo "Setting up..."
rm -f vm0.yaml AGENTS.md

# Record
echo "Recording..."
~/Developer/vhs/vhs quickstart.tape

# Cleanup
echo "Cleaning up..."
rm -f vm0.yaml AGENTS.md

echo "Done!"
