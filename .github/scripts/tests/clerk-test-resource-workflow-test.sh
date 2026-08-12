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

expected_browser_email = "${{ format('{0}+clerk_test+{1}-{2}+browser@vm0-e2e.ai', matrix.runtime == 'vercel' && format('{0}-vercel', needs.prepare.outputs.job-ref) || needs.prepare.outputs.job-ref, github.run_id, github.run_attempt) }}"
unless browser_run.dig("env", "E2E_ACCOUNT") == expected_browser_email &&
    browser_cleanup.dig("env", "E2E_ACCOUNT") == expected_browser_email
  raise "browser account must be scoped to the runtime, current run, and attempt"
end
unless browser_cleanup.fetch("if") == "always()" &&
    browser_cleanup.fetch("run").include?("delete_e2e_account_if_exists")
  raise "browser account cleanup must always use the exact shared helper"
end

playwright = turbo_jobs.fetch("cli-e2e-02-playwright")
playwright_run = playwright.fetch("steps").find do |step|
  step["name"] == "Run Playwright E2E tests"
end
playwright_cleanup = playwright.fetch("steps").find do |step|
  step["name"] == "Cleanup Playwright E2E accounts"
end
raise "missing Playwright E2E execution" unless playwright_run
raise "missing Playwright E2E account finalizer" unless playwright_cleanup
expected_playwright_job_ref = "${{ matrix.runtime == 'vercel' && format('{0}-v{1}', needs.prepare.outputs.job-ref, matrix.shard) || format('{0}-c{1}', needs.prepare.outputs.job-ref, matrix.shard) }}"
unless playwright_run.dig("env", "JOB_REF") == expected_playwright_job_ref &&
    playwright_cleanup.dig("env", "JOB_REF") == expected_playwright_job_ref
  raise "Playwright execution and cleanup must share a compact runtime namespace"
end
max_length_owner = "pr-999999-v2+clerk_test+99999999999-9+paid-onboarding-deadbeef"
if max_length_owner.bytesize > 64
  raise "Playwright Clerk owner exceeds the email local-part limit"
end
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
runner_cleanup_step = runner_cleanup.fetch("steps").find do |step|
  step["name"] == "Cleanup runner E2E accounts"
end
raise "missing runner E2E account finalizer" unless runner_cleanup_step
unless runner_cleanup_step.fetch("run").end_with?("runner-account.ts cleanup")
  raise "runner cleanup must use generation reconciliation"
end
legacy_output_environment = %w[
  E2E_RUNNER_ORGANIZATION_ID
  E2E_RUNNER_CODEX_ORGANIZATION_ID
  E2E_RUNNER_CLAUDE_ORGANIZATION_ID
]
if legacy_output_environment.any? { |name| runner_cleanup_step.fetch("env", {}).key?(name) }
  raise "runner cleanup must not depend on complete preparation outputs"
end

closed_pr_cleanup = cleanup.fetch("jobs").fetch("cleanup-clerk-test-resources")
unless closed_pr_cleanup.dig("permissions", "contents") == "read"
  raise "closed-PR Clerk cleanup must use read-only repository permissions"
end
unless closed_pr_cleanup.dig("strategy", "matrix", "runtime") == %w[cloudflare vercel]
  raise "closed-PR Clerk cleanup must cover both runtime namespaces"
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
    closed_pr_step.dig("env", "JOB_REF") == "${{ matrix.runtime == 'vercel' && format('pr-{0}-vercel', github.event.pull_request.number) || format('pr-{0}', github.event.pull_request.number) }}"
  raise "closed-PR cleanup must use strict selectors for both runtime namespaces"
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
stale_step = stale_cleanup.fetch("steps").find do |step|
  step["name"] == "Delete stale marked Clerk test resources"
end
raise "missing stale Clerk cleanup command" unless stale_step
unless stale_step.fetch("run").include?("cleanup-stale --older-than-hours 6") &&
    stale_step.dig("env", "DRY_RUN") == "${{ env.DRY_RUN }}"
  raise "stale Clerk cleanup must retain the six-hour marker gate and dry-run"
end

cleanup_sources = [File.read(ARGV.fetch(1)), File.read(ARGV.fetch(2))].join("\n")
if cleanup_sources.include?("api.clerk.com") ||
    cleanup_sources.include?("memberships?limit=1")
  raise "untested legacy Clerk deletion logic remains in maintenance workflows"
end
RUBY

echo "clerk-test-resource-workflow-test: ok"
