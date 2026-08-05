#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" <<'RUBY'
turbo = YAML.load_file(ARGV.fetch(0))
deploy_app = turbo.fetch("jobs").fetch("deploy-app")
steps = deploy_app.fetch("steps")

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
