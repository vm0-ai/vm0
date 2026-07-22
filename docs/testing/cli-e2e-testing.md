# CLI and Runner E2E Testing

## Scope

E2E tests verify deployed API, runner, sandbox, storage, and agent-framework
integration. They do not recreate the retired `vm0` CLI.

Use the `zero` binary in E2E only for unauthenticated package smoke checks such
as `zero --help` and `zero --version`. Host-side fixture setup and inspection
must call the API through the shared Bash helpers.

## E2E-only credentials

CI provides two explicit variables:

- `E2E_API_TOKEN`: a user-scoped PAT issued only for test infrastructure
- `E2E_API_URL`: the deployed API endpoint used by the test

These credentials are confined to CI and `e2e/helpers`.

- Do not expose them as `ZERO_TOKEN`.
- Do not write them to `~/.vm0/config.json`.
- Do not pass them to the `zero` binary.
- Do not fall back to `VM0_TOKEN` or another product credential.
- Missing credentials must fail the test immediately.

`ZERO_TOKEN` is reserved for the genuine run-scoped sandbox token issued to a
Zero agent. Its capabilities and lifecycle differ from the E2E PAT.

## Shared Bash API boundary

Load `e2e/helpers/setup.bash` and use its shared functions:

- `e2e_api_curl`: authenticated API requests
- `seed_storage_fixture`: prepare and commit storage fixtures
- `seed_compose_fixture`: create compose fixtures
- `create_run_fixture`: create a run and return structured JSON
- `continue_run_fixture`: continue a saved session
- `resume_run_fixture`: resume a previous run
- `cancel_run_fixture`: cancel a run
- `wait_for_run_fixture`: poll to a terminal status
- `run_compose_fixture`: create, wait, and print structured run output
- `fetch_run_log`: retrieve structured agent events or telemetry logs

The helpers own authentication, Vercel bypass headers, pagination, response
validation, and retry behavior. Tests should not duplicate that transport
logic.

## Basic runner test

```bash
#!/usr/bin/env bats

load '../../helpers/setup'

setup_file() {
    export TEST_DIR="$(mktemp -d)"
    export AGENT_NAME="e2e-example-$(date +%s%3N)-$RANDOM"

    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  $AGENT_NAME:
    description: "Runner E2E example"
    framework: claude-code
EOF

    seed_compose_fixture "$TEST_DIR/vm0.yaml" >/dev/null
}

teardown_file() {
    rm -rf "$TEST_DIR"
}

@test "agent completes through the structured API driver" {
    run run_compose_fixture "$AGENT_NAME" "echo hello"

    assert_success
    assert_equal "$(run_fixture_field "$output" '.status')" "completed"
    assert_output --partial "hello"
    assert_output --partial '"subtype":"success"'
}
```

The first output line from `run_compose_fixture` is compact metadata JSON with
the run, session, checkpoint, conversation, status, and error fields. Remaining
lines are structured event payloads from the agent-event API. Assert on stable
fields and content rather than terminal rendering symbols.

## Continuation and state-sharing

Keep one remote run per BATS case when possible. When a behavior genuinely
depends on shared session state, keep the related turns in the same test or
persist the session ID explicitly:

```bash
run run_compose_fixture "$AGENT_NAME" "first turn"
assert_success
session_id=$(run_fixture_field "$output" '.sessionId')

run continue_run_fixture "$session_id" "second turn"
assert_success
```

Independent cases should create unique names and avoid relying on execution
order. Use `setup_file` only when the state is immutable or intentionally shared
by every case in that file.

## Log assertions

Use `wait_for_log` when telemetry is eventually consistent:

```bash
wait_for_log "$RUN_ID" --agent -- '"subtype":"init"'
wait_for_log "$RUN_ID" --system -- "Complete webhook acknowledged"
wait_for_log "$RUN_ID" --network -- "[github]"
```

Agent mode returns structured event payloads. System, metrics, and network modes
use their dedicated API routes and normalized helper output.

## Fixture setup

Use explicit helper functions for model providers, connectors, agents, secrets,
variables, and other prerequisites. Fixture setup is not a reason to invoke the
product CLI with an E2E PAT.

## Anti-patterns

- Mapping `E2E_API_TOKEN` to `ZERO_TOKEN`
- Reading `VM0_TOKEN` or `~/.vm0/config.json`
- Calling a retired `vm0` command
- Parsing human CLI prose for run identifiers
- Reimplementing authentication fallback in a test file
- Silently skipping when credentials are absent
- Stacking unrelated remote runs in one test

## Checklist

- The test exercises a deployed integration boundary.
- Shared API helpers perform all host-side authenticated operations.
- Assertions use structured response fields or stable event content.
- Names are unique under parallel execution.
- Cleanup is idempotent.
- Credential absence fails fast.
- No E2E PAT reaches the `zero` binary.
