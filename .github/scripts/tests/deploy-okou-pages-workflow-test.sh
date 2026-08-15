#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

python3 - \
  "${repo_root}/.github/workflows/turbo.yml" \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/rollback-production.yml" <<'PY'
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

turbo_job = turbo["jobs"]["deploy-app"]
release_job = release["jobs"]["promote-app-production"]
rollback_job = rollback["jobs"]["rollback-app"]

preview_step = find_step(turbo_job, "Deploy Cloudflare Pages preview")
release_step = find_step(release_job, "Deploy Cloudflare Pages production")
rollback_step = find_step(rollback_job, "Deploy App to Cloudflare Pages production")

shared_script = "bash .github/scripts/deploy-okou-pages.sh"
require_fragments(
    preview_step,
    [shared_script, '"$PAGES_DIST"', '"$CF_PAGES_PROJECT_NAME"', '"$PAGES_BRANCH"', '"$ARTIFACT_SHA"'],
)
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

require_fragments(release_step, ["curl -fsSL", '"$pages_url"', '"$production_url"'])
require_fragments(
    rollback_step,
    ["curl -fsSL", '"https://${CF_PAGES_PROJECT_NAME}.pages.dev"', '"https://app.vm0.ai"'],
)

print("deploy-okou-pages workflow tests passed")
PY
