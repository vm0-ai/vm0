#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - \
  "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/cleanup.yml" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
jobs = workflow.fetch("jobs")
prepare = jobs.fetch("prepare")
worker = jobs.fetch("deploy-api")
vercel = jobs.fetch("deploy-api-vercel")
stripe = jobs.fetch("deploy-stripe-listener")
gate = jobs.fetch("ci-gate-turbo")

unless prepare.dig("outputs", "vercel-api-preview-url") ==
    "${{ steps.preview-urls.outputs.vercel-api-url }}"
  raise "prepare must expose the isolated Vercel API preview URL"
end
unless prepare.dig("outputs", "vercel-app-preview-url") ==
    "${{ steps.preview-urls.outputs.vercel-app-url }}"
  raise "prepare must expose the isolated Vercel app preview URL"
end
preview_urls_step = prepare.fetch("steps").find do |step|
  step["name"] == "Set preview URLs"
end
raise "missing preview URL step" unless preview_urls_step
unless preview_urls_step.fetch("run").include?("CF_PAGES_PROJECT_NAME") &&
    preview_urls_step.fetch("run").include?("-vercel-app.${CF_PAGES_PROJECT_NAME}.pages.dev")
  raise "Vercel app URL must use its isolated Pages branch alias"
end

unless Array(worker["needs"]).include?("deploy-stripe-listener") &&
    Array(vercel["needs"]).include?("deploy-stripe-listener")
  raise "both API runtimes must wait for their Stripe listener"
end
unless vercel.fetch("if").include?("needs.deploy-stripe-listener.result == 'success'")
  raise "Vercel API preview must require Stripe listener success"
end

find_step = lambda do |job, name|
  job.fetch("steps").find { |step| step["name"] == name } ||
    raise("missing step: #{name}")
end

seed_step = find_step.call(vercel, "Resolve Vercel API seed environment")
unless seed_step.dig("with", "job-ref").include?("-vercel") &&
    seed_step.dig("with", "app-url").include?("vercel-app-preview-url") &&
    seed_step.dig("with", "api-backend-url").include?("vercel-api-preview-url")
  raise "Vercel seed environment must use the isolated runtime namespace"
end

neon_step = find_step.call(vercel, "Create isolated Vercel Neon branch")
unless neon_step.fetch("run").include?('BRANCH_NAME="preview/${{ needs.prepare.outputs.job-ref }}-vercel"')
  raise "Vercel API preview must use an isolated Neon branch"
end

deploy_step = find_step.call(vercel, "Deploy API to Vercel")
unless deploy_step.fetch("uses") == "./.github/actions/vercel-deploy" &&
    deploy_step.dig("with", "prebuilt") == "true"
  raise "Vercel API preview must use the canonical prebuilt deployment action"
end
alias_step = find_step.call(vercel, "Create isolated Vercel API alias")
unless alias_step.dig("with", "job-ref").include?("-vercel")
  raise "Vercel API alias must use the isolated runtime namespace"
end
protection_step = find_step.call(
  vercel, "Check Vercel API deployment, alias, and protection"
)
unless protection_step.fetch("run").include?("unauthenticated_status") &&
    protection_step.fetch("run").include?("x-vercel-protection-bypass") &&
    protection_step.fetch("run").include?("alias_ready")
  raise "Vercel API preview must verify alias freshness and deployment protection"
end
signing_step = find_step.call(vercel, "Verify Vercel API Stripe webhook signing")
unless signing_step.fetch("run").include?("stripe-signature") &&
    signing_step.fetch("run").include?("x-vercel-protection-bypass")
  raise "Vercel API preview must prove its listener signing secret"
end

unless stripe.dig("strategy", "matrix", "runtime") == %w[cloudflare vercel]
  raise "Stripe listeners must cover both preview runtimes"
end
stripe_step = find_step.call(stripe, "Start Stripe CLI listener on one metal host")
stripe_source = stripe_step.fetch("run")
unless stripe_source.include?("CF-Access-Client-Id") &&
    stripe_source.include?("x-vercel-protection-bypass") &&
    stripe_source.include?("forward_headers")
  raise "Stripe forwarding must authenticate to each runtime ingress"
