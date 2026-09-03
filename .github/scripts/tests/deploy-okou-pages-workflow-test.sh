#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

bash -n "${repo_root}/.github/scripts/verify-okou-production-domains.sh"

python3 - \
  "${repo_root}/.github/workflows/turbo.yml" \
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


turbo, turbo_source = load_workflow(sys.argv[1])
release, release_source = load_workflow(sys.argv[2])
rollback, rollback_source = load_workflow(sys.argv[3])
production_verifier_source = Path(sys.argv[4]).read_text()
worker_config_source = Path(sys.argv[5]).read_text()

turbo_job = turbo["jobs"]["deploy-app"]
release_controller_job = release["jobs"]["release-please"]
release_job = release["jobs"]["promote-app-production"]
worker_release_job = release["jobs"]["promote-app-worker-production"]
release_dashboard_job = release["jobs"]["update-rollback-dashboard"]
rollback_job = rollback["jobs"]["rollback-app"]
rollback_verification_job = rollback["jobs"]["verify-production-domains"]

build_step = find_step(turbo_job, "Build canonical app artifact")
preview_step = find_step(turbo_job, "Deploy standalone app Worker preview")
prepare_preview_step = find_step(turbo_job, "Prepare standalone app Worker preview")
publish_assets_step = find_step(turbo_job, "Publish immutable app assets to R2")
verify_preview_assets_step = find_step(
    turbo_job, "Verify immutable app assets on CDN"
)
preview_readiness_step = find_step(
    turbo_job, "Wait for standalone app Worker readiness"
)
preview_gateway_step = find_step(turbo_job, "Smoke test standalone app Worker")
app_preview_url_step = find_step(turbo_job, "Resolve app Worker preview URL")
resolve_app_release_step = find_step(
    release_controller_job, "Resolve App deployment release"
)
resolve_release_target_step = find_step(
    release_controller_job, "Resolve release target"
)
resolve_release_tags_step = find_step(
    release_controller_job, "Resolve current release tags"
)
prepare_release_step = find_step(
    release_job, "Prepare Cloudflare Pages production deployment"
)
prepare_worker_release_step = find_step(
    worker_release_job, "Prepare standalone App Worker production deployment"
)
verify_release_assets_step = find_step(
    release_job, "Verify immutable app assets on CDN"
)
verify_worker_release_assets_step = find_step(
    worker_release_job, "Verify immutable App assets for Worker production"
)
release_sentry_step = find_step(
    release_job, "Upload App source maps to Sentry"
)
release_step = find_step(release_job, "Deploy Cloudflare Pages production fallback")
worker_release_step = find_step(
    worker_release_job, "Deploy App Worker production"
)
worker_release_start_step = find_step(worker_release_job, "Start GitHub Deployment")
worker_release_finish_step = find_step(
    worker_release_job, "Finish GitHub Deployment"
)
release_start_step = find_step(release_job, "Start GitHub Deployment")
release_finish_step = find_step(release_job, "Finish GitHub Deployment")
release_failure_step = find_step(release_job, "Notify Slack - Pages fallback failure")
rollback_step = find_step(rollback_job, "Deploy App to Cloudflare Pages production")
rollback_prepare_step = find_step(rollback_job, "Prepare App production deployment")
rollback_verification_step = find_step(
    rollback_verification_job, "Verify production App and API domains"
)

shared_script = "bash .github/scripts/deploy-okou-pages.sh"
primary_app_domain_expression = (
    "${{ vars.CLERK_PRODUCTION_PRIMARY_APP_DOMAIN || 'app.vm0.ai' }}"
)

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
        raise RuntimeError(
            f"Release Please output {output_name} must be {expression}"
        )

resolve_app_release_source = require_fragments(
    resolve_app_release_step,
    [
        'if [[ "$APP_RELEASE_CREATED" == "true" ]]',
        'elif [[ "$APP_WORKER_RELEASE_CREATED" == "true" ]]',
        'echo "required=$required"',
        'echo "tag=$release_tag"',
        'echo "version=$version"',
    ],
)
if resolve_app_release_step.get("id") != "app-release":
    raise RuntimeError("App deployment release resolver id must remain app-release")
