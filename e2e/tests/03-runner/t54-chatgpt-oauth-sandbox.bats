#!/usr/bin/env bats

# E2E tests for the ChatGPT-OAuth Codex flow — sandbox-side assertions.
# Issue #11941, parent Epic #11872.
#
# Covers:
#   t54-1: codex agent run completes (Epic SC #2, happy path)
#   t54-2: sandbox auth.json contains only placeholders; no real OAuth
#          token strings appear in env / auth.json / writable filesystem.
#          THIS IS THE LOAD-BEARING TEST for Epic SC #4 + #5 — the entire
#          approach α (placeholder JWT + firewall-side replacement) is
#          proven safe by this test.
#   t54-7: sandbox cannot reach auth.openai.com (firewall denies — defense
#          in depth, per Epic risk row 2).
#
# All three use synthetic provider state seeded via /api/cli/auth/test-
# chatgpt-oauth (no real OpenAI account required). Codex CLI is allowed to
# run in mock mode — t54-1's happy-path assertion checks that the
# guest-agent's ChatGPT-mode bootstrap succeeds; the model-response side
# would require a real upstream and is deferred to a nightly job.

load '../../helpers/setup'
load '../../helpers/audit-sandbox'
load '../../helpers/chatgpt-oauth-setup'

# Codex bootstrap (auth.json fabrication, secrets resolution, mitm setup)
# runs once per sandbox; cold path can exceed default 120s.
export BATS_TEST_TIMEOUT=300

setup_file() {
    if [ -z "$VM0_API_URL" ]; then
        echo "VM0_API_URL not set" >&2
        return 1
    fi

    # High-entropy synthetic real-token strings. The audit grep asserts these
    # NEVER appear in any sandbox env / file / log. Using long random
    # identifiers keeps grep false-positive risk near zero.
    export CHATGPT_AUDIT_FORBIDDEN_ACCESS_TOKEN="REAL-AT-7f3a82d1-9b4c-4e5f-a1b2-c3d4e5f60718-DO-NOT-LEAK"
    export CHATGPT_AUDIT_FORBIDDEN_REFRESH_TOKEN="REAL-RT-1a2b3c4d-5e6f-7g8h-9i0j-k1l2m3n4o5p6-DO-NOT-LEAK"
    export CHATGPT_AUDIT_FORBIDDEN_ACCOUNT_ID="ws_REAL_ACCOUNT_$(date +%s%N)_DO_NOT_LEAK"
    # Note: shaped like a JWT (header.payload.signature) but with non-base64
    # body so Semgrep's JWT detection rule does not match this fixture.
    export CHATGPT_AUDIT_FORBIDDEN_ID_TOKEN="hdr-REAL-IDTOK-X9Z8Y7W6V5U4-DO-NOT-LEAK.body-payload.sig"

    export TEST_DIR="$(mktemp -d)"
    export UNIQUE_ID="$(date +%s%3N)-$RANDOM"
    export AGENT_NAME="e2e-chatgpt-sandbox-${UNIQUE_ID}"
    export AUDIT_ARTIFACT_NAME="e2e-chatgpt-audit-${UNIQUE_ID}"

    # Push audit-runner.sh as an artifact mounted into the sandbox at
    # /artifacts/audit-runner.sh. Same pattern as t27 for claude files.
    mkdir -p "$TEST_DIR/$AUDIT_ARTIFACT_NAME"
    cp "${BATS_TEST_DIRNAME}/../../fixtures/audit-runner.sh" \
        "$TEST_DIR/$AUDIT_ARTIFACT_NAME/audit-runner.sh"
    chmod +x "$TEST_DIR/$AUDIT_ARTIFACT_NAME/audit-runner.sh"
    cd "$TEST_DIR/$AUDIT_ARTIFACT_NAME"
    $VM0_CLI artifact init --name "$AUDIT_ARTIFACT_NAME" >/dev/null
    $VM0_CLI artifact push >/dev/null
    cd - >/dev/null

    # Enable feature switch (chatgptOauthProvider is staff-only off by default).
    enable_chatgpt_oauth_provider

    # Seed chatgpt-oauth-token model_provider with high-entropy synthetic tokens.
    # The seed endpoint sets tokenExpiresAt 10min in the future so the token
    # isn't refreshed mid-test.
    seed_chatgpt_oauth \
        "$CHATGPT_AUDIT_FORBIDDEN_ACCESS_TOKEN" \
        "$CHATGPT_AUDIT_FORBIDDEN_REFRESH_TOKEN" \
        "$CHATGPT_AUDIT_FORBIDDEN_ACCOUNT_ID" \
        "$CHATGPT_AUDIT_FORBIDDEN_ID_TOKEN"

    # Compose codex-framework agent that mounts the audit artifact.
    # OPENAI_API_KEY env declaration satisfies validateFrameworkApiKey for the
    # codex framework. The placeholder value is never used at runtime — the
    # chatgpt-oauth-token firewall injects real auth headers at egress —
    # but the validator requires the env key to be present (or the provider
    # to be a single-secret provider whose secretName matches; chatgpt-oauth-
    # token is multi-auth so getSecretNameForType returns undefined).
    cat > "$TEST_DIR/vm0.yaml" <<EOF
version: "1.0"
agents:
  ${AGENT_NAME}:
    description: "ChatGPT OAuth sandbox audit agent"
    framework: codex
    environment:
      OPENAI_API_KEY: "ignored-when-using-chatgpt-oauth-token-provider"
    artifacts:
      - ${AUDIT_ARTIFACT_NAME}:/artifacts
    working_dir: /home/user/workspace
EOF
    $VM0_CLI compose "$TEST_DIR/vm0.yaml" >/dev/null
}

