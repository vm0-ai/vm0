#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

python3 - \
  "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/scripts/verify-okou-production-domains.sh" <<'PY'
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

turbo_job = turbo["jobs"]["deploy-app"]
release_job = release["jobs"]["promote-app-production"]
release_api_job = release["jobs"]["promote-api-production"]
rollback_job = rollback["jobs"]["rollback-app"]
rollback_verification_job = rollback["jobs"]["verify-production-domains"]

build_step = find_step(turbo_job, "Build canonical app artifact")
preview_step = find_step(turbo_job, "Deploy Cloudflare Pages preview")
prepare_preview_step = find_step(turbo_job, "Prepare Cloudflare Pages preview")
publish_assets_step = find_step(turbo_job, "Publish immutable app assets to R2")
verify_preview_assets_step = find_step(
    turbo_job, "Verify immutable app assets on CDN"
)
preview_readiness_step = find_step(
    turbo_job, "Wait for Cloudflare Pages deployment readiness"
)
preview_gateway_step = find_step(turbo_job, "Smoke test app preview gateway")
app_preview_url_step = find_step(turbo_job, "Resolve app preview gateway URL")
prepare_release_step = find_step(
    release_job, "Prepare Cloudflare Pages production deployment"
)
verify_release_assets_step = find_step(
    release_job, "Verify immutable app assets on CDN"
)
release_sentry_step = find_step(
    release_job, "Upload Cloudflare Pages source maps to Sentry"
)
release_step = find_step(release_job, "Deploy Cloudflare Pages production")
release_finish_step = find_step(release_job, "Finish GitHub Deployment")
release_api_verification_step = find_step(
    release_api_job, "Verify production App and API domains"
)
rollback_step = find_step(rollback_job, "Deploy App to Cloudflare Pages production")
rollback_prepare_step = find_step(rollback_job, "Prepare App production deployment")
rollback_verification_step = find_step(
    rollback_verification_job, "Verify production App and API domains"
)

shared_script = "bash .github/scripts/deploy-okou-pages.sh"
primary_app_domain_expression = (
    "${{ vars.CLERK_PRODUCTION_PRIMARY_APP_DOMAIN || 'app.vm0.ai' }}"
)
for step in (prepare_preview_step, prepare_release_step, rollback_prepare_step):
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
    [shared_script, '"$PAGES_DIST"', '"$CF_PAGES_PROJECT_NAME"', '"$PAGES_BRANCH"', '"$ARTIFACT_SHA"'],
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
    "${{ steps.pages-preview.outputs.canonical-dist }}/assets"
):
    raise RuntimeError("R2 publication must use canonical app assets")

asset_verifier = "bash .github/scripts/verify-okou-app-assets.sh"
for step, canonical_assets in (
    (
        verify_preview_assets_step,
        "${{ steps.pages-preview.outputs.canonical-dist }}/assets",
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
        "R2 asset publication and CDN verification must run before Pages deployment"
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

readiness_source = require_fragments(
    preview_readiness_step,
    [
        'id="app-bootstrap-skeleton"',
        "Cloudflare Pages shell is ready",
    ],
)
if "PAGES_DIST" in preview_readiness_step.get("env", {}):
    raise RuntimeError("Pages shell readiness must not inspect removed app assets")
# A Pages alias can serve the shell and then 404 again while the edge converges.
# Readiness only waits for that propagation; point sampling the runtime contract
# here fails the job on flapping the very next second.
if "verify-okou-app-runtime.sh" in readiness_source:
    raise RuntimeError("Pages readiness must not point sample the runtime contract")
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
    "${{ steps.pages-preview.outputs.canonical-dist }}/assets"
):
    raise RuntimeError("SharedWorker smoke test must use canonical app assets")
if turbo_source.count("bash .github/scripts/verify-okou-app-runtime.sh") != 1:
    raise RuntimeError(
        "the app preview runtime contract must be verified exactly once, with retries"
    )
if "if" in app_preview_url_step:
    raise RuntimeError(
        "the app preview gateway URL must always resolve, "
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
        "bash .github/scripts/verify-okou-app-runtime.sh",
        '"$pages_url"',
        '"https://static.okou.io/okou-app/assets"',
        '"$CANONICAL_ASSETS"',
        '"https://app.vm0.ai"',
        '"https://app.okou.ai"',
    ],
)
if release_step_source.count(shared_script) != 1:
    raise RuntimeError(
        "production readiness polling must follow exactly one Pages deployment"
    )
