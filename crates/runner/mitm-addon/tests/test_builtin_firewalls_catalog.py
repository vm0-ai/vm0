"""Generated builtin firewall catalog tests."""

import generated.builtin_firewalls as builtin_firewalls


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


def test_builtin_firewalls_mapping_is_read_only():
    assert not hasattr(builtin_firewalls.BUILTIN_FIREWALLS, "__setitem__")


def test_google_drive_builtin_uses_vm0_permissions():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["google-drive"]
    names = {
        permission["name"] for api in firewall["apis"] for permission in api.get("permissions", [])
    }

    assert "apps.read" in names
    assert "files.write" in names
    assert "drive.apps.readonly" not in names
    assert "drive.file" not in names
    assert all(not name.startswith("drive.") for name in names)


def test_gmail_firewall_uses_resource_permissions():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["gmail"]
    permissions = {
        permission["name"] for api in firewall["apis"] for permission in api.get("permissions", [])
    }

    assert "messages.send" in permissions
    assert "drafts.write" in permissions
    assert "settings.sharing" in permissions
    assert "gmail.send" not in permissions
    assert "gmail.modify" not in permissions
    assert not [name for name in permissions if name.startswith("gmail.")]
