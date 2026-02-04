#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup
echo "Setting up..."
rm -rf my-artifact

# Ensure agent-1 and agent-2 are composed (run from /tmp to avoid polluting this folder)
echo "Composing agent-1..."
(cd /tmp && rm -rf agent-1 && mkdir agent-1 && cd agent-1 && vm0 init -n agent-1 && vm0 compose vm0.yaml)

echo "Composing agent-2..."
(cd /tmp && rm -rf agent-2 && mkdir agent-2 && cd agent-2 && vm0 init -n agent-2 && vm0 compose vm0.yaml)

# Record
echo "Recording..."
~/Developer/vhs/vhs multi-agents.tape

# Cleanup
echo "Cleaning up..."
rm -rf my-artifact

echo "Done!"
