#!/usr/bin/env bats

# Test Runner environment variable expansion
# Adapted from 02-parallel/t12-vm0-env-expansion.bats for runner execution
#
# This test verifies that:
# 1. Vars and secrets are expanded in agent environment
# 2. Secrets are masked in output
# 3. Missing secrets/vars cause appropriate errors

load '../../helpers/setup.bash'
load '../../helpers/ssh.bash'

# Unique agent name for this test file
AGENT_NAME="e2e-runner-t05"

# Test-specific setup
TEST_RUNNER_GROUP="e2e/env-test-$$"
RUNNER_PID_FILE="/tmp/vm0-runner-env-$$.pid"

# Setup runner config on AWS Metal
setup_runner_config() {
    local token="$1"
    local api_url="$2"

    ssh_run "cat > ${RUNNER_DIR}/runner.yaml << EOFCONFIG
name: e2e-env-runner
group: ${TEST_RUNNER_GROUP}
server:
  url: ${api_url}
  token: ${token}
sandbox:
  max_concurrent: 1
  vcpu: 2
  memory_mb: 512
firecracker:
  binary: /usr/local/bin/firecracker
  kernel: /opt/firecracker/vmlinux
  rootfs: /opt/firecracker/rootfs.ext4
EOFCONFIG"
}

# Start runner in background
start_runner() {
    local env_exports=""
    if [ -n "$VERCEL_AUTOMATION_BYPASS_SECRET" ]; then
        env_exports="export VERCEL_AUTOMATION_BYPASS_SECRET='${VERCEL_AUTOMATION_BYPASS_SECRET}' && "
    fi
    if [ -n "$USE_MOCK_CLAUDE" ]; then
        env_exports="${env_exports}export USE_MOCK_CLAUDE='${USE_MOCK_CLAUDE}' && "
    fi

    ssh_run "cd ${RUNNER_DIR} && ${env_exports}nohup node index.js start > /tmp/vm0-runner-env.log 2>&1 & echo \$! > ${RUNNER_PID_FILE}"
    sleep 3

    local pid=$(ssh_run "cat ${RUNNER_PID_FILE} 2>/dev/null || echo ''")
    if [ -z "$pid" ]; then
        echo "Failed to start runner"
        return 1
    fi
    echo "Runner started with PID: $pid"
}

# Stop runner
stop_runner() {
    local pid=$(ssh_run "cat ${RUNNER_PID_FILE} 2>/dev/null || echo ''")
    if [ -n "$pid" ]; then
        ssh_run "kill $pid 2>/dev/null || true"
        ssh_run "rm -f ${RUNNER_PID_FILE}"
    fi
}

# Get runner logs
get_runner_logs() {
    ssh_run "cat /tmp/vm0-runner-env.log 2>/dev/null || echo 'No logs'"
}

setup() {
    # Verify prerequisites
    if [[ -z "$RUNNER_DIR" ]]; then
        skip "RUNNER_DIR not set - runner was not deployed"
    fi

    if ! ssh_check; then
        skip "Remote instance not reachable"
    fi

    if [[ -z "$VM0_API_URL" ]]; then
        skip "VM0_API_URL not set"
    fi

    # Create unique test values
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export SECRET_VALUE="secret-value-${UNIQUE_ID}"
    export VAR_VALUE="var-value-${UNIQUE_ID}"
    export ARTIFACT_NAME="e2e-runner-env-${UNIQUE_ID}"
    export TEST_ARTIFACT_DIR="$(mktemp -d)"

    # Create inline config with runner and environment variables
    export TEST_CONFIG="$(mktemp --suffix=.yaml)"
    cat > "$TEST_CONFIG" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "E2E test agent for env expansion with runner"
    provider: claude-code
    experimental_runner:
      group: ${TEST_RUNNER_GROUP}
    working_dir: /home/user/workspace
    environment:
      TEST_VAR: "\${{ vars.testVar }}"
      TEST_SECRET: "\${{ secrets.TEST_SECRET }}"
    volumes:
      - claude-files:/home/user/.claude
volumes:
  claude-files:
    name: claude-files
    version: latest
EOF
}

