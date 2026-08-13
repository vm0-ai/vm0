#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cleanup_workflow="${repo_root}/.github/workflows/cleanup.yml"
stale_workflow="${repo_root}/.github/workflows/cleanup-stale.yml"
turbo_workflow="${repo_root}/.github/workflows/turbo.yml"

ruby -ryaml - "$cleanup_workflow" "$stale_workflow" "$turbo_workflow" <<'RUBY'
def named_step(job, name)
  job.fetch("steps").find { |step| step["name"] == name }
end

cleanup = YAML.load_file(ARGV.fetch(0)).fetch("jobs").fetch("cleanup-runner")
permissions = cleanup.fetch("permissions")
unless permissions == {
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "cleanup runner must have only the permissions needed for ownership handoff"
end

checkout = cleanup.fetch("steps").find { |step| step["uses"] == "actions/checkout@v7.0.1" }
unless checkout&.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    checkout&.dig("with", "persist-credentials") == false
  raise "cleanup runner must execute the trusted default-branch ownership script"
end

handoff = named_step(cleanup, "Wait for active CI owners before runner cleanup")
raise "missing closed-PR ownership handoff" unless handoff
unless handoff.fetch("if").include?("steps.check.outputs.should-cleanup") &&
    handoff.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    handoff.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    handoff.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}" &&
    handoff.dig("env", "PR_NUMBER") == "${{ github.event.pull_request.number }}" &&
    handoff.dig("env", "RUNNER_OWNER_SCOPE") == "closed-pr-cleanup" &&
    handoff.fetch("run") == ".github/scripts/cancel-superseded-merge-group-runs.sh" &&
    !handoff.key?("continue-on-error")
  raise "closed-PR ownership handoff must fail closed"
end

cleanup_names = cleanup.fetch("steps").map { |step| step["name"] }
unless cleanup_names.index("Wait for active CI owners before runner cleanup") <
    cleanup_names.index("Cleanup turbo runner on all metal hosts")
  raise "ownership handoff must complete before shared runner resources are deleted"
end

stale = YAML.load_file(ARGV.fetch(1)).fetch("jobs").fetch("cleanup-metal-runners")
unless stale.fetch("permissions") == {
  "actions" => "read",
  "contents" => "read",
  "pull-requests" => "read",
}
  raise "stale runner cleanup must use the same ownership permissions"
end
stale_checkout = stale.fetch("steps").find { |step| step["uses"] == "actions/checkout@v7.0.1" }
unless stale_checkout&.dig("with", "ref") == "${{ github.event.repository.default_branch }}" &&
    stale_checkout&.dig("with", "persist-credentials") == false
  raise "stale runner cleanup must execute the trusted default-branch ownership script"
end
stale_cleanup = named_step(stale, "Cleanup stale runners")
raise "missing stale runner cleanup" unless stale_cleanup
unless stale_cleanup.dig("env", "GH_TOKEN") == "${{ github.token }}" &&
    stale_cleanup.dig("env", "GITHUB_REPOSITORY") == "${{ github.repository }}" &&
    stale_cleanup.dig("env", "GITHUB_RUN_ID") == "${{ github.run_id }}"
  raise "stale runner cleanup must receive the ownership API context"
end
stale_script = stale_cleanup.fetch("run")
stale_dry_run_index = stale_script.index('if [ "$DRY_RUN" = "true" ]')
stale_handoff_index = stale_script.index("RUNNER_OWNER_SCOPE=closed-pr-cleanup")
stale_delete_index = stale_script.index("playbooks/cleanup-turbo-runner.yml")
unless stale_dry_run_index && stale_handoff_index && stale_delete_index &&
    stale_dry_run_index < stale_handoff_index && stale_handoff_index < stale_delete_index
  raise "stale cleanup must take ownership before deleting each PR runner namespace"
end

turbo = YAML.load_file(ARGV.fetch(2)).fetch("jobs")
prepare = turbo.fetch("deploy-runner-prepare")
start = turbo.fetch("deploy-runner-start")
unless prepare.dig("outputs", "runner-sha-map") ==
    "${{ steps.manifest.outputs.runner-sha-map }}"
  raise "runner prepare must expose producer SHA ownership by target"
end
unless start.fetch("permissions") == {"actions" => "read", "contents" => "read"}
  raise "runner recovery must have read-only workflow permissions"
end

check = named_step(start, "Check runner binaries against image manifests")
raise "missing runner binary ownership check" unless check
unless check["id"] == "runner-binary-check" &&
    check.dig("env", "BIN_DIR") == "${{ needs.deploy-runner-prepare.outputs.bin-dir }}" &&
    check.dig("env", "JOB_REF") == "${{ needs.prepare.outputs.runner-image-job-ref }}" &&
    check.dig("env", "RUNNER_SHA_MAP") == "${{ needs.deploy-runner-prepare.outputs.runner-sha-map }}" &&
    check["run"] == ".github/scripts/reconcile-runner-binary-groups.sh check"
  raise "runner binary check must compare every host with its producer manifest"
end

resolve = named_step(start, "Resolve validated runner binary recovery")
raise "missing validated runner binary recovery" unless resolve
unless resolve["id"] == "runner-binary-recovery" &&
    resolve["if"] == "steps.runner-binary-check.outputs.recovery-needed == 'true'" &&
    resolve.dig("env", "CURRENT_EVENT") == "${{ github.event_name }}" &&
    resolve.dig("env", "CURRENT_RUN_ID") == "${{ github.run_id }}" &&
    resolve.dig("env", "RESOLVE_OUTPUT_DIR") == "runner-binary-recovery" &&
    resolve.dig("env", "RUNNER_HOST_GROUPS_MATRIX") ==
      "${{ steps.runner-binary-check.outputs.runner-host-groups-matrix }}" &&
    resolve.fetch("run").include?("export CURRENT_PR_NUMBER=$current_pr_number") &&
    resolve.fetch("run").include?(".github/scripts/runner-binary-cache-plan.sh") &&
    !resolve.key?("continue-on-error")
  raise "runner binary recovery must use the trusted cache plan only when needed"
end

restore = named_step(start, "Restore validated runner binaries")
raise "missing validated runner binary restore" unless restore
unless restore["if"] == "steps.runner-binary-check.outputs.recovery-needed == 'true'" &&
    restore.dig("env", "RECOVERY_DIR") == "runner-binary-recovery" &&
    restore.dig("env", "RECOVERY_MISS_COUNT") ==
      "${{ steps.runner-binary-recovery.outputs.miss-count }}" &&
    restore.dig("env", "RUNNER_SHA_MAP") ==
      "${{ needs.deploy-runner-prepare.outputs.runner-sha-map }}" &&
    restore.fetch("run").include?('if [ "$RECOVERY_MISS_COUNT" != "0" ]') &&
    restore.fetch("run").include?(".github/scripts/reconcile-runner-binary-groups.sh restore") &&
    !restore.key?("continue-on-error")
  raise "runner restore must reject cache misses and manifest mismatches"
end

start_names = start.fetch("steps").map { |step| step["name"] }
ordered_steps = [
  "Check runner binaries against image manifests",
  "Resolve validated runner binary recovery",
  "Restore validated runner binaries",
  "Rebuild config and start runner service on all hosts",
]
indices = ordered_steps.map { |name| start_names.index(name) }
unless indices.none?(&:nil?) && indices.each_cons(2).all? { |left, right| left < right }
  raise "late-approved Turbo runs must reconcile validated binaries before runner start"
end
RUBY

echo "runner-lifecycle-ownership-workflow-test: ok"
