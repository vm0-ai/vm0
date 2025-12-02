/**
 * Mock Claude CLI script for testing
 * Executes the prompt as a bash command and outputs Claude-compatible JSONL
 * This allows e2e tests to run without calling the real Claude LLM API
 *
 * Special test prefixes:
 * - @fail:<message> - Simulate Claude failure, outputs message to stderr and exits with code 1
 */
export const MOCK_CLAUDE_SCRIPT = `#!/bin/bash
# mock-claude - Executes prompt as bash and outputs Claude-compatible JSONL
# Usage: mock-claude [options] <prompt>
# The prompt is executed as a bash command
#
# Special test prefixes:
#   @fail:<message> - Output message to stderr and exit with code 1

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

# Special test prefix: @fail:<message> - simulate Claude failure with stderr output
# Usage: mock-claude "@fail:Session not found"
# This outputs the message to stderr and exits with code 1
if [[ "$PROMPT" == @fail:* ]]; then
  ERROR_MSG="\${PROMPT#@fail:}"
  echo "$ERROR_MSG" >&2
  exit 1
fi

# Function to escape string for JSON
json_escape() {
  printf '%s' "$1" | jq -Rs .
}

# Get current working directory
CWD="$(pwd)"

# Create session history file for checkpoint compatibility
# Claude Code stores session history at: ~/.config/claude/projects/-{path}/{session_id}.jsonl
create_session_history() {
  local session_dir
  local project_name
  project_name=$(echo "$CWD" | sed 's|^/||' | sed 's|/|-|g')
  session_dir="$HOME/.config/claude/projects/-\${project_name}"
  mkdir -p "$session_dir"
  echo "$session_dir/\${SESSION_ID}.jsonl"
}

if [[ "$OUTPUT_FORMAT" == "stream-json" ]]; then
  # Create session history file path
  SESSION_HISTORY_FILE=$(create_session_history)

  # Output JSONL events in Claude format and write to session history

  # 1. System init event
  INIT_EVENT='{"type":"system","subtype":"init","cwd":"'"$CWD"'","session_id":"'"$SESSION_ID"'","tools":["Bash"],"model":"mock-claude"}'
  echo "$INIT_EVENT"
  echo "$INIT_EVENT" >> "$SESSION_HISTORY_FILE"

  # 2. Assistant text event
  TEXT_EVENT='{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Executing command..."}]},"session_id":"'"$SESSION_ID"'"}'
  echo "$TEXT_EVENT"
  echo "$TEXT_EVENT" >> "$SESSION_HISTORY_FILE"

  # 3. Assistant tool_use event
  ESCAPED_PROMPT=$(json_escape "$PROMPT")
  TOOL_USE_EVENT='{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_mock_001","name":"Bash","input":{"command":'$ESCAPED_PROMPT'}}]},"session_id":"'"$SESSION_ID"'"}'
  echo "$TOOL_USE_EVENT"
  echo "$TOOL_USE_EVENT" >> "$SESSION_HISTORY_FILE"

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
  TOOL_RESULT_EVENT='{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_mock_001","content":'$ESCAPED_OUTPUT',"is_error":'$IS_ERROR'}]},"session_id":"'"$SESSION_ID"'"}'
  echo "$TOOL_RESULT_EVENT"
  echo "$TOOL_RESULT_EVENT" >> "$SESSION_HISTORY_FILE"

  # 6. Result event
  if [[ $EXIT_CODE -eq 0 ]]; then
    RESULT_EVENT='{"type":"result","subtype":"success","is_error":false,"duration_ms":100,"num_turns":1,"result":'$ESCAPED_OUTPUT',"session_id":"'"$SESSION_ID"'","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
  else
    RESULT_EVENT='{"type":"result","subtype":"error","is_error":true,"duration_ms":100,"num_turns":1,"result":'$ESCAPED_OUTPUT',"session_id":"'"$SESSION_ID"'","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}'
  fi
  echo "$RESULT_EVENT"
  echo "$RESULT_EVENT" >> "$SESSION_HISTORY_FILE"

  exit $EXIT_CODE
else
  # Plain text output - just execute the prompt
  bash -c "$PROMPT"
  exit $?
fi
`;
