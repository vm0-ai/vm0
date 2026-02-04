#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup
echo "Setting up..."
rm -f vm0.yaml schedule.yaml AGENTS.md
vm0 init -n demo-agent

# Record
echo "Recording..."
~/Developer/vhs/vhs schedule.tape

# Cleanup
echo "Cleaning up..."
rm -f vm0.yaml schedule.yaml AGENTS.md

echo "Done!"
