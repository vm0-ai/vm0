#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
browser_helper="${repo_root}/e2e/helpers/browser.bash"
browser_test="${repo_root}/e2e/tests/02-browser/brw-t01-platform-e2e.bats"

generated_email="$(
  JOB_REF="pr-123" \
    GITHUB_RUN_ID="8000" \
    GITHUB_RUN_ATTEMPT="2" \
    bash -c 'source "$1"; generate_test_email' _ "$browser_helper"
)"
if [[ "$generated_email" != "pr-123+clerk_test+8000-2+browser@vm0-e2e.ai" ]]; then
  echo "browser helper did not generate the canonical account" >&2
  exit 1
fi
if JOB_REF="invalid_ref" bash -c \
  'source "$1"; generate_test_email' _ "$browser_helper" >/dev/null 2>&1; then
  echo "browser helper accepted a JOB_REF that its cleanup rejects" >&2
  exit 1
fi

first_factor_barrier="$(
  bash -c '
    source "$1"
    wait_for_browser_target() {
      printf "%s\n" "$*"
    }
    wait_for_sign_in_email_code_ready
  ' _ "$browser_helper"
)"
for required_state in \
  "firstFactorVerification" \
  "strategy === 'email_code'" \
  "status === 'unverified'"; do
  if [[ "$first_factor_barrier" != *"$required_state"* ]]; then
    echo "browser helper does not wait for prepared email-code first factor" >&2
    exit 1
  fi
done

otp_call_log="$(mktemp)"
trap 'rm -f "$otp_call_log"' EXIT
OTP_CALL_LOG="$otp_call_log" bash -c '
  source "$1"
  wait_for_browser_target() {
    return 0
  }
  agent-browser() {
    printf "%s\n" "$*" >> "$OTP_CALL_LOG"
    if [[ "$1" == "get" && "$2" == "count" ]]; then
      printf "1\n"
    fi
  }
  enter_otp "424242"
' _ "$browser_helper"
expected_otp_calls=$'get count input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]\nfill input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"] 424242'
if [[ "$(<"$otp_call_log")" != "$expected_otp_calls" ]]; then
  echo "browser helper must leave OTP submission to Clerk" >&2
  exit 1
fi

if [[ "$(grep -c '^[[:space:]]*delete_e2e_account_if_exists' "$browser_test")" -ne 2 ]]; then
  echo "browser E2E must clean its exact account before and after the test" >&2
  exit 1
fi

ruby -ryaml - \
  "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" \
  "${repo_root}/.github/workflows/cleanup-stale.yml" <<'RUBY'
turbo = YAML.load_file(ARGV.fetch(0))
cleanup = YAML.load_file(ARGV.fetch(1))
stale = YAML.load_file(ARGV.fetch(2))

turbo_jobs = turbo.fetch("jobs")
browser = turbo_jobs.fetch("cli-e2e-02-browser")
browser_steps = browser.fetch("steps")
browser_run = browser_steps.find { |step| step["name"] == "Run browser E2E tests" }
browser_cleanup = browser_steps.find { |step| step["name"] == "Cleanup browser E2E account" }
raise "missing browser E2E execution" unless browser_run
raise "missing browser E2E account finalizer" unless browser_cleanup

expected_browser_email = "${{ needs.prepare.outputs.job-ref }}+clerk_test+${{ github.run_id }}-${{ github.run_attempt }}+browser@vm0-e2e.ai"
unless browser_run.dig("env", "E2E_ACCOUNT") == expected_browser_email &&
    browser_cleanup.dig("env", "E2E_ACCOUNT") == expected_browser_email
  raise "browser account must be scoped to the current run and attempt"
end
unless browser_cleanup.fetch("if") == "always()" &&
    browser_cleanup.fetch("run").include?("delete_e2e_account_if_exists")
  raise "browser account cleanup must always use the exact shared helper"
end

playwright = turbo_jobs.fetch("cli-e2e-02-playwright")
playwright_cleanup = playwright.fetch("steps").find do |step|
  step["name"] == "Cleanup Playwright E2E accounts"
end
raise "missing Playwright E2E account finalizer" unless playwright_cleanup
unless playwright_cleanup.fetch("if") == "always()" &&
    playwright_cleanup.fetch("run").include?("cleanup-generation playwright,paid-onboarding")
  raise "Playwright cleanup must always target only its current-generation roles"
end

runner_cleanup = turbo_jobs.fetch("cli-e2e-03-runner-cleanup")
runner_condition = runner_cleanup.fetch("if")
unless runner_condition.include?("always()") &&
    !runner_condition.include?("!= 'cancelled'")
  raise "runner cleanup must remain eligible after cancelled preparation"
end
runner_cleanup_steps = runner_cleanup.fetch("steps")
runner_scope_step = runner_cleanup_steps.find do |step|
  step["id"] == "cleanup-scope"
end
raise "missing runner E2E cleanup scope" unless runner_scope_step
unless runner_scope_step.dig("env", "PREPARE_RESULT") ==
    "${{ needs.cli-e2e-03-runner-prepare.result }}" &&
    runner_scope_step.dig("env", "RUNNER_RESULT") ==
      "${{ needs.cli-e2e-03-runner.result }}"
  raise "runner cleanup scope must use exact upstream results"
end
runner_generation_cleanup = runner_cleanup_steps.find do |step|
  step["name"] == "Cleanup current runner E2E generation"
