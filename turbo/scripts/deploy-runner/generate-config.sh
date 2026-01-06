#!/bin/bash
# Generate runner.yaml configuration
# This script runs in the CI container
#
# Usage: ./generate-config.sh <pr-number> <api-url> <output-file>
# Requires OFFICIAL_RUNNER_SECRET environment variable

set -e

PR_NUMBER="$1"
API_URL="$2"
OUTPUT_FILE="$3"

if [ -z "$PR_NUMBER" ] || [ -z "$API_URL" ] || [ -z "$OUTPUT_FILE" ]; then
  echo "Usage: $0 <pr-number> <api-url> <output-file>"
  exit 1
fi

# Use official runner group (vm0/* groups are for official runners)
RUNNER_GROUP="vm0/development-pr-${PR_NUMBER}"

# Use official runner token format
if [ -z "$OFFICIAL_RUNNER_SECRET" ]; then
  echo "ERROR: OFFICIAL_RUNNER_SECRET environment variable not set"
  exit 1
fi
TOKEN="vm0_official_${OFFICIAL_RUNNER_SECRET}"
echo "Using official runner token"

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
