/**
 * Mock Claude CLI script for testing
 * Executes the prompt as a bash command and outputs Claude-compatible JSONL
 * This allows e2e tests to run without calling the real Claude LLM API
 */
export const MOCK_CLAUDE_SCRIPT = `#!/bin/bash
# mock-claude - Executes prompt as bash and outputs Claude-compatible JSONL
# Usage: mock-claude [options] <prompt>
# The prompt is executed as a bash command

set -o pipefail

SESSION_ID="mock-$(date +%s%N)"
PROMPT=""
OUTPUT_FORMAT="text"

# Parse arguments (same as real claude CLI)
while [[ $# -gt 0 ]]; do
  case $1 in
    --output-format)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    --print|--verbose|--dangerously-skip-permissions)
      # These flags are accepted but ignored
      shift
      ;;
    --resume)
      # Skip resume session id (not supported in mock)
      shift 2
      ;;
    -*)
      # Unknown option, skip
      shift
      ;;
    *)
      # Positional argument is the prompt
      PROMPT="$1"
      shift
      ;;
  esac
done

# Function to escape string for JSON
json_escape() {
  printf '%s' "$1" | jq -Rs .
}

# Get current working directory
CWD="$(pwd)"

if [[ "$OUTPUT_FORMAT" == "stream-json" ]]; then
  # Output JSONL events in Claude format

  # 1. System init event
  echo '{"type":"system","subtype":"init","cwd":"'"$CWD"'","session_id":"'"$SESSION_ID"'","tools":["Bash"],"model":"mock-claude"}'

  # 2. Assistant text event
  echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Executing command..."}]},"session_id":"'"$SESSION_ID"'"}'

  # 3. Assistant tool_use event
  ESCAPED_PROMPT=$(json_escape "$PROMPT")
  echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_mock_001","name":"Bash","input":{"command":'$ESCAPED_PROMPT'}}]},"session_id":"'"$SESSION_ID"'"}'

  # 4. Execute prompt as bash and capture output
  OUTPUT=$(bash -c "$PROMPT" 2>&1)
  EXIT_CODE=$?
  ESCAPED_OUTPUT=$(json_escape "$OUTPUT")

  # 5. User tool_result event
  if [[ $EXIT_CODE -eq 0 ]]; then
    IS_ERROR="false"
  else
    IS_ERROR="true"
  fi
  echo '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_mock_001","content":'$ESCAPED_OUTPUT',"is_error":'$IS_ERROR'}]},"session_id":"'"$SESSION_ID"'"}'

  # 6. Result event
  if [[ $EXIT_CODE -eq 0 ]]; then
    echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":100,"num_turns":1,"result":'$ESCAPED_OUTPUT',"session_id":"'"$SESSION_ID"'","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
  else
    echo '{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"num_turns":1,"result":'$ESCAPED_OUTPUT',"session_id":"'"$SESSION_ID"'","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
  fi

  exit $EXIT_CODE
else
  # Plain text output - just execute the prompt
  bash -c "$PROMPT"
  exit $?
fi
`;
