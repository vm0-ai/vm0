"""Generated builtin firewall catalog tests."""

import generated.builtin_firewalls as builtin_firewalls
from generated.builtin_firewalls import BUILTIN_FIREWALLS


def test_get_existing_builtin_firewall():
    firewall = BUILTIN_FIREWALLS.get("github")

    assert isinstance(firewall, dict)
    assert firewall["name"] == "github"
    assert firewall["apis"][0]["base"] == "https://api.github.com"


def test_unknown_builtin_firewall_does_not_import(monkeypatch):
    def fail_load(_name: str) -> tuple[str, ...]:
        raise AssertionError("unknown builtin lookup should not load JSON parts")

    sentinel = object()
    monkeypatch.setattr(builtin_firewalls, "load_json_parts", fail_load)

    assert BUILTIN_FIREWALLS.get("__missing__") is None
    assert BUILTIN_FIREWALLS.get("__missing__", sentinel) is sentinel


def test_mapping_methods_use_deterministic_manifest_order():
    keys = list(BUILTIN_FIREWALLS.keys())
    values = list(BUILTIN_FIREWALLS.values())
    items = list(BUILTIN_FIREWALLS.items())

    assert keys == sorted(keys)
    assert [firewall["name"] for firewall in values] == keys
    assert [name for name, _firewall in items] == keys
    assert list(iter(BUILTIN_FIREWALLS)) == keys
    assert len(BUILTIN_FIREWALLS) == len(keys)
    assert "github" in BUILTIN_FIREWALLS
    assert "__missing__" not in BUILTIN_FIREWALLS


def test_builtin_firewalls_cache_loaded_values():
    first = BUILTIN_FIREWALLS.get("github")
    second = BUILTIN_FIREWALLS.get("github")

    assert first is second
    assert BUILTIN_FIREWALLS["github"] is first


def test_builtin_firewalls_mapping_is_read_only():
    assert not hasattr(BUILTIN_FIREWALLS, "__setitem__")
