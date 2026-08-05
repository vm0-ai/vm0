#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" <<'RUBY'
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

expected_output = "${{ steps.pages-deploy.outputs.url }}"
unless deploy_app.fetch("outputs").fetch("deployment-url") == expected_output
  raise "deploy-app deployment-url output changed"
end

deploy_step = find_step.call("Deploy Cloudflare Pages preview")
if deploy_step.key?("if")
  raise "Pages branch deployment must remain unconditional within deploy-app"
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
unless smoke_step.fetch("run").include?("x-vm0-preview-gateway")
  raise "gateway smoke test must verify the gateway response header"
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
unless pages_cleanup_step.fetch("env").fetch("PAGES_BRANCH") == "pr-${{ github.event.pull_request.number }}-app"
  raise "app Pages cleanup branch must derive only from the closed PR number"
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
