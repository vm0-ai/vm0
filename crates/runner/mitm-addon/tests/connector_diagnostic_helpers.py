"""Helpers for connector diagnostic hook lifecycle tests."""

import json
from pathlib import Path

from mitmproxy import http

import mitm_addon
from tests.request_handler_helpers import _vm_without_firewalls, _write_registry

CONNECTOR_DIAGNOSTIC_REQUEST_CHUNK = b"partial request"


def connector_diagnostic_test_firewalls() -> dict[str, dict]:
    return {
        "fal": {
            "name": "fal",
            "apis": [
                {
                    "base": "https://fal.run",
                    "hostPolicy": {
                        "kind": "providerOwned",
                        "exactHosts": ["fal.run"],
                    },
                    "auth": {
                        "headers": {
                            "Authorization": "Bearer ${{ secrets.FAL_TOKEN }}",
                        }
                    },
                    "permissions": [
                        {
                            "name": "run",
                            "rules": ["POST /fal-ai/{model}"],
                        }
                    ],
                }
            ],
        },
        "openweather": {
            "name": "openweather",
            "apis": [
                {
                    "base": "https://api.openweathermap.org",
                    "hostPolicy": {
                        "kind": "providerOwned",
                        "exactHosts": ["api.openweathermap.org"],
                    },
                    "auth": {
                        "query": {
                            "appid": "${{ secrets.OPENWEATHER_TOKEN }}",
                        }
                    },
                    "permissions": [
                        {
                            "name": "read",
                            "rules": ["GET /{path+}"],
                        }
                    ],
                }
            ],
        },
    }


def _shared_base_catalog_firewall(
    name: str,
    token_name: str,
    *,
    auth: dict[str, object] | None = None,
    permissions: list[dict[str, object]] | None = None,
) -> dict:
    resolved_auth = (
        {
            "headers": {
                "Authorization": f"Bearer ${{{{ secrets.{token_name} }}}}",
            },
            "query": {
                "api_key": f"${{{{ secrets.{token_name} }}}}",
            },
        }
        if auth is None
        else auth
    )
    return {
        "name": name,
        "apis": [
            {
                "base": "https://shared.example.com",
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": ["shared.example.com"],
                },
                "auth": resolved_auth,
                "permissions": permissions or [],
            }
        ],
    }


def write_connector_diagnostic_catalog_cache(
    tmp_path: Path,
    *,
    firewalls: dict[str, dict] | None = None,
    digest: str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version: str = "catalog-test",
) -> Path:
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    replacement_path = tmp_path / "builtin-firewall-catalog-cache.next.json"
    replacement_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "catalogDigest": digest,
                "catalogVersion": version,
                "updatedAt": "2026-07-07T00:00:00.000Z",
                "firewalls": (
                    connector_diagnostic_test_firewalls() if firewalls is None else firewalls
                ),
            },
            sort_keys=True,
        )
    )
    replacement_path.chmod(0o600)
    replacement_path.replace(cache_path)
    return cache_path


def write_shared_base_diagnostic_catalog(
    tmp_path: Path,
    *,
    active_permissions: list[dict[str, object]] | None = None,
    inactive_auth: dict[str, object] | None = None,
    inactive_permissions: list[dict[str, object]] | None = None,
) -> None:
    firewalls = {
        "active-shared": _shared_base_catalog_firewall(
            "active-shared",
            "ACTIVE_TOKEN",
            permissions=active_permissions,
        ),
        "inactive-shared": _shared_base_catalog_firewall(
            "inactive-shared",
            "INACTIVE_TOKEN",
            auth=inactive_auth,
            permissions=inactive_permissions,
        ),
    }
    write_connector_diagnostic_catalog_cache(tmp_path, firewalls=firewalls)


def write_connector_diagnostic_capture_registry(tmp_path: Path) -> Path:
    write_connector_diagnostic_catalog_cache(tmp_path)
    return _write_registry(
        tmp_path,
        vm_info=_vm_without_firewalls(
            tmp_path,
            vm_fields={"captureNetworkBodies": True},
        ),
    )


def record_connector_diagnostic_requestheaders_context(
    flow: http.HTTPFlow,
    *,
    request_chunk: bytes = CONNECTOR_DIAGNOSTIC_REQUEST_CHUNK,
) -> bytes:
    result = mitm_addon.requestheaders(flow)
    assert result is None
    stream = flow.request.stream
    assert callable(stream)
    assert stream(request_chunk) == request_chunk
    return request_chunk
