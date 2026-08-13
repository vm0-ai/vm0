#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/turbo.yml"
RUNNER_TESTS="${REPO_ROOT}/e2e/tests/03-runner"
RUNNER_HELPERS=(
  "${REPO_ROOT}/e2e/helpers/runner-api.bash"
  "${REPO_ROOT}/e2e/helpers/runner-chat.bash"
)
RUNNER_TOKEN="${REPO_ROOT}/e2e/playwright/runner-token.ts"
RUNNER_MOCK_CLAUDE_BOOTSTRAP="${REPO_ROOT}/e2e/playwright/runner-mock-claude-bootstrap.bash"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

grep -Fq "local RUNNER_DIRNAME=\"\${RUNNER_DIR##*/}\"" "$WORKFLOW" ||
  fail "runner config dirname must come from the manifest runner directory"
grep -Fq -- "--runner-dirname \${RUNNER_DIRNAME}" "$WORKFLOW" ||
  fail "runner config must be written beneath the manifest runner directory"
grep -Fq -- "--config \${RUNNER_DIR}/runner.yaml" "$WORKFLOW" ||
  fail "runner service must read the config from the manifest runner directory"
if grep -Fq -- "--runner-dirname \${RUNNER_SERVICE_REF}" "$WORKFLOW"; then
  fail "runner service identity must not select the manifest config directory"
fi
grep -Fq "RUNNER_SERVICE_REF: \${{ needs.prepare.outputs.job-ref }}" "$WORKFLOW" ||
  fail "runner service identity must follow the deployed API job ref"
grep -Fq "RUNNER_GROUP: \${{ format('vm0/development-{0}', needs.prepare.outputs.job-ref) }}" "$WORKFLOW" ||
  fail "runner group must match the deployed API default group"
if grep -Fq 'playwright-staging' "$WORKFLOW"; then
  fail "main Playwright runs must not use a group outside the staging API default"
fi
if grep -R -Fq '/api/test/' "$RUNNER_TESTS" "${RUNNER_HELPERS[@]}"; then
  fail "runner E2E coverage must use supported public APIs"
fi
grep -Fq 'startVideoOnboardingCheckout' "$RUNNER_TOKEN" ||
  fail "real runner accounts must upgrade through public paid onboarding"
grep -Fq 'fillStripeCheckout' "$RUNNER_TOKEN" ||
  fail "real runner accounts must complete the public Stripe checkout"
if [[ "$(grep -Fc 'upgradeToPro: true' "$RUNNER_TOKEN")" -ne 3 ]]; then
  fail "real Codex, real Claude, and mock Claude runner accounts must upgrade to Pro"
fi
if [[ "$(grep -Fc 'upgradeToPro: false' "$RUNNER_TOKEN")" -ne 1 ]]; then
  fail "the default mock runner account must remain on limited-free"
fi

ruby -ryaml - "$WORKFLOW" "$RUNNER_MOCK_CLAUDE_BOOTSTRAP" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
jobs = workflow.fetch("jobs")
prepare = jobs.fetch("prepare")
stripe_listener = jobs.fetch("deploy-stripe-listener")
playwright = jobs.fetch("cli-e2e-02-playwright")
account_prepare = jobs.fetch("cli-e2e-03-runner-prepare")
bootstrap = jobs.fetch("cli-e2e-03-runner-bootstrap")
runner = jobs.fetch("cli-e2e-03-runner")
account_cleanup = jobs.fetch("cli-e2e-03-runner-cleanup")

playwright_step_names = playwright.fetch("steps").map { |step| step["name"] }
browser_install_index = playwright_step_names.index("Install Playwright browsers")
fixture_test_index = playwright_step_names.index(
  "Run Playwright fixture integration tests",
)
unless browser_install_index && fixture_test_index &&
    browser_install_index < fixture_test_index
  raise "Playwright browsers must be installed before browser fixture tests"
end

unless prepare.dig("outputs", "turbo-runner-consumer-needed") ==
    "${{ steps.runner-e2e.outputs.turbo-runner-consumer-needed }}"
  raise "Turbo must expose the historical runner E2E consumer decision"
