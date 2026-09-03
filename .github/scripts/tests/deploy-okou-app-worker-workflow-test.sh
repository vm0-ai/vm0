#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

bash -n "${repo_root}/.github/scripts/verify-okou-production-domains.sh"

python3 - \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/scripts/verify-okou-production-domains.sh" \
  "${repo_root}/turbo/apps/app-worker/wrangler.jsonc" <<'PY'
from pathlib import Path
import sys

import yaml


def load_workflow(path: str) -> tuple[dict[str, object], str]:
    source = Path(path).read_text()
    return yaml.safe_load(source), source


def find_step(job: dict[str, object], name: str) -> dict[str, object]:
    steps = job["steps"]
    if not isinstance(steps, list):
        raise RuntimeError(f"job steps are not a list: {name}")
    for step in steps:
        if isinstance(step, dict) and step.get("name") == name:
            return step
    raise RuntimeError(f"missing workflow step: {name}")


def require_fragments(step: dict[str, object], fragments: list[str]) -> str:
    source = step.get("run")
    if not isinstance(source, str):
        raise RuntimeError(f"step has no run source: {step.get('name')}")
    for fragment in fragments:
        if fragment not in source:
            raise RuntimeError(
                f"step {step.get('name')} is missing deployment input: {fragment}"
            )
    return source


release, _release_source = load_workflow(sys.argv[1])
rollback, _rollback_source = load_workflow(sys.argv[2])
production_verifier_source = Path(sys.argv[3]).read_text()
worker_config_source = Path(sys.argv[4]).read_text()

release_jobs = release["jobs"]
rollback_jobs = rollback["jobs"]
release_controller_job = release_jobs["release-please"]
worker_release_job = release_jobs["promote-app-worker-production"]
release_dashboard_job = release_jobs["update-rollback-dashboard"]
rollback_verification_job = rollback_jobs["verify-production-domains"]

expected_needs = ["release-please", "builds-complete", "promote-api-production"]
if worker_release_job.get("needs") != expected_needs:
    raise RuntimeError("the production Worker must wait for App builds and API production")
worker_condition = str(worker_release_job.get("if", ""))
for fragment in (
    "needs.release-please.outputs.app_deploy_required == 'true'",
    "needs.builds-complete.result == 'success'",
    "needs.promote-api-production.result == 'success'",
):
    if fragment not in worker_condition:
        raise RuntimeError(f"production Worker condition is missing: {fragment}")
if "continue-on-error" in worker_release_job:
    raise RuntimeError("production Worker promotion must fail closed")
if worker_release_job.get("timeout-minutes") != 45:
    raise RuntimeError("production Worker promotion must have a bounded runtime")
if worker_release_job.get("environment") != "production":
    raise RuntimeError("production Worker promotion must use production credentials")

prepare_step = find_step(
    worker_release_job, "Prepare standalone App Worker production deployment"
)
verify_assets_step = find_step(
    worker_release_job, "Verify immutable App assets for Worker production"
)
sentry_step = find_step(worker_release_job, "Upload App source maps to Sentry")
deploy_step = find_step(worker_release_job, "Deploy App Worker production")
start_step = find_step(worker_release_job, "Start GitHub Deployment")
finish_step = find_step(worker_release_job, "Finish GitHub Deployment")

primary_app_domain_expression = (
    "${{ vars.CLERK_PRODUCTION_PRIMARY_APP_DOMAIN || 'app.vm0.ai' }}"
)
if prepare_step.get("env", {}).get("CLERK_PRODUCTION_PRIMARY_APP_DOMAIN") != (
    primary_app_domain_expression
):
    raise RuntimeError("Worker shell preparation must inject the Clerk primary domain")
require_fragments(
    prepare_step,
    [
        "bash .github/scripts/fetch-okou-app-artifact.sh",
        "bash .github/scripts/verify-okou-app-artifact.sh",
        "bash .github/scripts/prepare-okou-app-worker-shell.sh",
        'echo "canonical-dist=$canonical_dist"',
    ],
)
require_fragments(
    verify_assets_step,
    [
        "bash .github/scripts/verify-okou-app-assets.sh",
        '"https://static.okou.io/okou-app/assets"',
        '"$CANONICAL_ASSETS"',
    ],
)
expected_canonical_dist = "${{ steps.worker-production.outputs.canonical-dist }}"
if verify_assets_step.get("env", {}).get("CANONICAL_ASSETS") != (
    f"{expected_canonical_dist}/assets"
):
    raise RuntimeError("Worker asset verification must use the canonical artifact")
if sentry_step.get("env", {}).get("CANONICAL_DIST") != expected_canonical_dist:
    raise RuntimeError("source map upload must use the Worker canonical artifact")
require_fragments(
    sentry_step,
    ["pnpm --filter @okouai/app exec sentry-cli sourcemaps upload \"$CANONICAL_DIST\""],
)

