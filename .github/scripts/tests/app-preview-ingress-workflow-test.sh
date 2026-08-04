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

mode_step = find_step.call("Resolve app preview ingress mode")
raise "preview ingress step id changed" unless mode_step["id"] == "preview-ingress"
raise "preview ingress resolver missing" unless mode_step.fetch("run").include?("resolve-app-preview-ingress-mode.sh")

[
  "Begin Cloudflare Pages custom preview domain validation",
  "Finalize Cloudflare Pages custom preview domain",
].each do |name|
  condition = find_step.call(name).fetch("if")
  unless condition.include?("steps.preview-ingress.outputs.mode == 'legacy'")
    raise "#{name} must remain legacy-only"
  end
end

deploy_step = find_step.call("Deploy Cloudflare Pages preview")
if deploy_step.fetch("if", "").include?("preview-ingress")
  raise "Pages branch deployment must run in both ingress modes"
end

smoke_step = find_step.call("Smoke test app preview gateway")
unless smoke_step.fetch("if").include?("steps.preview-ingress.outputs.mode == 'gateway'")
  raise "gateway smoke test must be gateway-only"
end
unless smoke_step.fetch("run").include?("x-vm0-preview-gateway")
  raise "gateway smoke test must verify the gateway response header"
end

cleanup = File.read(ARGV.fetch(1))
unless cleanup.include?("manage-okou-pages-domain.sh") && cleanup.include?("delete")
  raise "legacy Pages cleanup drain must remain present"
end
RUBY

echo "app-preview-ingress-workflow tests passed"
