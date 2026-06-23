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


def test_figma_firewall_uses_granular_permissions():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["figma"]
    permissions = {
        permission["name"] for api in firewall["apis"] for permission in api.get("permissions", [])
    }

    assert "file_content:read" in permissions
    assert "file_metadata:read" in permissions
    assert "file_comments:read" in permissions
    assert "projects:read" in permissions
    assert "webhooks:read" in permissions
    assert "files:read" not in permissions


def test_figma_firewall_has_one_owner_per_route():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["figma"]
    route_owners: dict[tuple[str, str], str] = {}
    duplicates: list[tuple[str, str, str, str]] = []

    for api in firewall["apis"]:
        base = api["base"]
        for permission in api.get("permissions", []):
            permission_name = permission["name"]
            for rule in permission.get("rules", []):
                key = (base, rule)
                existing = route_owners.get(key)
                if existing is not None:
                    duplicates.append((base, rule, existing, permission_name))
                    continue
                route_owners[key] = permission_name

    assert duplicates == []
    assert route_owners[("https://api.figma.com", "GET /v1/files/{file_key}")] == (
        "file_content:read"
    )
    assert route_owners[("https://api.figma.com", "GET /v1/files/{file_key}/meta")] == (
        "file_metadata:read"
    )
    assert route_owners[("https://api.figma.com", "GET /v1/files/{file_key}/comments")] == (
        "file_comments:read"
    )
    assert route_owners[("https://api.figma.com", "GET /v1/projects/{project_id}/files")] == (
        "projects:read"
    )
    assert route_owners[("https://api.figma.com", "GET /v2/webhooks/{webhook_id}")] == (
        "webhooks:read"
    )


def test_slack_firewall_uses_shared_route_permissions():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["slack"]
    permissions = {
        permission["name"] for api in firewall["apis"] for permission in api.get("permissions", [])
    }

    assert "assistant.search:read" in permissions
    assert "conversations:history" in permissions
    assert "conversations:read" in permissions
    assert "conversations:write" in permissions
    assert "conversations:write.invites" in permissions
    assert "conversations:write.topic" in permissions
    assert "conversations.connect:read" in permissions


def test_slack_firewall_has_one_owner_per_route():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["slack"]
    route_owners: dict[tuple[str, str], str] = {}
    duplicates: list[tuple[str, str, str, str]] = []

    for api in firewall["apis"]:
        base = api["base"]
        for permission in api.get("permissions", []):
            permission_name = permission["name"]
            for rule in permission.get("rules", []):
                key = (base, rule)
                existing = route_owners.get(key)
                if existing is not None:
                    duplicates.append((base, rule, existing, permission_name))
                    continue
                route_owners[key] = permission_name

    assert duplicates == []
    assert route_owners[("https://slack.com/api", "GET /conversations.history")] == (
        "conversations:history"
    )
    assert route_owners[("https://slack.com/api", "GET /conversations.info")] == (
        "conversations:read"
    )
    assert route_owners[("https://slack.com/api", "POST /conversations.archive")] == (
        "conversations:write"
    )
    assert route_owners[("https://slack.com/api", "POST /conversations.invite")] == (
        "conversations:write.invites"
    )
    assert route_owners[("https://slack.com/api", "POST /conversations.setTopic")] == (
        "conversations:write.topic"
    )
    assert route_owners[("https://slack.com/api", "POST /assistant.search.context")] == (
        "assistant.search:read"
    )


def test_strava_firewall_uses_tiered_route_permissions():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["strava"]
    permissions = {
        permission["name"] for api in firewall["apis"] for permission in api.get("permissions", [])
    }

    assert "activities:read" in permissions
    assert "profile:read" in permissions
    assert "routes:read" in permissions
    assert "segments:read" in permissions
    assert "activity:read" not in permissions
    assert "activity:read_all" not in permissions


def test_strava_firewall_has_one_owner_per_route():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["strava"]
    route_owners: dict[tuple[str, str], str] = {}
    duplicates: list[tuple[str, str, str, str]] = []

    for api in firewall["apis"]:
        base = api["base"]
        for permission in api.get("permissions", []):
            permission_name = permission["name"]
            for rule in permission.get("rules", []):
                key = (base, rule)
                existing = route_owners.get(key)
                if existing is not None:
                    duplicates.append((base, rule, existing, permission_name))
                    continue
                route_owners[key] = permission_name

    assert duplicates == []
    assert route_owners[("https://www.strava.com", "GET /api/v3/activities/{id}")] == (
        "activities:read"
    )
    assert route_owners[("https://www.strava.com", "GET /api/v3/athlete")] == ("profile:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/routes/{id}")] == ("routes:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/segments/{id}")] == (
        "segments:read"
    )
