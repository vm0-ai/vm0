#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" \
  "${repo_root}/.github/workflows/cleanup-stale.yml" <<'RUBY'
def named_step(job, name)
  job.fetch("steps").find { |step| step["name"] == name }
end

turbo = YAML.load_file(ARGV.fetch(0))
jobs = turbo.fetch("jobs")
deploy_app = jobs.fetch("deploy-app")
steps = deploy_app.fetch("steps")

%w[deploy-app deploy-cli].each do |job_name|
  job = jobs.fetch(job_name)
  if Array(job["needs"]).include?("detect-release")
    raise "#{job_name} must run independently of detect-release"
  end
  if job.fetch("if", "").include?("needs.detect-release")
    raise "#{job_name} condition must not depend on detect-release"
  end
end

find_step = lambda do |name|
  steps.find { |step| step["name"] == name } || raise("missing step: #{name}")
end

expected_candidate_sha = "${{ github.sha }}"
expected_concurrency_group = "deploy-app-#{expected_candidate_sha}"
unless deploy_app.fetch("concurrency").fetch("group") == expected_concurrency_group
  raise "deploy-app concurrency must use the checked merge candidate"
end

checkout_step = steps.find do |step|
  step.fetch("uses", "").start_with?("actions/checkout@")
end
raise "missing deploy-app checkout step" unless checkout_step
unless checkout_step.fetch("with").fetch("ref") == expected_candidate_sha
  raise "deploy-app must check out the merge candidate"
end

artifact_step = find_step.call("Resolve artifact commit SHA")
unless artifact_step.fetch("run").include?("resolve-build-commit-sha.sh")
  raise "deploy-app artifact identity must derive from the checked-out commit"
end

expected_deployment_url = "${{ steps.worker-deploy.outputs.url }}"
if deploy_app.fetch("outputs").key?("deployment-url")
  raise "deploy-app must not expose a second provider deployment URL"
end
unless deploy_app.fetch("outputs").fetch("preview-url") == expected_deployment_url
  raise "deploy-app preview-url must expose the deployed Worker version"
end

deploy_step = find_step.call("Deploy standalone app Worker preview")
if deploy_step.key?("if")
  raise "Worker version deployment must remain unconditional within deploy-app"
end
unless deploy_step.dig("env", "CLOUDFLARE_API_TOKEN") == "${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}"
  raise "Worker preview deployment must use the isolated Worker deploy token"
end
deploy_source = deploy_step.fetch("run")
unless deploy_source.include?("wrangler versions upload") &&
    deploy_source.include?('--preview-alias "$WORKER_PREVIEW_ALIAS"') &&
    deploy_source.include?("--env preview")
  raise "Worker preview deployment must upload an aliased preview environment version"
end
preview_enable_index = deploy_source.index('/workers/scripts/okou-app-preview/subdomain')
preview_upload_index = deploy_source.index("wrangler versions upload")
unless preview_enable_index && preview_upload_index && preview_enable_index < preview_upload_index
  raise "Worker preview URLs must be enabled before uploading the aliased version"
end
unless deploy_source.include?("Cloudflare-Workers-Script-Api-Date: 2025-08-01")
  raise "Worker preview configuration must use Cloudflare's current script API"
end

readiness_step = find_step.call("Wait for standalone app Worker readiness")
unless readiness_step.fetch("env").fetch("WORKER_URL") == expected_deployment_url
  raise "Worker readiness must probe the deployed preview URL"
end
readiness_source = readiness_step.fetch("run")
unless readiness_source.include?('${WORKER_URL%/}/sign-up')
  raise "Worker readiness must probe an application document"
end
unless readiness_source.include?('id="app-bootstrap-skeleton"')
  raise "Worker readiness must verify the application document marker"
end
unless readiness_source.include?("ready_passes >= 2")
  raise "Worker readiness must require consecutive successful passes"
end
unless readiness_source.include?('--output "$document_body"')
  raise "Worker readiness must fetch the application document in the parallel probe"
end
unless readiness_source.include?("probe_succeeded")
  raise "Worker readiness must retain curl transfer status"
