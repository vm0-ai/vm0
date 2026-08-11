#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" \
  "${repo_root}/.github/scripts/wait-okou-pages-readiness.sh" <<'RUBY'
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

expected_deployment_url = "${{ steps.pages-deploy.outputs.url }}"
if deploy_app.fetch("outputs").key?("deployment-url")
  raise "deploy-app must not expose the immutable Pages deployment URL"
end
expected_gateway_url = "${{ steps.app-preview.outputs.url }}"
unless deploy_app.fetch("outputs").fetch("preview-url") == expected_gateway_url
  raise "deploy-app preview-url must expose the app preview gateway"
end
expected_vercel_alias_url = "${{ steps.vercel-app-preview.outputs.url }}"
unless deploy_app.fetch("outputs").fetch("vercel-preview-url") == expected_vercel_alias_url
  raise "deploy-app must expose the isolated Vercel-backed Pages alias"
end

deploy_step = find_step.call("Deploy Cloudflare Pages preview")
if deploy_step.key?("if")
  raise "Pages branch deployment must remain unconditional within deploy-app"
end

readiness_step = find_step.call("Wait for Cloudflare Pages deployment readiness")
unless readiness_step.fetch("env").fetch("PAGES_URL") == expected_deployment_url
  raise "Pages readiness must probe the immutable deployment URL"
end
readiness_source = File.read(ARGV.fetch(2))
unless readiness_step.fetch("run").include?("wait-okou-pages-readiness.sh")
  raise "Pages readiness must use the shared readiness script"
end
unless readiness_source.include?('${pages_url}/sign-up')
  raise "Pages readiness must probe an application document"
end
unless readiness_source.include?('id="app-bootstrap-skeleton"')
  raise "Pages readiness must verify the application document marker"
end
unless readiness_source.include?("ready_passes >= 2")
  raise "Pages readiness must require consecutive successful passes"
end
unless readiness_source.include?('--output "$document_body"')
  raise "Pages readiness must fetch the application document in the parallel probe"
end
unless readiness_source.include?("probe_succeeded")
  raise "Pages readiness must retain curl transfer status"
end
if readiness_source.include?("2>/dev/null || true")
  raise "Pages readiness must not ignore curl transfer failures"
end

prepare_step = find_step.call("Prepare Cloudflare Pages preview")
prepare_run = prepare_step.fetch("run")
unless deploy_app.fetch("env").key?("CF_WORKERS_SUBDOMAIN")
  raise "Pages build must receive the Worker preview subdomain"
end
unless prepare_run.include?("-vm0-api-preview.${CF_WORKERS_SUBDOMAIN}.workers.dev")
  raise "Pages build must embed the stable API Worker preview alias"
end

vercel_prepare_step = find_step.call("Prepare Vercel-backed Cloudflare Pages preview")
vercel_prepare_run = vercel_prepare_step.fetch("run")
unless vercel_prepare_run.include?("-vercel-api.${PREVIEW_DOMAIN}")
  raise "Vercel-backed Pages build must embed the isolated Vercel API origin"
end
vercel_deploy_step = find_step.call("Deploy Vercel-backed Cloudflare Pages preview")
unless vercel_deploy_step.fetch("run").include?("deploy-okou-pages.sh")
  raise "Vercel-backed Pages preview must use the shared deployment script"
end
vercel_readiness_step = find_step.call("Wait for Vercel-backed Cloudflare Pages deployment readiness")
unless vercel_readiness_step.fetch("run").include?("wait-okou-pages-readiness.sh")
  raise "Vercel-backed Pages readiness must use the shared readiness script"
end
vercel_alias_step = find_step.call("Resolve Vercel-backed Pages preview URL")
unless vercel_alias_step.fetch("run").include?("CF_PAGES_PROJECT_NAME") &&
    vercel_alias_step.fetch("run").include?(".pages.dev")
  raise "Vercel-backed app preview must use its isolated Pages branch alias"
end
vercel_alias_readiness_step = find_step.call(
  "Wait for Vercel-backed Cloudflare Pages alias readiness"
)
unless vercel_alias_readiness_step.fetch("env").fetch("PAGES_URL") == expected_vercel_alias_url &&
    vercel_alias_readiness_step.fetch("run").include?("wait-okou-pages-readiness.sh")
  raise "Vercel-backed Pages alias must pass the shared readiness probe"
