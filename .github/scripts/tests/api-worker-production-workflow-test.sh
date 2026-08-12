#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)

ruby - \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/workflows/api-runtime-switch.yml" \
  "${repo_root}/.github/scripts/wait-production-deploy-queue.sh" \
  "${repo_root}/turbo/apps/api/wrangler.jsonc" \
  "${repo_root}/.github/scripts/smoke-api-worker-version.sh" <<'RUBY'
require "json"
require "yaml"

release_path, rollback_path, switch_path, queue_path, wrangler_path, worker_smoke_path = ARGV
release = YAML.safe_load(File.read(release_path), aliases: true)
rollback = YAML.safe_load(File.read(rollback_path), aliases: true)
runtime_switch = YAML.safe_load(File.read(switch_path), aliases: true)

def step_index(steps, name)
  index = steps.index { |step| step["name"] == name }
  raise "missing workflow step: #{name}" unless index
  index
end

release_job = release.fetch("jobs").fetch("promote-api-production")
raise "API release must use the production environment" unless release_job["environment"] == "production"
unless release_job.dig("defaults", "run", "shell") == "bash"
  raise "containerized API release steps must run with Bash"
end
release_steps = release_job.fetch("steps")
ordered_release_steps = [
  "Build API Worker production secret shards",
  "Upload public API Worker production version",
  "Upload isolated API Worker candidate version",
  "Reconcile isolated API Worker candidate routing",
  "Deploy Vercel API production candidate",
  "Deploy isolated API Worker candidate",
  "Check Vercel API production candidate",
  "Check API Worker production candidate",
  "Promote Vercel API production candidate",
  "Promote API Worker production candidate",
  "Verify API production runtime pair",
]
release_indexes = ordered_release_steps.map { |name| step_index(release_steps, name) }
unless release_indexes == release_indexes.sort && release_indexes.uniq.length == release_indexes.length
  raise "API release steps are not in the required Vercel-first order"
end

public_upload_run = release_steps.fetch(release_indexes[1]).fetch("run")
candidate_upload_run = release_steps.fetch(release_indexes[2]).fetch("run")
candidate_routing_run = release_steps.fetch(release_indexes[3]).fetch("run")
[public_upload_run, candidate_upload_run].each do |upload_run|
  raise "Worker release reruns must reuse an immutable commit version" unless upload_run.include?("resolve-optional")
  raise "Worker upload must use generated secret shards" unless upload_run.include?("--secrets-file")
end
raise "public Worker upload must use the production environment" unless public_upload_run.include?("--env production")
unless candidate_upload_run.include?("--env production-candidate")
  raise "candidate Worker upload must use the isolated production-candidate environment"
end
unless candidate_routing_run.include?("vm0-api-production-candidate/subdomain") &&
    candidate_routing_run.include?('"enabled":true,"previews_enabled":false')
  raise "candidate Worker must expose only its stable isolated hostname"
end

release_text = File.read(release_path)
raise "normal releases must not mutate the API Route" if release_text.include?("reconcile-api-runtime.sh")
raise "normal releases must not receive the runtime-switch token" if release_text.include?("CF_API_RUNTIME_SWITCH_API_TOKEN")
if release_text.include?("Cloudflare-Workers-Version-Overrides") ||
    File.read(worker_smoke_path).include?("Cloudflare-Workers-Version-Overrides")
  raise "public production versions must not expose an externally selectable zero-percent candidate"
end

switch_job = runtime_switch.fetch("jobs").fetch("switch-api-runtime")
raise "runtime switching must wait in the production queue" unless switch_job.fetch("needs") == "queue-production-deploy"
raise "runtime switching must require production approval" unless switch_job.fetch("environment") == "production"
switch_steps = switch_job.fetch("steps")
pair_index = step_index(switch_steps, "Verify target API runtime readiness")
reconcile_index = step_index(switch_steps, "Reconcile public API runtime")
raise "runtime switching must verify target readiness before mutation" unless pair_index < reconcile_index
pair_env = switch_steps.fetch(pair_index).fetch("env")
expected_worker_condition = "$" + "{{ inputs.target_runtime == 'cloudflare' }}"
unless pair_env.fetch("VERIFY_WORKER") == expected_worker_condition
  raise "Vercel recovery must not depend on Worker readiness"
end
reconcile_env = switch_steps.fetch(reconcile_index).fetch("env")
expected_switch_token = "$" + "{{ secrets.CF_API_RUNTIME_SWITCH_API_TOKEN }}"
unless reconcile_env.fetch("CLOUDFLARE_API_TOKEN") == expected_switch_token
  raise "runtime switching must use the dedicated Route and DNS token"
end

rollback_inputs = (rollback["on"] || rollback[true]).fetch("workflow_dispatch").fetch("inputs")
api_runtime = rollback_inputs.fetch("api_runtime")
unless api_runtime.fetch("required") == true && api_runtime.fetch("options").sort == %w[cloudflare vercel]
  raise "rollback must require an explicit API runtime"
end
rollback_steps = rollback.fetch("jobs").fetch("rollback-api").fetch("steps")
rollback_order = [
  "Promote target isolated API Worker candidate",
  "Check target isolated API Worker candidate",
  "Promote target API deployment",
  "Promote target API Worker version",
  "Verify API production runtime pair",
  "Reconcile public API runtime",
].map { |name| step_index(rollback_steps, name) }
unless rollback_order == rollback_order.sort
  raise "rollback must validate the isolated candidate, then converge Vercel, Worker, and the public runtime"
end

queue_text = File.read(queue_path)
unless queue_text.include?(".github/workflows/api-runtime-switch.yml")
  raise "runtime switching must share the production deployment queue"
end

wrangler_text = File.read(wrangler_path).gsub(/,\s*([}\]])/, '\\1')
production = JSON.parse(wrangler_text).fetch("env").fetch("production")
candidate = JSON.parse(wrangler_text).fetch("env").fetch("production-candidate")
raise "production Worker must not expose workers.dev" unless production.fetch("workers_dev") == false
raise "production Worker must not expose preview URLs" unless production.fetch("preview_urls") == false
raise "production Worker config must not own public routes" if production.key?("routes")
raise "production Worker config must leave Cron on Vercel" if production.key?("triggers")
required_shards = production.fetch("secrets").fetch("required")
expected_shards = (1..32).map { |index| format("VM0_WORKER_ENV_%02d", index) }
raise "production Worker must require all 32 secret shards" unless required_shards == expected_shards
raise "candidate must be a separate Worker service" unless candidate.fetch("name") == "vm0-api-production-candidate"
raise "candidate Worker must use its stable workers.dev hostname" unless candidate.fetch("workers_dev") == true
raise "candidate Worker must not expose preview URLs" unless candidate.fetch("preview_urls") == false
raise "candidate Worker config must not own public routes" if candidate.key?("routes")
raise "candidate Worker config must leave Cron on Vercel" if candidate.key?("triggers")
unless candidate.fetch("secrets").fetch("required") == expected_shards
  raise "candidate Worker must require all 32 secret shards"
end

puts "api-worker-production workflow contracts passed"
RUBY