runtime_verifier = "bash .github/scripts/verify-okou-app-runtime.sh"
domain_verifier = "bash .github/scripts/verify-okou-production-domains.sh"
if not (
    release_step_source.index(shared_script)
    < release_step_source.index(runtime_verifier)
    < release_step_source.index(domain_verifier)
    < release_step_source.index('echo "url=$production_url"')
):
    raise RuntimeError(
        "production readiness and domain verification must finish before success output"
    )
if release_step.get("env", {}).get("CANONICAL_ASSETS") != (
    "${{ steps.pages-production.outputs.canonical-dist }}/assets"
):
    raise RuntimeError("production deploy must verify the canonical App bundles")
if release_step.get("env", {}).get("OKOU_APP_RUNTIME_MAX_ATTEMPTS") != "60":
    raise RuntimeError("production runtime convergence must use 60 bounded probes")
if not (
    release_steps.index(release_step) < release_steps.index(release_finish_step)
):
    raise RuntimeError(
        "production readiness must finish before the GitHub Deployment is reported"
    )
if release_finish_step.get("with", {}).get("status") != "${{ job.status }}":
    raise RuntimeError(
        "GitHub Deployment completion must fail closed on readiness verification"
    )
require_fragments(
    rollback_step,
    [shared_script, '"$PAGES_DIST"', '"$CF_PAGES_PROJECT_NAME"', "production", '"$TARGET_COMMIT"'],
)

for step in (preview_step, release_step, rollback_step):
    if "working-directory" in step:
        raise RuntimeError(f"shared Pages deployment must run from the repository root: {step['name']}")

for path, source in (
    (sys.argv[1], turbo_source),
    (sys.argv[2], release_source),
    (sys.argv[3], rollback_source),
):
    if "wrangler pages deploy" in source:
        raise RuntimeError(f"direct Pages deployment remains in {path}")

require_fragments(
    preview_step,
    ["pages-deploy-detailed", "deployment_url", "deployment_commit"],
)
if "WRANGLER_OUTPUT_FILE_PATH" not in preview_step.get("env", {}):
    raise RuntimeError("preview deployment no longer captures Wrangler output")

require_fragments(
    release_step,
    ["verify-okou-production-domains.sh", '"$pages_url"'],
)
require_fragments(
    release_api_verification_step,
    [
        "verify-okou-production-domains.sh",
        '"https://${CF_PAGES_PROJECT_NAME}.pages.dev"',
        "api-promotion",
    ],
)
if release_api_verification_step.get("shell") != "bash":
    raise RuntimeError("API production verification must use Bash")
if "app_release_created" in str(release_api_job.get("if", "")):
    raise RuntimeError("API production verification must not depend on an App release")
require_fragments(
    rollback_verification_step,
    [
        "verify-okou-production-domains.sh",
        '"https://${CF_PAGES_PROJECT_NAME}.pages.dev"',
    ],
)
for step in (release_step, rollback_verification_step):
    if "api-promotion" in str(step.get("run", "")):
        raise RuntimeError(
            f"post-App verification must enforce the API origin marker: {step['name']}"
        )

for fragment in (
    "https://app.vm0.ai",
    "https://app.okou.ai",
    "https://api.vm0.ai",
    "https://api.okou.ai",
    "sign-in",
    "sign-up",
    "%{redirect_url}",
    "vm0-api-origin",
    "Access-Control-Request-Method: GET",
    "%header{access-control-allow-origin}",
    "%header{access-control-allow-credentials}",
    "/api/__brand-smoke__",
    "api-promotion",
):
    if fragment not in production_verifier_source:
        raise RuntimeError(f"production verifier is missing: {fragment}")

for api_origin, app_origin in (
    ("https://api.vm0.ai", "https://app.vm0.ai"),
    ("https://api.okou.ai", "https://app.okou.ai"),
):
    invocations = (
        f'verify_auth_redirect "{api_origin}" "{app_origin}"',
        f'verify_api_origin_marker "{app_origin}" "{api_origin}"',
        f'verify_api_cors "{api_origin}" "{app_origin}"',
    )
    for invocation in invocations:
        if invocation not in production_verifier_source:
            raise RuntimeError(f"production verifier is missing mapping: {invocation}")

print("deploy-okou-pages workflow tests passed")
PY