end
consumer_step = prepare.fetch("steps").find do |step|
  step["id"] == "runner-e2e"
end
unless consumer_step&.fetch("run", "")&.end_with?("runner-image-context.sh turbo-consumer")
  raise "Turbo must restore the historical runner E2E consumer detector"
end

stripe_listener_condition = stripe_listener.fetch("if")
stripe_listener_lines = stripe_listener_condition.lines.map(&:strip)
expected_stripe_listener_consumers = [
  "needs.prepare.outputs.turbo-runner-consumer-needed == 'true' ||",
  "needs.prepare.outputs.playwright-runner-consumer-needed == 'true'",
]
unless stripe_listener_lines.each_cons(2).include?(expected_stripe_listener_consumers)
  raise "Stripe forwarding must run for every deployed E2E consumer"
end

unless runner.dig("strategy", "fail-fast") == false
  raise "runner E2E shards must not fail fast"
end
expected_matrix = "${{ fromJSON(needs.cli-e2e-03-runner-prepare.outputs.runner-shard-matrix) }}"
unless runner.dig("strategy", "matrix") == expected_matrix
  raise "runner E2E must use the generated non-empty shard matrix"
end

expected_group = "cli-e2e-03-runner-${{ matrix.index }}-${{ needs.prepare.outputs.job-ref }}"
unless runner.dig("concurrency", "group") == expected_group
  raise "each runner E2E shard must keep its independent concurrency group"
end

required_needs = %w[
  prepare
  deploy-api
  deploy-runner-prepare
  deploy-runner-start
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
]
unless required_needs.all? { |job_name| Array(runner["needs"]).include?(job_name) }
  raise "runner E2E shards must wait for accounts, API, and runner deployment"
end

unless account_prepare.fetch("if").include?("turbo-runner-consumer-needed == 'true'")
  raise "runner E2E account preparation must use the runner E2E consumer"
end
unless runner.fetch("if").include?("turbo-runner-consumer-needed == 'true'")
  raise "runner E2E shards must use the runner E2E consumer"
end

%w[deploy-runner-prepare deploy-runner-start].each do |job_name|
  condition = jobs.fetch(job_name).fetch("if")
  unless condition.include?("turbo-runner-consumer-needed == 'true'") &&
      condition.include?("playwright-runner-consumer-needed == 'true'")
    raise "#{job_name} must serve both runner E2E and Playwright consumers"
  end
end

prepare_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Prepare runner E2E accounts"
end
raise "missing runner E2E account preparation" unless prepare_step
unless prepare_step.fetch("run").end_with?("runner-account.ts prepare")
  raise "runner E2E account preparation must use the shared lifecycle entry point"
end

unless %w[prepare deploy-api deploy-app deploy-stripe-listener].all? do |job_name|
    Array(account_prepare["needs"]).include?(job_name)
  end
  raise "runner E2E account preparation must wait for previews and Stripe forwarding"
end
unless account_prepare.fetch("if").include?(
    "github.event_name == 'push' || needs.deploy-stripe-listener.result == 'success'"
  )
  raise "runner E2E account preparation must use staging or preview Stripe forwarding"
end

expected_organization_outputs = {
  "runner-organization-id" => "runner-organization-id",
  "codex-organization-id" => "codex-organization-id",
  "claude-organization-id" => "claude-organization-id",
  "mock-claude-organization-id" => "mock-claude-organization-id",
}
expected_organization_outputs.each do |job_output, step_output|
  expected = "${{ steps.account.outputs.#{step_output} }}"
  unless account_prepare.dig("outputs", job_output) == expected
    raise "runner E2E account preparation must expose #{job_output}"
  end
end
unless account_prepare.dig("outputs", "runner-shard-matrix") ==
    "${{ steps.shards.outputs.matrix }}"
  raise "runner E2E preparation must expose the generated shard matrix"
end

