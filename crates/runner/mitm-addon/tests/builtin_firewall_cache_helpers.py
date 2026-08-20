"""Helpers shared by valid built-in firewall catalog cache fixtures."""

import json


def serialize_builtin_firewall_catalog_cache(
    *,
    digest: str,
    version: str,
    firewalls: dict[str, dict],
) -> str:
    return json.dumps(
        {
            "schemaVersion": 1,
            "catalogDigest": digest,
            "catalogVersion": version,
            "updatedAt": "2026-07-07T00:00:00.000Z",
            "firewalls": firewalls,
        },
        sort_keys=True,
    )
