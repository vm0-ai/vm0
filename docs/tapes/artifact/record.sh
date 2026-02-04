#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup
echo "Setting up..."
rm -rf my-artifact

# Ensure compose-demo is composed
echo "Composing compose-demo..."
(cd /tmp && rm -rf compose-demo && mkdir compose-demo && cd compose-demo && vm0 init -n compose-demo && vm0 compose vm0.yaml)

# Record
echo "Recording..."
~/Developer/vhs/vhs artifact.tape

# Cleanup
echo "Cleaning up..."
rm -rf my-artifact

echo "Done!"