deploy_source = require_fragments(
    deploy_step,
    [
        "wrangler deploy",
        "--env production",
        '--message "app artifact ${ARTIFACT_SHA}"',
        '"https://app.vm0.ai|https://api.vm0.ai"',
        '"https://app.okou.ai|https://api.okou.ai"',
        '"https://app-worker.vm0.ai|https://api.vm0.ai"',
        '"https://app-worker.okou.ai|https://api.okou.ai"',
        "Access-Control-Request-Method: GET",
        "%header{access-control-allow-origin}",
        "%header{access-control-allow-credentials}",
    ],
)
if deploy_source.count("wrangler deploy") != 1:
    raise RuntimeError("production Worker must deploy exactly once")
if deploy_step.get("env", {}).get("CLOUDFLARE_API_TOKEN") != (
    "${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}"
):
    raise RuntimeError("production Worker deployment must use the Worker token")
if start_step.get("with", {}).get("env") != "app/production":
    raise RuntimeError("production Worker must own the canonical App deployment")
if finish_step.get("with", {}).get("status") != "${{ job.status }}":
    raise RuntimeError("production Worker deployment must report its final job status")

steps = worker_release_job["steps"]
if not (
    steps.index(prepare_step)
    < steps.index(verify_assets_step)
    < steps.index(sentry_step)
    < steps.index(deploy_step)
    < steps.index(finish_step)
):
    raise RuntimeError("Worker artifact verification must precede deployment reporting")
if "publish-okou-app-assets.sh" in str(worker_release_job):
    raise RuntimeError("production promotion must not republish immutable app assets")

dashboard_needs = release_dashboard_job.get("needs", [])
if "promote-app-worker-production" not in dashboard_needs:
    raise RuntimeError("production Worker must gate the rollback dashboard")
dashboard_condition = str(release_dashboard_job.get("if", ""))
for fragment in (
    "needs.release-please.outputs.app_deploy_required != 'true'",
    "needs.promote-app-worker-production.result == 'success'",
):
    if fragment not in dashboard_condition:
        raise RuntimeError(f"rollback dashboard condition is missing: {fragment}")

if rollback_verification_job.get("needs") != "rollback-api":
    raise RuntimeError("domain verification must follow the API rollback")
rollback_verification_step = find_step(
    rollback_verification_job, "Verify production App and API domains"
)
if rollback_verification_step.get("run") != (
    "bash .github/scripts/verify-okou-production-domains.sh"
):
    raise RuntimeError("rollback must verify the unchanged App and rolled-back API")

for fragment in (
    '"pattern": "app.okou.ai/*"',
    '"zone_name": "okou.ai"',
    '"pattern": "app.vm0.ai/*"',
    '"zone_name": "vm0.ai"',
    '"pattern": "app-worker.okou.ai"',
    '"pattern": "app-worker.vm0.ai"',
    '"custom_domain": true',
):
    if fragment not in worker_config_source:
        raise RuntimeError(f"production Worker config is missing: {fragment}")

for fragment in (
    "https://app.vm0.ai",
    "https://app.okou.ai",
    "https://api.vm0.ai",
    "https://api.okou.ai",
    "sign-in",
    "sign-up",
    "%{redirect_url}",
    "Access-Control-Request-Method: GET",
    "%header{access-control-allow-origin}",
    "%header{access-control-allow-credentials}",
    "/api/__brand-smoke__",
):
    if fragment not in production_verifier_source:
        raise RuntimeError(f"production verifier is missing: {fragment}")

for api_origin, app_origin in (
    ("https://api.vm0.ai", "https://app.vm0.ai"),
    ("https://api.okou.ai", "https://app.okou.ai"),
):
    for invocation in (
        f'verify_auth_redirect "{api_origin}" "{app_origin}"',
        f'verify_api_cors "{api_origin}" "{app_origin}"',
    ):
        if invocation not in production_verifier_source:
            raise RuntimeError(f"production verifier is missing mapping: {invocation}")

release_outputs = release_controller_job["outputs"]
expected_release_outputs = {
    "app_worker_release_created": "${{ steps.release.outputs['turbo/apps/app-worker--release_created'] }}",
    "app_worker_version": "${{ steps.release.outputs['turbo/apps/app-worker--version'] }}",
    "app_deploy_required": "${{ steps.app-release.outputs.required }}",
    "app_deploy_tag": "${{ steps.app-release.outputs.tag }}",
    "app_deploy_version": "${{ steps.app-release.outputs.version }}",
}
for output_name, expression in expected_release_outputs.items():
    if release_outputs.get(output_name) != expression:
        raise RuntimeError(f"Release Please output {output_name} must be {expression}")

print("deploy okou app Worker workflow tests passed")
PY