end
runner_run_cleanup = runner_cleanup_steps.find do |step|
  step["name"] == "Cleanup runner E2E workflow run"
end
unless runner_generation_cleanup&.fetch("run", "")&.end_with?(
    "runner-account.ts cleanup-generation",
  ) && runner_generation_cleanup["if"] ==
    "steps.cleanup-scope.outputs.scope == 'generation'"
  raise "failed preparation must reconcile only its current generation"
end
unless runner_run_cleanup&.fetch("run", "")&.end_with?(
    "runner-account.ts cleanup-run",
  ) && runner_run_cleanup["if"] ==
    "steps.cleanup-scope.outputs.scope == 'run'"
  raise "successful runner work must reconcile its exact workflow run"
end
legacy_output_environment = %w[
  E2E_RUNNER_ORGANIZATION_ID
  E2E_RUNNER_CODEX_ORGANIZATION_ID
  E2E_RUNNER_CLAUDE_ORGANIZATION_ID
]
runner_account_cleanup_steps = [runner_generation_cleanup, runner_run_cleanup]
if runner_account_cleanup_steps.any? do |step|
    legacy_output_environment.any? { |name| step.fetch("env", {}).key?(name) }
  end
  raise "runner cleanup must not depend on complete preparation outputs"
end

closed_pr_cleanup = cleanup.fetch("jobs").fetch("cleanup-clerk-test-resources")
unless closed_pr_cleanup.dig("permissions", "contents") == "read"
  raise "closed-PR Clerk cleanup must use read-only repository permissions"
end
closed_pr_checkout = closed_pr_cleanup.fetch("steps").find do |step|
  step.fetch("uses", "").start_with?("actions/checkout@")
end
raise "missing trusted checkout for closed-PR Clerk cleanup" unless closed_pr_checkout
unless closed_pr_checkout.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    closed_pr_checkout.dig("with", "persist-credentials") == false
  raise "closed-PR Clerk cleanup must execute credential-free default-branch code"
end
closed_pr_step = closed_pr_cleanup.fetch("steps").find do |step|
  step["name"] == "Delete Clerk test resources for closed PR"
end
raise "missing closed-PR Clerk cleanup command" unless closed_pr_step
unless closed_pr_step.fetch("run").end_with?("clerk-test-resources.ts cleanup-job-ref") &&
    closed_pr_step.dig("env", "JOB_REF") == "pr-${{ github.event.pull_request.number }}"
  raise "closed-PR cleanup must use the tested strict JOB_REF selector"
end

stale_jobs = stale.fetch("jobs")
stale_cleanup = stale_jobs.fetch("cleanup-clerk-test-resources")
unless stale_cleanup.dig("permissions", "contents") == "read"
  raise "stale Clerk cleanup must use read-only repository permissions"
end
if stale_jobs.key?("cleanup-clerk-test-users") || stale_jobs.key?("cleanup-clerk-empty-orgs")
  raise "legacy Clerk cleanup jobs must be removed"
end
stale_checkout = stale_cleanup.fetch("steps").find do |step|
  step.fetch("uses", "").start_with?("actions/checkout@")
end
raise "missing trusted checkout for stale Clerk cleanup" unless stale_checkout
unless stale_checkout.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    stale_checkout.dig("with", "persist-credentials") == false
  raise "stale Clerk cleanup must execute credential-free default-branch code"
end
stale_non_runner_step = stale_cleanup.fetch("steps").find do |step|
  step["name"] == "Delete stale non-runner Clerk test resources"
end
stale_runner_step = stale_cleanup.fetch("steps").find do |step|
  step["name"] == "Delete stale runner Clerk test resources"
end
raise "missing non-runner stale Clerk cleanup command" unless stale_non_runner_step
raise "missing runner stale Clerk cleanup command" unless stale_runner_step
unless stale_non_runner_step.fetch("run").include?(
    "cleanup-stale browser,playwright,paid-onboarding --older-than-hours 6",
  ) && stale_non_runner_step.dig("env", "DRY_RUN") == "${{ env.DRY_RUN }}"
  raise "non-runner Clerk resources must retain the six-hour stale policy"
end
unless stale_runner_step.fetch("run").include?(
    "cleanup-stale runner,runner-real-codex,runner-real-claude,runner-mock-claude --older-than-hours 30",
  ) && stale_runner_step.dig("env", "DRY_RUN") == "${{ env.DRY_RUN }}"
  raise "runner resources must outlive the one-day token artifact"
end
runner_token_upload = turbo_jobs.fetch("cli-e2e-03-runner-prepare").fetch("steps").find do |step|
  step["name"] == "Upload runner E2E API tokens"
end
raise "missing runner token artifact upload" unless runner_token_upload
artifact_retention_hours = runner_token_upload.dig("with", "retention-days").to_i * 24
runner_stale_hours = stale_runner_step.fetch("run")[/--older-than-hours (\d+)/, 1]&.to_i
unless runner_stale_hours && runner_stale_hours > artifact_retention_hours
  raise "runner stale cleanup must start after token artifact expiry"
end

cleanup_sources = [File.read(ARGV.fetch(1)), File.read(ARGV.fetch(2))].join("\n")
if cleanup_sources.include?("api.clerk.com") ||
    cleanup_sources.include?("memberships?limit=1")
  raise "untested legacy Clerk deletion logic remains in maintenance workflows"
end
RUBY

echo "clerk-test-resource-workflow-test: ok"
