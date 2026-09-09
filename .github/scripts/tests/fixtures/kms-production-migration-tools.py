#!/usr/bin/env python3
"""Isolated provider/transport boundaries for the real KMS workflow CLI test."""

import json
import os
from pathlib import Path
import subprocess
import sys


binary = Path(sys.argv[0])
state_path = binary.parent.parent / "provider.json"
state = json.loads(state_path.read_text())
name = binary.name
arguments = sys.argv[1:]
scenario = state["scenario"]
source = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
target = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"

if name == "pnpm":
    if arguments[2].endswith("/verify-business.ts"):
        # The business verifier has its own HTTP + real-Postgres integration
        # suite. Here exercise the workflow driver's child-process boundary.
        assert not any(name.startswith("AWS_") for name in os.environ)
        assert "NEON_API_KEY" not in os.environ
        assert "VERCEL_TOKEN" not in os.environ
        assert os.environ["CLERK_SECRET_KEY"] == "synthetic-clerk-secret"
        assert arguments[5:] == ["user_fixture", "org_fixture", "agent_fixture"]
        business = {
            "result": "passed", "cleanup": "passed", "cleanupFailures": [],
            "historicalCiphertextWrites": 0, "fixtureWrites": 4,
            "checks": [
                "deployed_webhook_create_and_reveal_target_key",
                "deployed_connector_add_and_shared_reader",
                "deployed_connector_reconnect_and_shared_reader",
                "deployed_source_envelope_read", "deployed_source_legacy_read",
            ],
        }
        if scenario == "business-incomplete":
            business["cleanup"] = "failed"
        Path(arguments[4]).write_text(json.dumps(business))
        sys.exit(0)
    # Delegate to the actual migration and canary TypeScript entry points.
    # Only the external KMS endpoint and database connection are redirected.
    env = {**os.environ, "AWS_ENDPOINT_URL_KMS": state["kmsEndpoint"]}
    if "DATABASE_URL" in env:
        env["DATABASE_URL"] = state["databaseUrl"]
    result = subprocess.run([state["pnpm"], *arguments], env=env, check=False)
    sys.exit(result.returncode)

if name == "aws":
    if arguments[:2] == ["sts", "assume-role-with-web-identity"]:
        payload = json.load(sys.stdin)
        assert (
            payload["RoleArn"]
            == "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264"
        )
        assert payload["WebIdentityToken"] == "synthetic-oidc-token"
        state["assumeCalls"] += 1
        result = {
            "Credentials": {
                "AccessKeyId": "operator",
                "SecretAccessKey": "synthetic-operator-secret",
                "SessionToken": "synthetic-operator-session",
            }
        }
    else:
        assert arguments[:2] == ["sts", "get-caller-identity"]
        principal = os.environ["AWS_ACCESS_KEY_ID"]
        account = "072707626411" if principal == "source" else "251964670836"
        arn = f"arn:aws:iam::{account}:user/vm0-kms-prod"
        if principal == "operator":
            arn = "arn:aws:sts::251964670836:assumed-role/vm0-kms-migration-github-32264/github-kms-12345"
            if scenario == "wrong-operator":
                arn = "arn:aws:iam::251964670836:user/vm0-kms-prod"
        result = {"Account": account, "Arn": arn}
    state_path.write_text(json.dumps(state))
    print(json.dumps(result))
    sys.exit(0)

assert name == "curl"
url = next(value for value in arguments if value.startswith("https://"))
status = 200
if ".actions.githubusercontent.com/" in url:
    result = {"value": "synthetic-oidc-token"}
elif url == "https://api.doppler.com/v3/auth/oidc":
    result = {"token": "synthetic-doppler-token"}
elif "api.doppler.com/v3/configs/config/secrets" in url:
    raw = json.dumps(state["snapshot"], separators=(",", ":"))
    if scenario == "backup-changed":
        raw += " "
    result = {
        "secrets": {
            "KMS_BACKUP_JSON": {
                "raw": raw,
                "computed": raw,
                "rawVisibility": "masked",
                "computedVisibility": "masked",
            }
        }
    }
elif "api.vercel.com/v9/projects/" in url:
    state["deploymentReads"] += 1
    deployment = "dpl_fixture"
    if scenario == "deployment-changed" and state["deploymentReads"] >= 2:
        deployment = "dpl_changed"
    result = {
        "id": "prj_6mw0CgYjECVrJV57VJ47VN03B4UR",
        "accountId": "team_WRqI0kCoX5KcRInRWgZ1nBF0",
        "targets": {
            "production": {
                "id": deployment,
                "url": "fixture.vm6.ai",
                "readyState": "READY",
                "target": "production",
                "alias": ["api.okou.ai"],
                "meta": {"githubCommitSha": "b" * 40},
            }
        },
    }
elif "console.neon.tech/api/v2/projects/hidden-lab-39609750/branches" in url:
    result = {"branches": [{"id": "br-fixture", "name": "production"}]}
elif "console.neon.tech/api/v2/projects/hidden-lab-39609750/connection_uri?" in url:
    result = {
        "uri": "postgresql://neondb_owner:synthetic-database-secret@fixture.neon.tech/neondb"
    }
else:
    raise AssertionError("unhandled provider boundary")
if scenario == "provider-error":
    status = 403
    result = {"error": "synthetic-provider-secret-must-not-be-logged"}
state_path.write_text(json.dumps(state))
print(json.dumps(result) + "\n" + str(status), end="")
