#!/bin/bash
# Generate runner.yaml configuration
# This script runs in the CI container (has access to CLI token)
#
# Usage: ./generate-config.sh <pr-number> <api-url> <output-file>
# Reads token from ~/.vm0/config.json

set -e

PR_NUMBER="$1"
API_URL="$2"
OUTPUT_FILE="$3"

if [ -z "$PR_NUMBER" ] || [ -z "$API_URL" ] || [ -z "$OUTPUT_FILE" ]; then
  echo "Usage: $0 <pr-number> <api-url> <output-file>"
  exit 1
fi

RUNNER_GROUP="e2e-stable/pr-${PR_NUMBER}"

echo "Getting CLI token from ~/.vm0/config.json..."
TOKEN=$(jq -r '.token' ~/.vm0/config.json)
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: No token found in CLI config"
  exit 1
fi
echo "Token obtained successfully"

echo "Creating runner.yaml config..."
cat > "$OUTPUT_FILE" << EOF
name: e2e-runner-pr-${PR_NUMBER}
group: ${RUNNER_GROUP}
server:
  url: ${API_URL}
  token: ${TOKEN}
sandbox:
  max_concurrent: 4
  vcpu: 2
  memory_mb: 1024
  poll_interval_ms: 1000
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOF

echo "Config written to $OUTPUT_FILE"
