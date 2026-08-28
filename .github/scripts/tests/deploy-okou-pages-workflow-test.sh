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

preview_step = find_step(turbo_job, "Deploy Cloudflare Pages preview")
prepare_preview_step = find_step(turbo_job, "Prepare Cloudflare Pages preview")
publish_assets_step = find_step(turbo_job, "Publish immutable app assets to R2")
release_step = find_step(release_job, "Deploy Cloudflare Pages production")
release_api_verification_step = find_step(
    release_api_job, "Verify production App and API domains"
)
rollback_step = find_step(rollback_job, "Deploy App to Cloudflare Pages production")
rollback_verification_step = find_step(
    rollback_verification_job, "Verify production App and API domains"
)

shared_script = "bash .github/scripts/deploy-okou-pages.sh"
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

turbo_steps = turbo_job["steps"]
if not (
    turbo_steps.index(prepare_preview_step)
    < turbo_steps.index(publish_assets_step)
    < turbo_steps.index(preview_step)
):
    raise RuntimeError("R2 asset publication must run before Pages deployment")
require_fragments(
    release_step,
    [shared_script, '"$PAGES_DIST"', '"$CF_PAGES_PROJECT_NAME"', "production", '"$ARTIFACT_SHA"'],
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
