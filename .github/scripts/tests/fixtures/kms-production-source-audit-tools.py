#!/usr/bin/env python3
"""Fixed read-only provider boundaries for the production source audit CLI."""

import json
import os
from pathlib import Path
import sys


binary = Path(sys.argv[0])
state_path = binary.parent.parent / "provider.json"
state = json.loads(state_path.read_text())
arguments = sys.argv[1:]
scenario = state["scenario"]
source = state["snapshot"]["sourceKeyArn"]
result = None
status = 200

if binary.name == "curl":
    url = next(value for value in arguments if value.startswith("https://"))
    if ".actions.githubusercontent.com/" in url:
        state["calls"].append("oidc")
        result = {"value": "synthetic-oidc-secret"}
    elif url == "https://api.doppler.com/v3/auth/oidc":
        state["calls"].append("doppler-auth")
        assert json.loads(sys.stdin.read())["token"] == "synthetic-oidc-secret"
        result = {"token": "synthetic-doppler-secret"}
    else:
        assert url == (
            "https://api.doppler.com/v3/configs/config/secrets?"
            "project=vm0-kms-rollback-32264&config=prd&include_managed_secrets=false"
        )
        assert arguments[arguments.index("--request") + 1] == "GET"
        state["calls"].append("backup-read")
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
    state_path.write_text(json.dumps(state))
    print(json.dumps(result) + "\n" + str(status), end="")
    sys.exit(0)

assert binary.name == "aws"
assert os.environ["AWS_ACCESS_KEY_ID"] == "synthetic-source-access-key"
assert not os.environ.get("AWS_SESSION_TOKEN")
for name in [
    "VERCEL_TOKEN",
    "NEON_API_KEY",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "DOPPLER_SERVICE_IDENTITY_ID",
    "AWS_ENDPOINT_URL",
]:
    assert name not in os.environ
assert arguments[-4:] == ["--region", "us-west-2", "--output", "json"]
if arguments[:2] == ["sts", "get-caller-identity"]:
    state["calls"].append("source-sts")
    result = {
        "Account": "072707626411",
        "Arn": "arn:aws:iam::072707626411:user/vm0-kms-prod",
    }
    if scenario == "wrong-account":
        result["Account"] = "251964670836"
else:
    assert arguments[:3] == ["cloudtrail", "lookup-events", "--no-paginate"]
    file = Path(
        arguments[arguments.index("--cli-input-json") + 1].removeprefix("file://")
    )
    payload = json.loads(file.read_text())
    assert json.loads(file.read_text()) == payload
    assert payload["MaxResults"] == 50
    assert payload["StartTime"] == state["windowStart"]
    assert payload["LookupAttributes"][0]["AttributeKey"] == "ResourceName"
    resource = payload["LookupAttributes"][0]["AttributeValue"]
    assert resource in {source, source.rsplit("/", 1)[1]}
    state["calls"].append("lookup-arn" if resource == source else "lookup-id")
    if scenario == "denied" or (scenario == "partial-denied" and resource != source):
        state_path.write_text(json.dumps(state))
        print("synthetic-provider-secret-must-not-leak")
        print(
            "An error occurred (AccessDeniedException) when calling the LookupEvents operation: synthetic-provider-secret-must-not-leak",
            file=sys.stderr,
        )
        sys.exit(255)
    event_id = "11111111-2222-3333-4444-555555555555"
    name = "Decrypt" if scenario in {"crypto", "partial-denied"} else "DescribeKey"
    if scenario == "unknown-event":
        name = "synthetic-provider-secret-must-not-leak"
    raw = {
        "eventID": event_id,
        "eventSource": "kms.amazonaws.com",
        "awsRegion": "us-west-2",
        "recipientAccountId": "072707626411",
        "eventTime": state["eventTime"],
        "eventName": name,
        "userIdentity": {
            "type": "IAMUser",
            "arn": "synthetic-private-identity",
            "principalId": "synthetic-private-principal",
            "accessKeyId": "synthetic-source-access-key",
        },
        "requestParameters": {"secret": "synthetic-provider-secret-must-not-leak"},
    }
    if scenario == "wrong-event-scope":
        raw["recipientAccountId"] = "251964670836"
    if scenario == "duplicate-changed" and resource != source:
        raw["requestParameters"] = {
            "different": "synthetic-provider-secret-must-not-leak"
        }
    event = {
        "EventId": event_id,
        "EventName": name,
        "Resources": [{"ResourceName": source}],
        "CloudTrailEvent": json.dumps(raw),
    }
    result = {"Events": [] if scenario == "empty" else [event]}
    if scenario == "pagination" and not payload.get("NextToken"):
        result["NextToken"] = "synthetic-next-page-secret"
    if scenario == "repeated-token":
        result["NextToken"] = "synthetic-next-page-secret"
state_path.write_text(json.dumps(state))
print(json.dumps(result))