shard_generation_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Generate runner E2E shard matrix"
end
raise "missing runner E2E shard generation" unless shard_generation_step
shard_generation_script = shard_generation_step.fetch("run")
unless shard_generation_step["id"] == "shards" &&
    shard_generation_script.include?("playwright/runner-shards.ts tests/03-runner") &&
    shard_generation_script.include?('length > 0 and length <= 12') &&
    shard_generation_script.include?('echo "matrix=$matrix" >> "$GITHUB_OUTPUT"')
  raise "runner E2E shard generation must use the tested executable and reject empty matrices"
end

token_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Generate runner E2E API tokens"
end
raise "missing runner E2E token generation" unless token_step
unless token_step.fetch("run").end_with?("runner-token.ts /tmp")
  raise "runner E2E tokens must use the public device-flow entry point"
end
unless token_step.dig("env", "OKOU_APP_URL") == "${{ needs.deploy-app.outputs.preview-url }}" &&
    token_step.dig("env", "ZERO_APP_URL") == "${{ needs.deploy-app.outputs.preview-url }}"
  raise "runner E2E token generation must emit both branded app preview URLs"
end
unless token_step.dig("env", "E2E_RUNNER_MOCK_CLAUDE_ORGANIZATION_ID") ==
    "${{ steps.account.outputs.mock-claude-organization-id }}"
  raise "runner E2E token generation must receive the mock Claude organization"
end

diagnostic_upload_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Upload runner E2E Checkout diagnostics"
end
raise "missing runner E2E Checkout diagnostic upload" unless diagnostic_upload_step
unless diagnostic_upload_step.fetch("if") == "failure()" &&
    diagnostic_upload_step.dig("with", "name") ==
      "runner-e2e-checkout-diagnostics" &&
    diagnostic_upload_step.dig("with", "path") ==
      "/tmp/e2e-runner-checkout-diagnostics" &&
    diagnostic_upload_step.dig("with", "if-no-files-found") == "ignore" &&
    diagnostic_upload_step.dig("with", "retention-days") == 1
  raise "runner E2E Checkout diagnostics must be failure-only and short-lived"
end

upload_step = account_prepare.fetch("steps").find do |step|
  step["name"] == "Upload runner E2E API tokens"
end
raise "missing runner E2E token artifact upload" unless upload_step
unless upload_step.dig("with", "name") == "e2e-tokens" &&
    upload_step.dig("with", "retention-days") == 1
  raise "runner E2E token artifact must retain the historical contract"
end
%w[
  e2e-api-credentials-runner.json
  e2e-api-credentials-runner-real-codex.json
  e2e-api-credentials-runner-real-claude.json
  e2e-api-credentials-runner-mock-claude.json
].each do |file_name|
  unless upload_step.dig("with", "path").include?(file_name)
    raise "runner E2E token artifact must include #{file_name}"
  end
end

unless Array(bootstrap["needs"]).include?("cli-e2e-03-runner-prepare")
  raise "runner bootstrap must wait for the token artifact"
end
bootstrap_steps = bootstrap.fetch("steps")
unless bootstrap_steps.any? do |step|
    step["uses"]&.start_with?("actions/checkout@")
  end
  raise "runner bootstrap must checkout the focused helper scripts"
end
unless bootstrap_steps.any? do |step|
    step["name"] == "Download runner E2E API tokens" &&
      step.dig("with", "name") == "e2e-tokens"
  end
  raise "runner bootstrap must download the token artifact"
end
model_defaults_step = bootstrap_steps.find do |step|
  step["name"] == "Reset runner model defaults"
end
raise "missing runner model policy bootstrap" unless model_defaults_step
model_defaults_script = model_defaults_step.fetch("run")
unless model_defaults_script.include?("/api/okou/model-policies") &&
    model_defaults_script.include?("/api/okou/user-model-preference") &&
    model_defaults_script.include?("deepseek-v4-flash") &&
    model_defaults_script.include?("gpt-5.6-luna") &&
    model_defaults_script.include?('{"selectedModel":null,"serviceTier":null}')
  raise "runner bootstrap must reset the limited-free model defaults"
