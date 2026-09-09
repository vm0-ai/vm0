#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 - "$repo_root" <<'PYTHON'
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
from unittest.mock import patch

root = Path(sys.argv[1])
workflow = (root / ".github/workflows/temporary-goal-archive-search-recovery.yml").read_text()
resolver = textwrap.dedent(workflow.split("python3 - <<'PYTHON'\n", 1)[1].split("          PYTHON", 1)[0])
source_check = textwrap.dedent(workflow.split("      - name: Validate mode and accepted operation source", 1)[1].split("        run: |\n", 1)[1].split("\n      - name:", 1)[0])
secret = "synthetic-private-provider-detail"
valid_uri = "postgresql://neondb_owner:synthetic-password@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require"
branches = {"branches": [{"id": "br-test", "name": "production"}]}

def check_resolution(responses, *, project="hidden-lab-39609750", success=False):
    calls = []
    class Opener:
        def open(self, request, timeout):
            assert request.full_url.startswith("https://console.neon.tech/api/v2/projects/hidden-lab-39609750/")
            assert timeout == 30
            calls.append(request.full_url)
            value = responses[len(calls) - 1]
            if isinstance(value, Exception):
                raise value
            return io.BytesIO(json.dumps(value).encode())

    with tempfile.TemporaryDirectory() as directory:
        transfer = Path(directory) / "environment"
        captured = io.StringIO()
        env = {"NEON_API_KEY": "synthetic-key", "NEON_PROJECT_ID": project, "GITHUB_ENV": str(transfer)}
        with patch.dict(os.environ, env, clear=True), patch("urllib.request.build_opener", return_value=Opener()), contextlib.redirect_stdout(captured):
            try:
                exec(compile(resolver, "workflow-resolver", "exec"), {})
            except SystemExit as error:
                assert not success
                assert str(error) == "production_database_resolution_failed"
            else:
                assert success
        text = captured.getvalue()
        assert secret not in text
        if success:
            assert len(calls) == 2
            assert "branch_id=br-test" in calls[1] and "pooled=false" in calls[1]
            assert text.startswith("::add-mask::postgresql://")
            assert "sslmode=verify-full" in text
            assert transfer.read_text() == "DATABASE_URL=" + text.split("::add-mask::", 1)[1].replace("%25", "%")
        else:
            assert text == ""
            assert not transfer.exists()

check_resolution([branches, {"uri": valid_uri}], success=True)
check_resolution([branches, {"uri": valid_uri}], project="different-project")
check_resolution([{"branches": []}])
check_resolution([{"branches": branches["branches"] * 2}])
check_resolution([{"branches": branches["branches"], "pagination": {"cursor": "more"}}])
check_resolution([ValueError(secret)])
check_resolution([branches, {"uri": None}])
for uri in [
    valid_uri + "\nINJECTED=value", valid_uri + "#fragment", "https://example.test/",
    valid_uri.replace(".neon.tech", ".neon.tech.evil.test"),
    valid_uri.replace("/neondb?", "/other?"),
    valid_uri.replace("neondb_owner:", "other:"),
    valid_uri.replace("synthetic-password", ""),
    valid_uri + "&sslmode=disable", valid_uri + "&sslrootcert=/tmp/unsafe",
    valid_uri + "&uselibpqcompat=true",
]:
    check_resolution([branches, {"uri": uri}])

# Mock only the external Git source boundary, so these executable checks also
# run in the PR pipeline's shallow checkout without fetching production history.
with tempfile.TemporaryDirectory() as directory:
    git = Path(directory) / "git"
    git.write_text('''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args == ["rev-parse", "HEAD"]:
    print("a" * 40)
elif args[:2] == ["merge-base", "--is-ancestor"]:
    assert args[2] in ("3e1544d55ac0dc54a1cdb21d6aee72d651a6808d", "cede9cbfb62872ddabb705de852dc6fd81a3cc6d")
    sys.exit(1 if os.environ.get("SOURCE_FAILURE") == "ancestor" else 0)
elif args[:2] == ["diff", "--quiet"]:
    assert args[2] == "cede9cbfb62872ddabb705de852dc6fd81a3cc6d"
    assert "turbo/packages/db/scripts/migrations/014-goal-archive-search" in args
    sys.exit(1 if os.environ.get("SOURCE_FAILURE") == "changed" else 0)
else:
    sys.exit(1)
''')
    git.chmod(0o700)
    def check_source(mode, failure="", sha="a" * 40):
        return subprocess.run(["bash", "-c", source_check], cwd=root,
            env={**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"],
                 "RECOVERY_MODE": mode, "GITHUB_SHA": sha, "SOURCE_FAILURE": failure},
            capture_output=True, text=True).returncode
    for mode in ["dry-run", "apply", "", "migrate", "apply --after-thread=x", "$(touch forbidden)"]:
        assert (check_source(mode) == 0) == (mode in ("dry-run", "apply"))
    assert check_source("apply", "ancestor") != 0
    assert check_source("apply", "changed") != 0
    assert check_source("apply", sha="b" * 40) != 0

assert workflow.count("  workflow_dispatch:") == 1
assert "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'" in workflow
assert workflow.index("pnpm install --frozen-lockfile --ignore-scripts") < workflow.index("${{ secrets.NEON_API_KEY }}")
assert workflow.index("pnpm install --frozen-lockfile --ignore-scripts") < workflow.index("${{ secrets.R2_ACCESS_KEY_ID }}")
assert "environment: production" in workflow and "cancel-in-progress: false" in workflow
assert "ref: ${{ github.sha }}" in workflow and "persist-credentials: false" in workflow
print("goal archive search recovery workflow: synthetic resolver and dispatch gates passed")
PYTHON
