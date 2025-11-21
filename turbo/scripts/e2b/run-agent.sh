#!/bin/bash
#
# VM0 Claude Code Runner
# Executes Claude Code in E2B sandbox with webhook integration
#

set -e

# Validate required environment variables
if [ -z "$VM0_RUN_ID" ]; then
  echo "ERROR: VM0_RUN_ID not set"
  exit 1
fi

if [ -z "$VM0_PROMPT" ]; then
  echo "ERROR: VM0_PROMPT not set"
  exit 1
fi

if [ -z "$VM0_WEBHOOK_URL" ]; then
  echo "ERROR: VM0_WEBHOOK_URL not set"
  exit 1
fi

if [ -z "$VM0_WEBHOOK_TOKEN" ]; then
  echo "ERROR: VM0_WEBHOOK_TOKEN not set"
  exit 1
fi

# Determine working directory (default to /home/user/workspace)
WORKING_DIR="${VM0_WORKING_DIR:-/home/user/workspace}"
echo "Working directory: $WORKING_DIR"

# Create working directory if it doesn't exist
mkdir -p "$WORKING_DIR"
cd "$WORKING_DIR"

# Prepare Claude Code command
CLAUDE_CMD="claude"

# Check if resuming from checkpoint
if [ -n "$VM0_SESSION_ID" ]; then
  echo "Resuming from session: $VM0_SESSION_ID"
  CLAUDE_CMD="$CLAUDE_CMD -r $VM0_SESSION_ID"
else
  echo "Starting new session"
fi

# Add prompt
CLAUDE_CMD="$CLAUDE_CMD '$VM0_PROMPT'"

# Execute Claude Code
echo "Executing: $CLAUDE_CMD"
eval $CLAUDE_CMD

# Capture exit code
EXIT_CODE=$?

echo "Claude Code execution completed with exit code: $EXIT_CODE"
exit $EXIT_CODE