end

%w[cli-e2e-02-browser cli-e2e-02-playwright deploy-runner-start].each do |job_name|
  job = jobs.fetch(job_name)
  unless job.dig("strategy", "matrix", "runtime") == %w[cloudflare vercel]
    raise "#{job_name} must run both preview runtimes"
  end
  unless Array(job["needs"]).include?("deploy-api") &&
      Array(job["needs"]).include?("deploy-api-vercel")
    raise "#{job_name} must wait for both API preview deployments"
  end
end

playwright = jobs.fetch("cli-e2e-02-playwright")
unless playwright.dig("strategy", "matrix", "shard") == [1, 2]
  raise "Playwright E2E must shard both preview runtimes"
end
playwright_run = find_step.call(playwright, "Run Playwright E2E tests")
unless playwright_run.fetch("run").include?('--fully-parallel') &&
    playwright_run.fetch("run").include?('--shard="${PLAYWRIGHT_SHARD}/2"') &&
    playwright_run.fetch("run").include?('--workers=1')
  raise "Playwright E2E must balance shards while serializing each test identity"
end
playwright_job_ref = playwright_run.dig("env", "JOB_REF")
unless playwright_job_ref.include?("matrix.shard") &&
    playwright_job_ref.include?("format('{0}-v{1}'") &&
    playwright_job_ref.include?("format('{0}-c{1}'")
  raise "Playwright E2E shards must isolate Clerk cleanup namespaces"
end
unless playwright.dig("concurrency", "group").include?("matrix.shard")
  raise "Playwright E2E shard concurrency groups must remain independent"
end
playwright_upload = find_step.call(playwright, "Upload Playwright report")
unless playwright_upload.dig("with", "name").include?("matrix.shard")
  raise "Playwright E2E artifacts must remain unique per shard"
end

%w[cli-e2e-02-browser cli-e2e-02-playwright].each do |job_name|
  run_step = jobs.fetch(job_name).fetch("steps").find do |step|
    step.fetch("name", "").start_with?("Run ") &&
      step.fetch("name", "").end_with?("E2E tests")
  end
  raise "missing live E2E step for #{job_name}" unless run_step
  if run_step.key?("continue-on-error")
    raise "both #{job_name} runtime lanes must be blocking"
  end
end

gate_needs = Array(gate["needs"])
unless gate_needs.include?("deploy-api") && gate_needs.include?("deploy-api-vercel")
  raise "CI gate must include both API preview deployments"
end
gate_source = find_step.call(gate, "Validate CI results").fetch("run")
unless gate_source.include?('check_result "deploy-api"') &&
    gate_source.include?('check_result "deploy-api-vercel"') &&
    gate_source.include?('LIVE_E2E_SKIP_ALLOWED=""')
  raise "CI gate must block on both API deployments and required live E2E"
end

cleanup = YAML.load_file(ARGV.fetch(1)).fetch("jobs")
runner_cleanup = find_step.call(cleanup.fetch("cleanup-runner"), "Cleanup turbo runner on all metal hosts").fetch("run")
stripe_cleanup = find_step.call(cleanup.fetch("cleanup-runner"), "Cleanup Stripe CLI listener on all metal hosts").fetch("run")
pages_cleanup = find_step.call(cleanup.fetch("cleanup-app-pages-deployments"), "Delete Cloudflare Pages app preview deployments").fetch("run")
database_steps = cleanup.fetch("cleanup-database").fetch("steps")
unless runner_cleanup.include?('"pr-${PR_NUMBER}-vercel"') &&
    stripe_cleanup.include?('"pr-${PR_NUMBER}-vercel"') &&
    pages_cleanup.include?('"pr-${PR_NUMBER}-vercel-app"') &&
    database_steps.any? { |step| step.dig("with", "branch-name") == "pr-${{ github.event.pull_request.number }}-vercel" }
  raise "PR cleanup must remove every isolated Vercel preview resource"
end
RUBY

echo "dual-api-preview-workflow tests passed"