end

preview_step = find_step.call("Resolve app preview gateway URL")
raise "app preview step id changed" unless preview_step["id"] == "app-preview"
if preview_step.key?("if")
  raise "app preview gateway URL must be resolved on every deploy-app run"
end
unless preview_step.fetch("run").include?("CF_PAGES_PREVIEW_DOMAIN")
  raise "app preview URL must use the configured preview domain"
end

smoke_step = find_step.call("Smoke test app preview gateway")
unless smoke_step.fetch("if").include?("steps.app-preview.outputs.url != ''")
  raise "gateway smoke test must run for every stable app preview"
end
unless smoke_step.fetch("env").fetch("APP_PREVIEW_URL") == expected_gateway_url
  raise "gateway smoke test must use the stable app preview URL"
end
unless smoke_step.fetch("run").include?("x-vm0-preview-gateway")
  raise "gateway smoke test must verify the gateway response header"
end

browser_e2e = jobs.fetch("cli-e2e-02-browser")
playwright_e2e = jobs.fetch("cli-e2e-02-playwright")
[browser_e2e, playwright_e2e].each do |job|
  unless job.dig("strategy", "matrix", "runtime") == %w[cloudflare vercel]
    raise "deployed E2E must run both preview runtimes"
  end
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
unless browser_env.fetch("VM0_AUTH_URL").include?("matrix.runtime == 'vercel'") &&
    browser_env.fetch("VM0_AUTH_URL").include?("vercel-preview-url") &&
    browser_env.fetch("VM0_AUTH_URL").include?("preview-url")
  raise "browser E2E must select the smoke-tested app preview for each runtime"
end
unless browser_env.fetch("VM0_AUTH_REDIRECT_URL").include?("/_/skeleton")
  raise "browser E2E redirect must stay on the selected app preview"
end

playwright_run = playwright_e2e.fetch("steps").find do |step|
  step["name"] == "Run Playwright E2E tests"
end
raise "missing Playwright E2E run step" unless playwright_run
expected_runtime_app_url = "${{ matrix.runtime == 'vercel' && needs.deploy-app.outputs.vercel-preview-url || needs.deploy-app.outputs.preview-url }}"
unless playwright_run.fetch("env").fetch("OKOU_APP_URL") == expected_runtime_app_url &&
    playwright_run.fetch("env").fetch("ZERO_APP_URL") == expected_runtime_app_url
  raise "Playwright E2E must emit both branded URLs for the selected runtime gateway"
end

turbo_source = File.read(ARGV.fetch(0))
legacy_markers = [
  "CF_PREVIEW_GATEWAY_MODE",
  "resolve-app-preview-ingress-mode.sh",
  "manage-okou-pages-domain.sh",
  "Begin Cloudflare Pages custom preview domain validation",
  "Finalize Cloudflare Pages custom preview domain",
]
legacy_markers.each do |marker|
  raise "legacy app preview ingress remains: #{marker}" if turbo_source.include?(marker)
end

cleanup_source = File.read(ARGV.fetch(1))
cleanup = YAML.load_file(ARGV.fetch(1))
expected_cleanup_group = "pr-${{ github.event.pull_request.number }}"
unless cleanup.fetch("concurrency").fetch("group") == expected_cleanup_group
  raise "cleanup must cancel the matching PR Turbo run before deleting Pages deployments"
end

pages_cleanup = cleanup.fetch("jobs").fetch("cleanup-app-pages-deployments")
pages_cleanup_steps = pages_cleanup.fetch("steps")
pages_cleanup_step = pages_cleanup_steps.find do |step|
  step["name"] == "Delete Cloudflare Pages app preview deployments"
end
raise "missing app Pages deployment cleanup step" unless pages_cleanup_step
unless pages_cleanup_step.fetch("run").include?("delete-okou-pages-preview-deployments.sh")
  raise "app Pages cleanup must use the audited deletion script"
end
unless pages_cleanup_step.fetch("env").fetch("PR_NUMBER") == "${{ github.event.pull_request.number }}" &&
    pages_cleanup_step.fetch("run").include?('"pr-${PR_NUMBER}-app"') &&
    pages_cleanup_step.fetch("run").include?('"pr-${PR_NUMBER}-vercel-app"')
  raise "app Pages cleanup must delete both branches derived from the closed PR number"
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