end
%w[claude-opus-4-7 claude-sonnet-4-6 gpt-5.5].each do |restricted_model|
  if model_defaults_script.include?(restricted_model)
    raise "runner bootstrap must not select restricted model #{restricted_model}"
  end
end
provider_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap runner mock model provider"
end
raise "missing runner mock provider bootstrap" unless provider_step
unless provider_step.fetch("run").include?(
    '{"type":"claude-code-oauth-token","secret":"mock-oauth-token-for-e2e"}',
  )
  raise "runner bootstrap must restore the historical mock provider"
end
mock_claude_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap mock Claude account"
end
raise "missing mock Claude account bootstrap" unless mock_claude_step
unless mock_claude_step.fetch("run").end_with?(
    "runner-mock-claude-bootstrap.bash /tmp/e2e-api-credentials-runner-mock-claude.json",
  )
  raise "mock Claude account bootstrap must use the focused executable"
end
unless mock_claude_step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
    "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
  raise "mock Claude bootstrap must receive the preview bypass secret"
end
mock_claude_script = File.read(ARGV.fetch(1))
%w[
  /api/zero/me/model-providers
  /api/zero/model-policies
  /api/zero/feature-switches
  claude-code-oauth-token
  claude-sonnet-4-6
  realAgentInPreview
].each do |required_fragment|
  unless mock_claude_script.include?(required_fragment)
    raise "mock Claude bootstrap must include #{required_fragment}"
  end
end
unless mock_claude_script.include?(
    '.effectiveSwitches.realAgentInPreview == false',
  )
  raise "mock Claude bootstrap must keep the real runtime disabled"
end
unless mock_claude_script.include?('credentialScope: "member"') &&
    mock_claude_script.include?("modelProviderId: null")
  raise "mock Claude OAuth policy must use member credentials"
end
codex_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap real Codex account"
end
raise "missing real Codex account bootstrap" unless codex_step
codex_script = codex_step.fetch("run")
%w[
  /api/okou/model-providers
  /api/okou/model-policies
  /api/okou/feature-switches
  gpt-5.6-luna
  realAgentInPreview
].each do |required_fragment|
  unless codex_script.include?(required_fragment)
    raise "real Codex bootstrap must include #{required_fragment}"
  end
end
unless codex_step.dig("env", "OPENAI_API_KEY") ==
    "${{ secrets.OPENAI_API_KEY }}"
  raise "real Codex bootstrap must receive the OpenAI credential"
end
claude_step = bootstrap_steps.find do |step|
  step["name"] == "Bootstrap real Claude account"
end
raise "missing real Claude account bootstrap" unless claude_step
claude_script = claude_step.fetch("run")
%w[
  /api/okou/model-providers
  /api/okou/model-policies
  /api/okou/feature-switches
  claude-sonnet-4-6
  realAgentInPreview
].each do |required_fragment|
  unless claude_script.include?(required_fragment)
    raise "real Claude bootstrap must include #{required_fragment}"
  end
end
unless claude_step.dig("env", "ANTHROPIC_API_KEY") ==
    "${{ secrets.CI_ANTHROPIC_API_KEY }}"
  raise "real Claude bootstrap must receive the Anthropic credential"
end

shard_step = runner.fetch("steps").find do |step|
  step["name"] == "Initialize runner E2E shard"
end
raise "missing runner E2E shard scaffold" unless shard_step
unless runner.dig("env", "E2E_RUNNER_TEST_FILES_JSON") == "${{ toJSON(matrix.files) }}" &&
    runner.dig("env", "E2E_RUNNER_SHARD_TOTAL") == "${{ strategy.job-total }}"
  raise "runner E2E shards must receive their exact file list and dynamic total"
end
unless runner.dig("env", "E2E_RUNNER_MOCK_CLAUDE_ORG_ID") ==
    "${{ needs.cli-e2e-03-runner-prepare.outputs.mock-claude-organization-id }}" &&
    runner.dig("env", "E2E_RUNNER_MOCK_CLAUDE_EMAIL") ==
      "${{ needs.cli-e2e-03-runner-prepare.outputs.mock-claude-email }}"
  raise "runner E2E shards must receive the mock Claude identity"