for env_name, expression in {
    "APP_WORKER_RELEASE_CREATED": "${{ steps.release.outputs['turbo/apps/app-worker--release_created'] }}",
    "APP_WORKER_RELEASE_TAG": "${{ steps.release.outputs['turbo/apps/app-worker--tag_name'] }}",
    "APP_WORKER_VERSION": "${{ steps.release.outputs['turbo/apps/app-worker--version'] }}",
}.items():
    if resolve_app_release_step.get("env", {}).get(env_name) != expression:
        raise RuntimeError(f"App release resolver must receive {env_name}")
if not resolve_app_release_source.index("APP_RELEASE_CREATED") < resolve_app_release_source.index("APP_WORKER_RELEASE_CREATED"):
    raise RuntimeError("platform release metadata must take display precedence")

release_target_values = resolve_release_target_step.get("env", {}).get(
    "RELEASE_SHAS", ""
)
if "steps.release.outputs['turbo/apps/app-worker--sha']" not in release_target_values:
    raise RuntimeError("release target resolution must include the App Worker SHA")
release_tag_values = resolve_release_tags_step.get("env", {}).get(
    "RELEASE_TAGS", ""
)
if "steps.release.outputs['turbo/apps/app-worker--tag_name']" not in release_tag_values:
    raise RuntimeError("release tag resolution must include the App Worker tag")

if "needs.release-please.outputs.app_deploy_required == 'true'" not in str(
    release_job.get("if", "")
):
    raise RuntimeError("App promotion must run for platform or App Worker releases")
if "needs.release-please.outputs.app_deploy_required == 'true'" not in str(
    worker_release_job.get("if", "")
):
    raise RuntimeError("standalone Worker promotion must follow every App deployment")
if "continue-on-error" in worker_release_job:
    raise RuntimeError("production Worker promotion must fail closed")
if worker_release_job.get("timeout-minutes") != 45:
    raise RuntimeError("production Worker promotion must have a bounded runtime")
if worker_release_job.get("environment") != "production":
    raise RuntimeError("production Worker promotion must use production credentials")
if "promote-app-production" not in worker_release_job.get("needs", []):
    raise RuntimeError("production Worker must wait for the Pages fallback")
if "needs.promote-app-production.result == 'success'" not in str(
    worker_release_job.get("if", "")
):
    raise RuntimeError("production Worker must require a ready Pages fallback")
if "promote-app-worker-production" not in release_dashboard_job.get("needs", []):
    raise RuntimeError("production Worker must gate the rollback dashboard")
if "needs.release-please.outputs.app_deploy_required != 'true'" not in str(
    release_dashboard_job.get("if", "")
):
    raise RuntimeError(
        "rollback dashboard must wait for every applicable App deployment"
    )
if "needs.promote-app-worker-production.result == 'success'" not in str(
    release_dashboard_job.get("if", "")
):
    raise RuntimeError("rollback dashboard must require the production Worker")

for step in (
    prepare_preview_step,
    prepare_worker_release_step,
    prepare_release_step,
    rollback_prepare_step,
):
    if step.get("env", {}).get("CLERK_PRODUCTION_PRIMARY_APP_DOMAIN") != primary_app_domain_expression:
        raise RuntimeError(
            f"step {step.get('name')} must inject the Clerk production primary app domain"
        )
require_fragments(
    build_step,
    ["build:verify-hashes", "--sourcemap", "sentry-cli sourcemaps inject dist"],
)
if build_step.get("env", {}).get("OKOU_APP_GIT_COMMIT_SHA") != (
    "${{ steps.artifact.outputs.sha }}"
):
    raise RuntimeError("canonical App build must receive the isolated commit SHA")
if "VITE_GIT_COMMIT_SHA" in build_step.get("env", {}):
    raise RuntimeError("App commit SHA must not enter the public Vite env object")
require_fragments(
    preview_step,
    [
        "/workers/scripts/okou-app-preview/deployments",
        ".result.deployments | length == 0",
        "wrangler deploy",
        "wrangler versions upload",
        "--env preview",
        '--preview-alias "$WORKER_PREVIEW_ALIAS"',
        '--message "app artifact ${ARTIFACT_SHA}"',
        "/workers/scripts/okou-app-preview/subdomain",
        "previews_enabled",
        ".result.previews_enabled == true",
    ],
)
require_fragments(prepare_preview_step, ['echo "canonical-dist=$canonical_dist"'])
require_fragments(
    publish_assets_step,
    [
        "bash .github/scripts/publish-okou-app-assets.sh",
        '"$r2_endpoint"',
        '"$R2_BUCKET_NAME"',
        '"$CANONICAL_ASSETS"',
    ],
)
if publish_assets_step.get("env", {}).get("CANONICAL_ASSETS") != (
    "${{ steps.worker-preview.outputs.canonical-dist }}/assets"
):
    raise RuntimeError("R2 publication must use canonical app assets")