end
if readiness_source.include?("2>/dev/null || true")
  raise "Worker readiness must not ignore curl transfer failures"
end

preview_step = find_step.call("Resolve app Worker preview URL")
raise "app preview step id changed" unless preview_step["id"] == "app-preview"
if preview_step.key?("if")
  raise "app Worker preview URL must be resolved on every deploy-app run"
end
unless preview_step.fetch("run").include?("CF_WORKERS_SUBDOMAIN") &&
    preview_step.fetch("run").include?("resolve-app-preview-url.sh")
  raise "app preview URL must use the configured Workers subdomain"
end

smoke_step = find_step.call("Smoke test standalone app Worker")
if smoke_step.key?("if")
  raise "Worker smoke test must run for every deployed app preview"
end
unless smoke_step.fetch("env").fetch("APP_PREVIEW_URL") == expected_deployment_url
  raise "Worker smoke test must use the deployed preview URL"
end
unless smoke_step.fetch("run").include?("verify-okou-app-runtime.sh")
  raise "Worker smoke test must verify the app runtime and SharedWorker proxy"
end

browser_e2e = jobs.fetch("cli-e2e-02-browser")
playwright_e2e = jobs.fetch("cli-e2e-02-playwright")
[browser_e2e, playwright_e2e].each do |job|
  unless Array(job["needs"]).include?("deploy-app")
    raise "deployed E2E must depend on deploy-app"
  end
  unless job.fetch("if").include?("needs.deploy-app.result == 'success'")
    raise "deployed E2E must wait for deploy-app success"
  end
end

browser_run = browser_e2e.fetch("steps").find do |step|
  step["name"] == "Run browser E2E tests"
end
raise "missing browser E2E run step" unless browser_run
browser_env = browser_run.fetch("env")
expected_downstream_preview = "${{ needs.deploy-app.outputs.preview-url }}"
unless browser_env.fetch("OKOU_AUTH_URL") == expected_downstream_preview
  raise "browser E2E must use the smoke-tested app Worker preview"
end
unless browser_env.fetch("OKOU_AUTH_REDIRECT_URL") == "#{expected_downstream_preview}/_/skeleton"
  raise "browser E2E redirect must stay on the app Worker preview"
end
expected_auth_domain = "${{ needs.prepare.outputs.api-preview-url != '' && format('{0}-api.{1}', needs.prepare.outputs.job-ref, vars.PREVIEW_DOMAIN || 'vm6.ai') || '' }}"
unless browser_env.fetch("OKOU_AUTH_DOMAIN") == expected_auth_domain
  raise "browser E2E auth domain must stay on the API preview"
end

playwright_run = playwright_e2e.fetch("steps").find do |step|
  step["name"] == "Run Playwright E2E tests"
end
raise "missing Playwright E2E run step" unless playwright_run
unless playwright_run.fetch("env").fetch("OKOU_APP_URL") == expected_downstream_preview
  raise "Playwright E2E must emit the app preview URL"
end

turbo_source = File.read(ARGV.fetch(0))
legacy_markers = [
  "CF_PREVIEW_GATEWAY_MODE",
  "resolve-app-preview-ingress-mode.sh",
  "manage-okou-pages-domain.sh",
  "Begin Cloudflare Pages custom preview domain validation",
  "Finalize Cloudflare Pages custom preview domain",
  "Deploy Cloudflare Pages preview",
  "CF_PAGES_DEPLOY_API_TOKEN",
]
legacy_markers.each do |marker|
  raise "legacy app preview ingress remains: #{marker}" if turbo_source.include?(marker)
end

cleanup_source = File.read(ARGV.fetch(1))
cleanup = YAML.load_file(ARGV.fetch(1))
expected_cleanup_concurrency = {
  "group" => "cleanup-pr-${{ github.event.pull_request.number }}",
  "cancel-in-progress" => true,
}
unless cleanup.fetch("concurrency") == expected_cleanup_concurrency
  raise "cleanup must deduplicate without cancelling the matching PR Turbo run"
end

