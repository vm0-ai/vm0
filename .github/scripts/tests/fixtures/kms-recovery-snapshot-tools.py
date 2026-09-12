#!/usr/bin/env python3
"""External Neon and PostgreSQL boundaries for the recovery inspection CLI."""

import json
import os
from pathlib import Path
import sys
import urllib.parse

state_path = Path(os.environ["FIXTURE_STATE"])
state = json.loads(state_path.read_text())
scenario = state["scenario"]
project = "hidden-lab-39609750"
name = "kms-recovery-32264-12345-1"
production = {
    "id": "br-production",
    "project_id": project,
    "name": "production",
    "default": True,
    "protected": True,
}
preview = {
    "id": "br-preview",
    "project_id": project,
    "name": name,
    "default": False,
    "protected": False,
    "restored_from": "snapshot-manual",
    "restore_status": "restored",
}
endpoint = {
    "id": "ep-preview",
    "branch_id": "br-preview",
    "host": "ep-preview.us-west-2.aws.neon.tech",
    "type": "read_write",
}
snapshot = {
    "id": "snapshot-manual",
    "source_branch_id": "br-production",
    "created_at": "2026-02-16T05:57:00Z",
    "manual": True,
}


def save():
    state_path.write_text(json.dumps(state))


def respond(data, status=200):
    save()
    print(json.dumps(data) + "\n" + str(status), end="")
    raise SystemExit(0)


if Path(sys.argv[0]).name == "psql":
    state["sqlCalls"] = state.get("sqlCalls", 0) + 1
    save()
    assert os.environ["PGHOST"] == endpoint["host"]
    assert os.environ["PGDATABASE"] == "neondb"
    assert os.environ["PGPASSWORD"] == "fixture-private-password"
    assert os.environ["PGSSLMODE"] == "verify-full"
    assert os.environ["PGSSLROOTCERT"] == "/etc/ssl/certs/ca-certificates.crt"
    assert "default_transaction_read_only=on" in os.environ["PGOPTIONS"]
    assert "-X" in sys.argv and "NEON_API_KEY" not in os.environ
    if scenario == "sql-failure":
        sys.stderr.write("fixture-private-password")
        raise SystemExit(1)
    print(
        json.dumps(
            {
                "kind": "database",
                "readOnly": True,
                "isolation": "repeatable read",
                "largeObjects": 0,
                "foreignTables": 0,
            }
        )
    )
    print(
        json.dumps(
            {
                "kind": "table",
                "relationOid": 123,
                "rows": 20,
                "rowsWithEnvelopeMarker": 3,
                "rowsWithSourceReference": 0,
                "private": "fixture-private-password",
            }
        )
    )
    raise SystemExit(0)

assert Path(sys.argv[0]).name == "curl"
method = sys.argv[sys.argv.index("--request") + 1]
url = urllib.parse.urlsplit(sys.argv[-1])
assert url.netloc == "console.neon.tech"
assert "--location" not in sys.argv
path = url.path.removeprefix("/api/v2/projects/" + project)
query = urllib.parse.parse_qs(url.query)
body = json.load(sys.stdin) if "--data-binary" in sys.argv else None
state["calls"].append({"method": method, "path": path, "query": query, "body": body})
save()
if path == "/snapshots" and method == "GET":
    respond({"snapshots": [snapshot]})
if path == "/branches" and method == "GET":
    branches = [production]
    if (
        scenario == "existing-preview"
        or state.get("restored")
        and not state.get("deleted")
    ):
        branches.append(preview)
    if state.get("deleted") and query.get("include_deleted") == ["true"]:
        branches.append(
            {**preview, "recovery": {"recoverable_until": "2026-09-18T00:00:00Z"}}
        )
    if scenario == "repeated-page":
        respond({"branches": branches, "pagination": {"next": "repeat"}})
    respond({"branches": branches})
if path == "/branches/br-production" and method == "GET":
    respond({"branch": production})
if path == "/endpoints" and method == "GET":
    endpoints = [
        {
            "id": "ep-production",
            "branch_id": "br-production",
            "host": "ep-production.us-west-2.aws.neon.tech",
            "type": "read_write",
        }
    ]
    if (
        state.get("endpointCreated")
        and not state.get("deleted")
        and scenario != "endpoint-absent-from-project-list"
    ):
        endpoints.append(endpoint)
    respond({"endpoints": endpoints})
if path == "/branches/br-preview/endpoints" and method == "GET":
    endpoints = [endpoint] if state.get("endpointCreated") else []
    if scenario == "ambiguous-preview-endpoints":
        endpoints = [endpoint, {**endpoint, "id": "ep-second"}]
    respond({"endpoints": endpoints})
if path == "/endpoints/ep-preview" and method == "GET":
    assert state.get("endpointCreated")
    current = (
        {**endpoint, "branch_id": "br-production"}
        if scenario == "endpoint-readback-production"
        else endpoint
    )
    respond({"endpoint": current})
if path == "/snapshots/snapshot-manual/restore" and method == "POST":
    assert body == {"name": name, "finalize_restore": False}
    state["restored"] = True
    save()
    if scenario == "unknown-restore-outcome":
        sys.stderr.write("fixture-private-password")
        raise SystemExit(28)
    if scenario == "production-returned":
        respond({"branch": production, "operations": []})
    respond({"branch": preview, "operations": [{"id": "op-restore"}]})
if path.startswith("/operations/") and method == "GET":
    respond({"operation": {"id": path.rsplit("/", 1)[1], "status": "finished"}})
if path == "/branches/br-preview" and method == "GET":
    respond({"message": "fixture-private-password"}, 404) if state.get(
        "deleted"
    ) else respond({"branch": preview})
if path == "/branches/br-preview" and method == "DELETE":
    if scenario == "cleanup-denied":
        respond({"message": "fixture-private-password"}, 403)
    state["deleted"] = True
    respond({"operations": [{"id": "op-delete"}]})
if path == "/endpoints" and method == "POST":
    assert body["endpoint"]["branch_id"] == "br-preview"
    assert body["endpoint"]["suspend_timeout_seconds"] == 60
    state["endpointCreated"] = True
    respond({"endpoint": endpoint, "operations": [{"id": "op-endpoint"}]})
if path == "/branches/br-preview/databases" and method == "GET":
    respond(
        {
            "databases": [
                {
                    "branch_id": "br-preview",
                    "name": "neondb",
                    "owner_name": "neondb_owner",
                }
            ]
        }
    )
if path == "/connection_uri" and method == "GET":
    assert query["branch_id"] == ["br-preview"] and query["endpoint_id"] == [
        "ep-preview"
    ]
    host = (
        "ep-production.us-west-2.aws.neon.tech"
        if scenario == "production-uri"
        else endpoint["host"]
    )
    respond(
        {
            "uri": "postgresql://neondb_owner:fixture-private-password@"
            + host
            + "/neondb?sslmode=require"
        }
    )
raise AssertionError("unexpected external operation")