teardown() {
    stop_runner

    if [ -n "$TEST_ARTIFACT_DIR" ] && [ -d "$TEST_ARTIFACT_DIR" ]; then
        rm -rf "$TEST_ARTIFACT_DIR"
    fi
    if [ -n "$TEST_CONFIG" ] && [ -f "$TEST_CONFIG" ]; then
        rm -f "$TEST_CONFIG"
    fi
    ssh_run "rm -f ${RUNNER_DIR}/runner.yaml" 2>/dev/null || true
}

# Helper to create artifact
setup_artifact() {
    mkdir -p "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    cd "$TEST_ARTIFACT_DIR/$ARTIFACT_NAME"
    $CLI_COMMAND artifact init --name "$ARTIFACT_NAME" >/dev/null 2>&1
    echo "test content" > test.txt
    $CLI_COMMAND artifact push >/dev/null 2>&1
}

# Helper to setup runner
setup_and_start_runner() {
    local cli_config_file="$HOME/.vm0/config.json"
    [ -f "$cli_config_file" ] || skip "CLI config not found"

    local token=$(cat "$cli_config_file" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/"token"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/')
    [ -n "$token" ] || skip "No token found"

    setup_runner_config "$token" "$VM0_API_URL"
    run start_runner
    assert_success
    sleep 5
}

@test "Runner env: compose agent with environment variables" {
    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success
    assert_output --partial "$AGENT_NAME"
}

@test "Runner env: expands vars and secrets via --secrets flag" {
    setup_and_start_runner
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running with --vars and --secrets..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success

    # Verify vars are expanded
    assert_output --partial "VAR=${VAR_VALUE}"

    # Verify secrets are masked
    assert_output --partial "SECRET=***"
    refute_output --partial "SECRET=${SECRET_VALUE}"

    get_runner_logs
}

@test "Runner env: loads secrets from environment variables" {
    setup_and_start_runner
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running with secret in environment..."
    export TEST_SECRET="${SECRET_VALUE}"
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo VAR=\$TEST_VAR && echo SECRET=\$TEST_SECRET"

    echo "# Output:"
    echo "$output"

    assert_success
    assert_output --partial "VAR=${VAR_VALUE}"
    assert_output --partial "SECRET=***"

    get_runner_logs
}

@test "Runner env: fails when required secret is missing" {
    setup_and_start_runner
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running without providing secret..."
    unset TEST_SECRET

    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=somevalue" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"

    echo "# Output:"
    echo "$output"

    assert_failure
    assert_output --partial "Missing required secrets"
    assert_output --partial "TEST_SECRET"

    get_runner_logs
}

@test "Runner env: fails when required vars are missing" {
    setup_and_start_runner
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Running without providing vars..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo hello"

    echo "# Output:"
    echo "$output"

    assert_failure
    assert_output --partial "Missing required"
    assert_output --partial "testVar"

    get_runner_logs
}

@test "Runner env: continue requires secrets to be re-provided" {
    setup_and_start_runner
    setup_artifact

    run $CLI_COMMAND compose "$TEST_CONFIG"
    assert_success

    echo "# Step 1: Initial run with secrets..."
    run timeout 120s $CLI_COMMAND run "$AGENT_NAME" \
        --vars "testVar=${VAR_VALUE}" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        --artifact-name "$ARTIFACT_NAME" \
        "echo INITIAL && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "INITIAL"
    assert_output --partial "SECRET=***"

    echo "# Step 2: Extract session ID..."
    SESSION_ID=$(echo "$output" | grep -oP 'Session:\s*\K[a-f0-9-]{36}' | head -1)
    [ -n "$SESSION_ID" ] || {
        echo "# Failed to extract session ID"
        get_runner_logs
        return 1
    }
    echo "# Session ID: $SESSION_ID"

    echo "# Step 3: Continue WITHOUT secrets should fail..."
    run timeout 120s $CLI_COMMAND run continue "$SESSION_ID" "echo CONTINUED"

    echo "# Output:"
    echo "$output"

    assert_failure
    assert_output --partial "Missing required secrets: TEST_SECRET"

    echo "# Step 4: Continue WITH secrets should succeed..."
    run timeout 120s $CLI_COMMAND run continue "$SESSION_ID" \
        --secrets "TEST_SECRET=${SECRET_VALUE}" \
        "echo CONTINUED && echo SECRET=\$TEST_SECRET"
    assert_success
    assert_output --partial "CONTINUED"
    assert_output --partial "SECRET=***"

    get_runner_logs
}
