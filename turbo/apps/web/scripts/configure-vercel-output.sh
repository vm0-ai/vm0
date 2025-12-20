#!/bin/sh
# Configure Vercel Build Output based on VM0_EDITION
#
# For Community Edition: removes crons (Vercel Hobby Plan compatibility)
# For Cloud Edition: keeps crons for automatic sandbox cleanup

CONFIG_PATH="turbo/apps/web/.vercel/output/config.json"

# Only modify for community edition
if [ "$VM0_EDITION" != "community" ]; then
  echo "[configure-vercel-output] Edition: ${VM0_EDITION:-cloud (default)} - keeping crons"
  exit 0
fi

# Check if config file exists
if [ ! -f "$CONFIG_PATH" ]; then
  echo "[configure-vercel-output] No .vercel/output/config.json found, skipping"
  exit 0
fi

# Remove crons using jq if available, otherwise use node
if command -v jq > /dev/null 2>&1; then
  jq 'del(.crons)' "$CONFIG_PATH" > "${CONFIG_PATH}.tmp" && mv "${CONFIG_PATH}.tmp" "$CONFIG_PATH"
  echo "[configure-vercel-output] Community Edition: removed crons from build output (jq)"
else
  # Fallback: use node to remove crons
  node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf-8'));
    delete config.crons;
    fs.writeFileSync('$CONFIG_PATH', JSON.stringify(config, null, 2));
  "
  echo "[configure-vercel-output] Community Edition: removed crons from build output (node)"
fi