end

run_step = runner.fetch("steps").find do |step|
  step.fetch("name", "").include?("Run runner E2E tests")
end
raise "missing runner E2E BATS execution" unless run_step
run_script = run_step.fetch("run")
unless run_script.include?('mapfile -t test_files') &&
    run_script.include?('BATS_TEST_TIMEOUT=240 ./test/libs/bats/bin/bats') &&
    run_script.include?('--report-formatter junit') &&
    run_script.include?('"${test_files[@]}"')
  raise "runner E2E must safely execute every matrix file with JUnit reporting"
end
unless run_step.dig("env", "VERCEL_AUTOMATION_BYPASS_SECRET") ==
    "${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"
  raise "runner E2E tests must receive the preview bypass secret"
end
unless runner.fetch("steps").any? do |step|
    step["name"] == "Download runner E2E API tokens" &&
      step.dig("with", "name") == "e2e-tokens"
  end
  raise "every runner shard must download the token artifact"
end
unless runner.fetch("steps").any? do |step|
    step["name"] == "Upload runner E2E JUnit XML" &&
      step.dig("with", "name") == "e2e-runner-junit-${{ matrix.index }}" &&
      step.dig("with", "retention-days") == 7
  end
  raise "every runner shard must upload its JUnit report"
end

cleanup_step = account_cleanup.fetch("steps").find do |step|
  step["name"] == "Cleanup runner E2E accounts"
end
raise "missing runner E2E account cleanup" unless cleanup_step
unless account_cleanup.fetch("if").include?("always()")
  raise "runner E2E account cleanup must run after shard failures"
end
unless Array(account_cleanup["needs"]).include?("cli-e2e-03-runner")
  raise "runner E2E account cleanup must wait for every shard"
end
unless cleanup_step.fetch("run").end_with?("runner-account.ts cleanup")
  raise "runner E2E account cleanup must use the shared lifecycle entry point"
end
if account_cleanup.fetch("if").include?("!= 'cancelled'")
  raise "runner E2E cleanup must run after cancelled account preparation"
end
%w[
  E2E_RUNNER_ORGANIZATION_ID
  E2E_RUNNER_CODEX_ORGANIZATION_ID
  E2E_RUNNER_CLAUDE_ORGANIZATION_ID
  E2E_RUNNER_MOCK_CLAUDE_ORGANIZATION_ID
].each do |environment_name|
  if cleanup_step.fetch("env", {}).key?(environment_name)
    raise "runner E2E cleanup must not depend on #{environment_name}"
  end
end

gate_needs = Array(jobs.fetch("ci-gate-turbo")["needs"])
%w[
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
  cli-e2e-03-runner
  cli-e2e-03-runner-cleanup
].each do |job_name|
  raise "CI gate must include #{job_name}" unless gate_needs.include?(job_name)
end

gate_step = jobs.fetch("ci-gate-turbo").fetch("steps").find do |step|
  step["name"] == "Validate CI results"
end
raise "missing Turbo CI gate validation" unless gate_step
gate_script = gate_step.fetch("run")
unless gate_script.include?("RUNNER_E2E_SKIP_ALLOWED=\"true\"") &&
    gate_script.include?("needs.prepare.outputs.turbo-runner-consumer-needed")
  raise "CI gate must restore the runner-specific E2E skip policy"
end
%w[
  cli-e2e-03-runner-prepare
  cli-e2e-03-runner-bootstrap
  cli-e2e-03-runner
  cli-e2e-03-runner-cleanup
].each do |job_name|
  expected = "check_result \"#{job_name}\" \"${{ needs.#{job_name}.result }}\" \"$RUNNER_E2E_SKIP_ALLOWED\""
  raise "CI gate must check #{job_name} with RUNNER_E2E_SKIP_ALLOWED" unless gate_script.include?(expected)
end
RUBY

echo "turbo-playwright-runner-workflow-test: ok"
