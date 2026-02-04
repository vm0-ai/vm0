#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup
echo "Setting up..."
# No setup needed for usage commands

# Record
echo "Recording..."
~/Developer/vhs/vhs usage.tape

# Cleanup
echo "Cleaning up..."
# No cleanup needed

echo "Done!"
