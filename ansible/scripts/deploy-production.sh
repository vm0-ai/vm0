#!/bin/bash
#
# Deploy VM0 Runner to Production
#
# This script is called from GitHub Actions to deploy runners
# to production metal instances using Ansible.
#
# Required environment variables:
#   AWS_METAL_RUNNER_HOSTS     - Comma-separated list of hosts
#   AWS_METAL_RUNNER_USER      - SSH username
#   AWS_METAL_RUNNER_SSH_KEY   - SSH private key content
#   OFFICIAL_RUNNER_SECRET     - Runner authentication secret
#   API_URL                    - Production API URL (e.g., https://app.vm0.dev)
#   RUNNER_BUNDLE_PATH         - Path to runner bundle tarball
#
# Optional environment variables:
#   DRAIN_TIMEOUT              - Max seconds to wait for drain (default: 86400)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(dirname "$SCRIPT_DIR")"

# Validate required environment variables
required_vars=(
  "AWS_METAL_RUNNER_HOSTS"
  "AWS_METAL_RUNNER_USER"
  "AWS_METAL_RUNNER_SSH_KEY"
  "OFFICIAL_RUNNER_SECRET"
  "API_URL"
  "RUNNER_BUNDLE_PATH"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "ERROR: Required environment variable $var is not set"
    exit 1
  fi
done

# Set up SSH key
SSH_KEY_FILE="/tmp/vm0-prod-runner.pem"
echo "$AWS_METAL_RUNNER_SSH_KEY" > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"

# Convert comma-separated hosts to Ansible inventory format
# "host1,host2" -> "host1,host2,"
INVENTORY="${AWS_METAL_RUNNER_HOSTS},"

echo "=== VM0 Production Runner Deployment ==="
echo "Hosts: $AWS_METAL_RUNNER_HOSTS"
echo "User: $AWS_METAL_RUNNER_USER"
echo "API URL: $API_URL"
echo "Bundle: $RUNNER_BUNDLE_PATH"
echo ""

# Run Ansible playbook
cd "$ANSIBLE_DIR"

ansible-playbook \
  -i "$INVENTORY" \
  playbooks/deploy-runner.yml \
  --private-key "$SSH_KEY_FILE" \
  -e "ansible_user=$AWS_METAL_RUNNER_USER" \
  -e "official_runner_secret=$OFFICIAL_RUNNER_SECRET" \
  -e "api_url=$API_URL" \
  -e "runner_bundle_path=$RUNNER_BUNDLE_PATH" \
  -e "drain_timeout=${DRAIN_TIMEOUT:-86400}" \
  -v

# Cleanup
rm -f "$SSH_KEY_FILE"

echo ""
echo "=== Deployment Complete ==="
