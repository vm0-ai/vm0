"""Generated builtin firewall catalog tests."""

import generated.builtin_firewalls as builtin_firewalls


def _rules_for_builtin_permission(firewall: dict, permission_name: str) -> list[str]:
    for api in firewall["apis"]:
        for permission in api["permissions"]:
            if permission["name"] == permission_name:
                return permission["rules"]
    raise AssertionError(f"missing builtin permission: {permission_name}")


def test_get_existing_builtin_firewall():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS.get("github")

    assert isinstance(firewall, dict)
    assert firewall["name"] == "github"
    assert firewall["apis"][0]["base"] == "https://api.github.com"


def test_unknown_builtin_firewall_does_not_import(monkeypatch):
    def fail_load(_name: str) -> tuple[str, ...]:
        raise AssertionError("unknown builtin lookup should not load JSON parts")

    sentinel = object()
    monkeypatch.setattr(builtin_firewalls, "load_json_parts", fail_load)

    assert builtin_firewalls.BUILTIN_FIREWALLS.get("__missing__") is None
    assert builtin_firewalls.BUILTIN_FIREWALLS.get("__missing__", sentinel) is sentinel


def test_mapping_methods_use_deterministic_manifest_order():
    keys = list(builtin_firewalls.BUILTIN_FIREWALLS.keys())
    values = list(builtin_firewalls.BUILTIN_FIREWALLS.values())
    items = list(builtin_firewalls.BUILTIN_FIREWALLS.items())

    assert keys == sorted(keys)
    assert [firewall["name"] for firewall in values] == keys
    assert [name for name, _firewall in items] == keys
    assert list(iter(builtin_firewalls.BUILTIN_FIREWALLS)) == keys
    assert len(builtin_firewalls.BUILTIN_FIREWALLS) == len(keys)
    assert "github" in builtin_firewalls.BUILTIN_FIREWALLS
    assert "__missing__" not in builtin_firewalls.BUILTIN_FIREWALLS


def test_builtin_firewalls_cache_loaded_values():
    first = builtin_firewalls.BUILTIN_FIREWALLS.get("github")
    second = builtin_firewalls.BUILTIN_FIREWALLS.get("github")

    assert first is second
    assert builtin_firewalls.BUILTIN_FIREWALLS["github"] is first


def test_aws_builtin_firewall_includes_same_name_override_rules():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["aws"]

    assert (
        "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.RestoreTableToPointInTime"
        in _rules_for_builtin_permission(
            firewall,
            "dynamodb:RestoreTableToPointInTime",
        )
    )
    assert "GET /{Bucket}/{Key+}?attributes AWS sigv4=s3" in (
        _rules_for_builtin_permission(firewall, "s3:GetObjectAttributes")
    )
    assert (
        "POST /@connections/{connectionId} AWS sigv4=execute-api"
        in _rules_for_builtin_permission(firewall, "execute-api:ManageConnections")
    )
    assert (
        "GET /2013-01-01/search?format=sdk&pretty=true&q=* AWS sigv4=cloudsearch"
        in _rules_for_builtin_permission(firewall, "cloudsearch:search")
    )
    assert "GET /{Bucket}/{Key+}?uploadId=* AWS sigv4=s3" in _rules_for_builtin_permission(
        firewall, "s3:ListMultipartUploadParts"
    )


def test_builtin_firewalls_mapping_is_read_only():
    assert not hasattr(builtin_firewalls.BUILTIN_FIREWALLS, "__setitem__")
