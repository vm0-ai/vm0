#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/turbo.yml"

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

ruby -ryaml - "$WORKFLOW" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
jobs = workflow.fetch("jobs")
prepare = jobs.fetch("prepare")
account_prepare = jobs.fetch("cli-e2e-03-runner-prepare")
runner = jobs.fetch("cli-e2e-03-runner")
account_cleanup = jobs.fetch("cli-e2e-03-runner-cleanup")

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

expected_indices = (1..12).to_a
unless runner.dig("strategy", "fail-fast") == false
  raise "runner E2E shards must not fail fast"
end
unless runner.dig("strategy", "matrix", "index") == expected_indices
  raise "runner E2E must preserve the historical twelve-shard matrix"
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

shard_step = runner.fetch("steps").find do |step|
  step["name"] == "Initialize runner E2E shard"
end
raise "missing runner E2E shard scaffold" unless shard_step
if runner.fetch("steps").any? { |step| step.fetch("name", "").include?("Run runner E2E tests") }
  raise "runner E2E scaffold must not add test coverage yet"
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

gate_needs = Array(jobs.fetch("ci-gate-turbo")["needs"])
%w[
  cli-e2e-03-runner-prepare
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
  cli-e2e-03-runner
  cli-e2e-03-runner-cleanup
].each do |job_name|
  expected = "check_result \"#{job_name}\" \"${{ needs.#{job_name}.result }}\" \"$RUNNER_E2E_SKIP_ALLOWED\""
  raise "CI gate must check #{job_name} with RUNNER_E2E_SKIP_ALLOWED" unless gate_script.include?(expected)
end
RUBY

echo "turbo-playwright-runner-workflow-test: ok"