teardown_file() {
    disable_chatgpt_oauth_provider
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
    fi
}

# Test 1 — happy path. Mock codex echoes the prompt; we just verify the
# guest-agent's ChatGPT-mode bootstrap succeeds and the agent run completes.
# Real-codex-against-real-ChatGPT happy path is deferred to a nightly job
# (per plan phase Q1 decision: A2 — synthetic + MSW for CI).
@test "t54-1: codex agent run completes with chatgpt-oauth provider" {
    run $VM0_CLI run "$AGENT_NAME" \
        -- "Reply with exactly RESULT=579"

    assert_success
    # Mock codex echoes the prompt back; the sentinel just proves the run
    # made it through the guest-agent bootstrap and reached the codex CLI.
    assert_output --partial "RESULT=579"
}

# Test 2 — placeholder-only sandbox state. Epic SC #4 + #5 — THE
# load-bearing test for the entire approach α.
#
# REQUIRES real codex. Mock codex (CI default) echoes the prompt verbatim
# and does not actually invoke the Bash tool, so audit-runner.sh never
# runs inside the sandbox and the audit JSON is never produced. The
# placeholder-claim half of this assertion is already covered by the Rust
# unit tests in crates/guest-agent/src/codex_auth.rs (which run on every
# CI). The end-to-end "no real token string in sandbox env/file" half
# requires a real codex run — deferred to the nightly real-account smoke
# job (per plan-phase Q1 decision: A2).
#
# When OPENAI_API_KEY is in CI env (nightly real-account job), this test
# runs and exercises the full audit. Otherwise it skips with a clear
# message so the load-bearing intent is documented in CI output.
@test "t54-2: sandbox auth.json contains only placeholders; no real tokens leak" {
    if [ -z "${E2E_CHATGPT_REAL_ACCOUNT_TOKENS:-}" ]; then
        skip "Requires REAL ChatGPT account tokens (synthetic seed produces 401 from real codex; mock codex doesn't invoke Bash tool). Placeholder claims covered by Rust tests in crates/guest-agent/src/codex_auth.rs. Run with E2E_CHATGPT_REAL_ACCOUNT_TOKENS=1 in nightly real-account job."
    fi

    audit_sandbox_via_agent "$AGENT_NAME"

    # The guest-agent's auth.json fabrication put the sandbox in ChatGPT
    # mode with placeholder JWT claims (Epic SC #4). All three ChatGPT-mode
    # signals must be present (defense in depth — see crates/guest-agent
    # /src/codex_auth.rs comments).
    assert_chatgpt_auth_mode
    assert_placeholder_account_id
    assert_openai_api_key_null

    # Defense-in-depth env var must be set so codex can't refresh from
    # inside the sandbox even if it wanted to.
    assert_refresh_url_override_set

    # Real OAuth token strings MUST NOT appear anywhere in the sandbox
    # (Epic SC #5). This grep covers env var values, auth.json contents,
    # and log/json/txt/env files in /home /tmp /var.
    assert_no_forbidden_hits

    # Out-of-band check: agent's run output must also be clean. Catches
    # leaks via stdout/stderr that the audit script can't see directly.
    assert_agent_output_no_forbidden_hits "$output"
}

# Test 7 — auth.openai.com denied from sandbox. The firewall config in
# turbo/packages/api-contracts/src/contracts/model-providers.ts:725-728
# adds an explicit deny on auth.openai.com for the chatgpt-oauth-token
# model provider. This is defense-in-depth: the guest-agent already
# overrides CODEX_REFRESH_TOKEN_URL_OVERRIDE to localhost:1, but if codex
# ever ignores the override, this firewall rule still prevents egress.
#
# REQUIRES real codex (mock codex doesn't run the curl command). Same
# rationale as t54-2 — skip when no OPENAI_API_KEY in env. Firewall
# rule existence is unit-tested at the api-contracts level.
@test "t54-7: sandbox cannot reach auth.openai.com" {
    if [ -z "${E2E_CHATGPT_REAL_ACCOUNT_TOKENS:-}" ]; then
        skip "Requires REAL ChatGPT account tokens (synthetic seed produces 401 from real codex). Firewall rule covered by api-contracts unit tests. Run with E2E_CHATGPT_REAL_ACCOUNT_TOKENS=1 in nightly real-account job."
    fi

    run $VM0_CLI run "$AGENT_NAME" \
        --debug-no-mock-codex \
        -- "Run this exact Bash command and include its output:
curl -sS -m 10 -o /tmp/curl-out.txt -w 'HTTP_CODE=%{http_code} EXIT=%{exitcode}' https://auth.openai.com/oauth/token; echo
cat /tmp/curl-out.txt 2>/dev/null || echo 'NO_RESPONSE_BODY'"

    assert_success
    # Firewall blocks → either non-2xx HTTP code, or curl exit non-zero
    # (connection refused / timeout). Tolerate any deny pattern; reject
    # only the explicit success case.
    refute_output --partial "HTTP_CODE=200"
    if echo "$output" | grep -qE "HTTP_CODE=(403|405|450|451|000|500|502|503)|EXIT=([1-9])|denied|blocked|refused|timed out"; then
        :
    else
        echo "Expected firewall to deny auth.openai.com; full output:" >&2
        echo "$output" >&2
        fail "auth.openai.com was reachable from sandbox — firewall deny not enforced"
    fi
}