asset_verifier = "bash .github/scripts/verify-okou-app-assets.sh"
for step, canonical_assets in (
    (
        verify_preview_assets_step,
        "${{ steps.worker-preview.outputs.canonical-dist }}/assets",
    ),
    (
        verify_worker_release_assets_step,
        "${{ steps.worker-production.outputs.canonical-dist }}/assets",
    ),
    (
        verify_release_assets_step,
        "${{ steps.pages-production.outputs.canonical-dist }}/assets",
    ),
):
    require_fragments(
        step,
        [
            asset_verifier,
            '"https://static.okou.io/okou-app/assets"',
            '"$CANONICAL_ASSETS"',
        ],
    )
    if step.get("env", {}).get("CANONICAL_ASSETS") != canonical_assets:
        raise RuntimeError(
            f"CDN verification must use canonical app assets: {step['name']}"
        )

turbo_steps = turbo_job["steps"]
if not (
    turbo_steps.index(prepare_preview_step)
    < turbo_steps.index(publish_assets_step)
    < turbo_steps.index(verify_preview_assets_step)
    < turbo_steps.index(preview_step)
):
    raise RuntimeError(
        "R2 asset publication and CDN verification must run before Worker deployment"
    )

release_steps = release_job["steps"]
if not (
    release_steps.index(prepare_release_step)
    < release_steps.index(verify_release_assets_step)
    < release_steps.index(release_sentry_step)
    < release_steps.index(release_step)
):
    raise RuntimeError("CDN assets must be verified before production Pages deployment")
if "publish-okou-app-assets.sh" in str(release_job):
    raise RuntimeError("production promotion must not publish immutable app assets")
if "publish-okou-app-assets.sh" in str(worker_release_job):
    raise RuntimeError("standalone Worker promotion must not republish immutable assets")

worker_release_steps = worker_release_job["steps"]
if not (
    worker_release_steps.index(prepare_worker_release_step)
    < worker_release_steps.index(verify_worker_release_assets_step)
    < worker_release_steps.index(worker_release_step)
    < worker_release_steps.index(worker_release_finish_step)
):
    raise RuntimeError(
        "standalone Worker must prepare and verify its artifact before deployment"
    )
