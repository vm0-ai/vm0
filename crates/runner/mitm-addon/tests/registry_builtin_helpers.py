"""Helpers shared by built-in registry cache tests."""

import matching
from tests.builtin_firewall_cache_helpers import serialize_builtin_firewall_catalog_cache
from tests.registry_helpers import (
    write_multi_sandbox_registry,
    write_trusted_catalog_cache_text,
)


def first_firewall_core(compiled_firewalls: matching.CompiledFirewallSet):
    return compiled_firewalls.firewalls[0].core


def cache_firewall(name: str, base: str, *, rules: list[str] | None = None) -> dict:
    return {
        "name": name,
        "apis": [
            {
                "base": base,
                "hostPolicy": {
                    "kind": "providerOwned",
                    "exactHosts": [base.removeprefix("https://")],
                },
                "auth": {
                    "awsSigv4": {
                        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
                    }
                },
                "permissions": [{"name": "read", "rules": rules or ["GET /items"]}],
            }
        ],
    }


def github_cache_firewall() -> dict:
    return {
        "name": "github",
        "apis": [
            {
                "base": "https://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "read", "rules": ["GET /repos/{owner}/{repo}"]}],
            }
        ],
    }


def write_catalog_cache(
    path,
    *,
    digest: str,
    version: str,
    firewalls: dict[str, dict],
) -> None:
    write_trusted_catalog_cache_text(
        path,
        serialize_builtin_firewall_catalog_cache(
            digest=digest,
            version=version,
            firewalls=firewalls,
        ),
    )


def write_registry_with_cache(
    tmp_path,
    sandboxes: dict,
    firewalls: dict[str, dict],
    *,
    digest: str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    version: str = "catalog-a",
):
    registry_path = tmp_path / "registry.json"
    cache_path = tmp_path / "builtin-firewall-catalog-cache.json"
    write_multi_sandbox_registry(registry_path, sandboxes)
    write_catalog_cache(
        cache_path,
        digest=digest,
        version=version,
        firewalls=firewalls,
    )
    return registry_path, cache_path