pages_cleanup = cleanup.fetch("jobs").fetch("cleanup-app-pages-deployments")
pages_cleanup_steps = pages_cleanup.fetch("steps")
unless pages_cleanup.fetch("permissions") == {
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "app Pages cleanup must have only the permissions needed for the owner barrier"
end
pages_cleanup_handoff = named_step(pages_cleanup, "Wait for active CI owners before app Pages cleanup")
raise "missing app Pages owner barrier" unless pages_cleanup_handoff
unless pages_cleanup_handoff.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    pages_cleanup_handoff.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    pages_cleanup_handoff.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}" &&
    pages_cleanup_handoff.dig("env", "PR_NUMBER") == "${{ github.event.pull_request.number }}" &&
    pages_cleanup_handoff.dig("env", "RUNNER_OWNER_SCOPE") == "closed-pr-cleanup" &&
    pages_cleanup_handoff.fetch("run") == ".github/scripts/cancel-superseded-merge-group-runs.sh" &&
    !pages_cleanup_handoff.key?("continue-on-error")
  raise "app Pages cleanup owner barrier must wait without cancelling or swallowing failures"
end
pages_cleanup_step = named_step(pages_cleanup, "Delete Cloudflare Pages app preview deployments")
raise "missing app Pages deployment cleanup step" unless pages_cleanup_step
unless pages_cleanup_step.fetch("run").include?("delete-okou-pages-preview-deployments.sh")
  raise "app Pages cleanup must use the audited deletion script"
end
unless pages_cleanup_step.fetch("env").fetch("PAGES_BRANCH") == "pr-${{ github.event.pull_request.number }}-app"
  raise "app Pages cleanup branch must derive only from the closed PR number"
end
pages_cleanup_names = pages_cleanup_steps.map { |step| step["name"] }
unless pages_cleanup_names.index("Wait for active CI owners before app Pages cleanup") <
    pages_cleanup_names.index("Delete Cloudflare Pages app preview deployments")
  raise "app Pages deletion must wait for active same-PR publishers"
end

stale_cleanup = YAML.load_file(ARGV.fetch(2)).fetch("jobs").fetch("cleanup-app-pages-deployments")
unless stale_cleanup.fetch("permissions") == {
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "stale app Pages cleanup must have only the permissions needed for the owner barrier"
end
stale_checkout = stale_cleanup.fetch("steps").find do |step|
  step.fetch("uses", "").start_with?("actions/checkout@")
end
unless stale_checkout&.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    stale_checkout&.dig("with", "persist-credentials") == false
  raise "stale app Pages cleanup must execute trusted default-branch scripts"
end
stale_step = named_step(stale_cleanup, "Cleanup stale Cloudflare Pages app preview deployments")
raise "missing stale app Pages deployment cleanup step" unless stale_step
unless stale_step.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    stale_step.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    stale_step.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}" &&
    stale_step.dig("env", "DRY_RUN") == "${{ env.DRY_RUN }}"
  raise "stale app Pages cleanup must receive owner API and dry-run context"
end
stale_source = stale_step.fetch("run")
list_index = stale_source.index("list-okou-pages-preview-pr-numbers.sh")
dry_run_index = stale_source.index('if [ "$DRY_RUN" = "true" ]')
handoff_index = stale_source.index("RUNNER_OWNER_SCOPE=closed-pr-cleanup")
delete_index = stale_source.index("delete-okou-pages-preview-deployments.sh")
unless list_index && dry_run_index && handoff_index && delete_index &&
    list_index < dry_run_index && dry_run_index < handoff_index && handoff_index < delete_index &&
    stale_source.scan('PR_STATE="$(resolve_pr_state "$PR_NUMBER")"').length == 2
  raise "stale app Pages cleanup must discover actual branches, await publishers, revalidate, then delete"
end

legacy_cleanup_markers = [
  "cleanup-okou-pages-domain",
  "cleanup-legacy-preview-www",
  "manage-okou-pages-domain.sh",
  "manage-cloudflare-worker-route.sh",
  "delete-cloudflare-worker.sh",
]
legacy_cleanup_markers.each do |marker|
  raise "legacy preview cleanup remains: #{marker}" if cleanup_source.include?(marker)
end
RUBY

echo "app-preview-ingress-workflow tests passed"