require_fragments(
    prepare_worker_release_step,
    [
        "bash .github/scripts/fetch-okou-app-artifact.sh",
        "bash .github/scripts/verify-okou-app-artifact.sh",
        "bash .github/scripts/prepare-okou-app-worker-shell.sh",
        'echo "canonical-dist=$canonical_dist"',
    ],
)
worker_release_source = require_fragments(
    worker_release_step,
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
if worker_release_step.get("env", {}).get("CLOUDFLARE_API_TOKEN") != (
    "${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}"
):
    raise RuntimeError("production Worker deployment must use the Worker token")
if worker_release_source.count("wrangler deploy") != 1:
    raise RuntimeError("production Worker must deploy exactly once")
if worker_release_finish_step.get("with", {}).get("status") != "${{ job.status }}":
    raise RuntimeError("production Worker deployment must report its final job status")
if worker_release_start_step.get("with", {}).get("env") != "app/production":
    raise RuntimeError("production Worker must own the canonical App deployment")
if release_start_step.get("with", {}).get("env") != "app-pages/production-shadow":
    raise RuntimeError("Pages must be recorded as the production fallback")
if release_failure_step.get("if") != (
    "${{ failure() && vars.SLACK_RELEASE_CHANNEL_ID != '' }}"
):
    raise RuntimeError("Pages fallback failure notification must fail visibly")
if "Worker production was not advanced" not in str(
    release_failure_step.get("with", {}).get("payload", "")
):
    raise RuntimeError("Pages fallback failure must explain that Worker stayed put")
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

readiness_source = require_fragments(
    preview_readiness_step,
    [
        'id="app-bootstrap-skeleton"',
        "Standalone app Worker shell is ready",
    ],
)
if "CANONICAL_ASSETS" in preview_readiness_step.get("env", {}):
    raise RuntimeError("Worker shell readiness must not inspect immutable app assets")
# Readiness only waits for Worker alias propagation. The following bounded
# smoke test owns the full runtime contract.
if "verify-okou-app-runtime.sh" in readiness_source:
    raise RuntimeError("Worker readiness must not point sample the runtime contract")
gateway_source = require_fragments(
    preview_gateway_step,
    [
        "bash .github/scripts/verify-okou-app-runtime.sh",
        '"$APP_PREVIEW_URL"',
        '"https://static.okou.io/okou-app/assets"',
        '"$CANONICAL_ASSETS"',
        "{1..12}",
    ],
)
if preview_gateway_step.get("env", {}).get("CANONICAL_ASSETS") != (
    "${{ steps.worker-preview.outputs.canonical-dist }}/assets"
):
    raise RuntimeError("SharedWorker smoke test must use canonical app assets")
if turbo_source.count("bash .github/scripts/verify-okou-app-runtime.sh") != 1:
    raise RuntimeError(
        "the app preview runtime contract must be verified exactly once, with retries"
    )
if "if" in app_preview_url_step:
    raise RuntimeError(
        "the app Worker preview URL must always resolve, "
        "or runtime verification silently skips"
    )
release_step_source = require_fragments(
    release_step,
    [
        shared_script,
        '"$PAGES_DIST"',
        '"$CF_PAGES_PROJECT_NAME"',
        "production",
        '"$ARTIFACT_SHA"',
        'echo "url=$pages_url"',
    ],
)
if release_step_source.count(shared_script) != 1:
    raise RuntimeError("production must run exactly one Pages deployment")
runtime_verifier = "bash .github/scripts/verify-okou-app-runtime.sh"
domain_verifier = "bash .github/scripts/verify-okou-production-domains.sh"
if not (
    release_step_source.index(shared_script)
    < release_step_source.index('echo "url=$pages_url"')
):
    raise RuntimeError("Pages fallback deployment must finish before success output")
for deployment_source in (release_step_source, worker_release_source):
    if runtime_verifier in deployment_source:
        raise RuntimeError("Release Please App deployment must trust Cloudflare success")
for fragment in (domain_verifier, '"https://app.vm0.ai"', '"https://app.okou.ai"'):
    if fragment in release_step_source:
        raise RuntimeError(
            f"Pages fallback deployment must not verify the live Worker route: {fragment}"
        )
if not (
    release_steps.index(release_step) < release_steps.index(release_finish_step)
):
    raise RuntimeError(
        "production deployment must finish before the GitHub Deployment is reported"
    )
if release_finish_step.get("with", {}).get("status") != "${{ job.status }}":
    raise RuntimeError("GitHub Deployment completion must report its final job status")
require_fragments(
    rollback_step,
    [shared_script, '"$PAGES_DIST"', '"$CF_PAGES_PROJECT_NAME"', "production", '"$TARGET_COMMIT"'],
)

for step in (release_step, rollback_step):
    if "working-directory" in step:
        raise RuntimeError(f"shared Pages deployment must run from the repository root: {step['name']}")

for path, source in (
    (sys.argv[1], turbo_source),
    (sys.argv[2], release_source),
    (sys.argv[3], rollback_source),
):
    if "wrangler pages deploy" in source:
        raise RuntimeError(f"direct Pages deployment remains in {path}")

if preview_step.get("env", {}).get("CLOUDFLARE_API_TOKEN") != (
    "${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}"
):
    raise RuntimeError("preview Worker deployment must use the Worker deploy token")

require_fragments(
    rollback_verification_step,
    [
        "verify-okou-production-domains.sh",
        '"https://${CF_PAGES_PROJECT_NAME}.pages.dev"',
    ],
)

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
    invocations = (
        f'verify_auth_redirect "{api_origin}" "{app_origin}"',
        f'verify_api_cors "{api_origin}" "{app_origin}"',
    )
    for invocation in invocations:
        if invocation not in production_verifier_source:
            raise RuntimeError(f"production verifier is missing mapping: {invocation}")

print("deploy-okou-pages workflow tests passed")
PY
