"""Generated builtin firewall catalog tests."""

from dataclasses import dataclass

import generated.builtin_firewalls as builtin_firewalls
import matching

READ_LIKE_PERMISSION_NAMES = {"read", "readonly"}
READ_LIKE_PERMISSION_SUFFIXES = (":read", ".read")
READ_LIKE_MUTATION_METHODS = {"DELETE", "PATCH", "PUT"}
VALID_RULE_METHODS = {
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
    "ANY",
}


@dataclass(frozen=True)
class RuleReference:
    permission_name: str
    rule: str


@dataclass(frozen=True)
class ParsedRule:
    method: str
    segments: tuple[dict[str, str], ...]


def _is_read_like_permission(name: str) -> bool:
    return name in READ_LIKE_PERMISSION_NAMES or name.endswith(READ_LIKE_PERMISSION_SUFFIXES)


def _split_path_segments(path: str) -> list[str]:
    if path in ("", "/"):
        return []
    path_without_leading_slash = path[1:] if path.startswith("/") else path
    if path_without_leading_slash == "":
        return []
    return path_without_leading_slash.split("/")


def _parse_rule(rule: str) -> ParsedRule:
    method, path = rule.split(" ", maxsplit=1)
    assert method in VALID_RULE_METHODS
    assert path.startswith("/")

    segments = tuple(matching.parse_segment(segment) for segment in _split_path_segments(path))
    param_names: set[str] = set()
    last_index = len(segments) - 1
    for index, segment in enumerate(segments):
        assert segment["kind"] != "error"
        if segment["kind"] == "literal":
            continue

        name = segment["name"]
        assert name not in param_names
        param_names.add(name)
        assert segment["greedy"] == "" or index == last_index
        assert segment["greedy"] == "" or (segment["prefix"] == "" and segment["suffix"] == "")

    return ParsedRule(method=method, segments=segments)


def _intersect_methods(left: str, right: str) -> str | None:
    if left == right:
        return "GET" if left == "ANY" else left
    if left == "ANY":
        return right
    if right == "ANY":
        return left
    return None


def _is_greedy_segment(segment: dict[str, str] | None) -> bool:
    return segment is not None and segment["kind"] == "param" and segment["greedy"] != ""


def _segment_matches_param(value: str, pattern: dict[str, str]) -> bool:
    if pattern["greedy"] != "":
        return value != ""
    if pattern["prefix"] == "" and pattern["suffix"] == "":
        return value != ""
    return (
        value.startswith(pattern["prefix"])
        and value.endswith(pattern["suffix"])
        and len(value) > len(pattern["prefix"]) + len(pattern["suffix"])
    )


def _segment_witness(segment: dict[str, str]) -> str:
    if segment["kind"] == "literal":
        return segment["value"]
    if segment["prefix"] == "" and segment["suffix"] == "":
        return "x"
    return f"{segment['prefix']}x{segment['suffix']}"


def _intersect_param_segments(left: dict[str, str], right: dict[str, str]) -> str | None:
    prefix = left["prefix"] if len(left["prefix"]) >= len(right["prefix"]) else right["prefix"]
    if not prefix.startswith(left["prefix"]) or not prefix.startswith(right["prefix"]):
        return None

    suffix = left["suffix"] if len(left["suffix"]) >= len(right["suffix"]) else right["suffix"]
    if not suffix.endswith(left["suffix"]) or not suffix.endswith(right["suffix"]):
        return None

    for candidate in (f"{prefix}x{suffix}", f"{prefix}{suffix}x"):
        if _segment_matches_param(candidate, left) and _segment_matches_param(candidate, right):
            return candidate
    return None


def _intersect_fixed_segments(left: dict[str, str], right: dict[str, str]) -> str | None:
    if left["kind"] == "literal" and right["kind"] == "literal":
        return left["value"] if left["value"] == right["value"] else None
    if left["kind"] == "literal":
        return left["value"] if _segment_matches_param(left["value"], right) else None
    if right["kind"] == "literal":
        return right["value"] if _segment_matches_param(right["value"], left) else None
    return _intersect_param_segments(left, right)


def _witness_for_pattern(
    segments: tuple[dict[str, str], ...],
    start_index: int,
    require_non_empty: bool,
) -> list[str]:
    if start_index >= len(segments):
        return ["x"] if require_non_empty else []

    segment = segments[start_index]
    if _is_greedy_segment(segment):
        return ["x"] if segment["greedy"] == "+" or require_non_empty else []

    return [
        _segment_witness(segment),
        *_witness_for_pattern(segments, start_index + 1, False),
    ]


def _empty_witness_for_pattern(
    segments: tuple[dict[str, str], ...],
    start_index: int,
) -> list[str] | None:
    if start_index >= len(segments):
        return []

    segment = segments[start_index]
    if _is_greedy_segment(segment) and segment["greedy"] == "*":
        return []

    return None


def _intersect_path_segments(
    left: tuple[dict[str, str], ...],
    right: tuple[dict[str, str], ...],
    left_index: int,
    right_index: int,
) -> list[str] | None:
    left_segment = left[left_index] if left_index < len(left) else None
    right_segment = right[right_index] if right_index < len(right) else None

    if left_segment is None and right_segment is None:
        return []
    if left_segment is None:
        return _empty_witness_for_pattern(right, right_index)
    if right_segment is None:
        return _empty_witness_for_pattern(left, left_index)

    left_greedy = _is_greedy_segment(left_segment)
    right_greedy = _is_greedy_segment(right_segment)
    if left_greedy and right_greedy:
        return ["x"] if left_segment["greedy"] == "+" or right_segment["greedy"] == "+" else []
    if left_greedy:
        return _witness_for_pattern(right, right_index, left_segment["greedy"] == "+")
    if right_greedy:
        return _witness_for_pattern(left, left_index, right_segment["greedy"] == "+")

    segment = _intersect_fixed_segments(left_segment, right_segment)
    if segment is None:
        return None

    tail = _intersect_path_segments(left, right, left_index + 1, right_index + 1)
    if tail is None:
        return None
    return [segment, *tail]


def _rules_overlap(left_rule: str, right_rule: str) -> bool:
    left = _parse_rule(left_rule)
    right = _parse_rule(right_rule)
    return _intersect_methods(left.method, right.method) is not None and (
        _intersect_path_segments(left.segments, right.segments, 0, 0) is not None
    )


def _permission_rule_references(api: dict) -> list[RuleReference]:
    return [
        RuleReference(permission["name"], rule)
        for permission in api.get("permissions", [])
        for rule in permission.get("rules", [])
    ]


def _find_rule_overlaps(
    left_rules: list[RuleReference],
    right_rules: list[RuleReference],
) -> list[str]:
    return [
        f"{left.permission_name}: {left.rule} <-> {right.permission_name}: {right.rule}"
        for left in left_rules
        for right in right_rules
        if _rules_overlap(left.rule, right.rule)
    ]


def test_firewall_rule_overlap_helper_detects_request_overlaps():
    assert _rules_overlap("GET /v4/items/{id}", "GET /v4/items/{id}")
    assert _rules_overlap(
        "ANY /v4/pages/assets/{rest*}",
        "POST /v4/pages/assets/upload",
    )
    assert _rules_overlap(
        "POST /v4/accounts/{account_id}/workers/assets/{action}",
        "POST /v4/accounts/{account_id}/workers/assets/upload",
    )
    assert _rules_overlap("GET /files/file-{id}", "GET /files/{slug}")
    assert _rules_overlap("GET /v4/{rest*}", "GET /v4")
    assert _rules_overlap("GET /v4/{rest+}", "GET /v4/pages")
    assert not _rules_overlap("GET /files/file-{id}", "GET /files/user-{id}")
    assert not _rules_overlap("GET /v4/{rest+}", "GET /v4")
    assert not _rules_overlap("GET /v4/items", "POST /v4/items")
    assert not _rules_overlap(
        "POST /v4/accounts/{account_id}/workers/dispatch/namespaces/"
        "{dispatch_namespace}/scripts/{script_name}/assets-upload-session",
        "POST /v4/accounts/{account_id}/workers/assets/upload",
    )


def test_get_existing_builtin_firewall():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS.get("github")

    assert isinstance(firewall, dict)
    assert firewall["name"] == "github"
    assert firewall["apis"][0]["base"] == "https://api.github.com"


def test_model_provider_builtin_firewalls_are_available():
    openai_firewall = builtin_firewalls.BUILTIN_FIREWALLS.get("model-provider:openai-api-key")
    codex_firewall = builtin_firewalls.BUILTIN_FIREWALLS.get("model-provider:codex-oauth-token")

    assert openai_firewall is not None
    assert openai_firewall["apis"][0]["base"] == "https://api.openai.com/v1/responses"
    assert codex_firewall is not None
    assert any(
        api["base"] == "https://chatgpt.com/backend-api/codex" for api in codex_firewall["apis"]
    )
    assert any(
        api["base"] == "https://auth.openai.com"
        and api.get("permissions") == [{"name": "denied", "rules": ["ANY /*"]}]
        for api in codex_firewall["apis"]
    )


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


def test_cloudflare_builtin_preserves_upload_authorization_endpoints():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["cloudflare"]
    connector_api, upload_api = firewall["apis"]

    assert connector_api["auth"] == {
        "headers": {"Authorization": "Bearer ${{ secrets.CLOUDFLARE_TOKEN }}"}
    }
    assert upload_api["auth"] == {}

    connector_rules = {
        rule for permission in connector_api["permissions"] for rule in permission.get("rules", [])
    }
    upload_rules = {
        rule for permission in upload_api["permissions"] for rule in permission.get("rules", [])
    }

    assert (
        "GET /v4/accounts/{account_id}/pages/projects/{project_name}/upload-token"
        in connector_rules
    )
    assert (
        "POST /v4/accounts/{account_id}/workers/dispatch/namespaces/"
        "{dispatch_namespace}/scripts/{script_name}/assets-upload-session" in connector_rules
    )
    assert upload_rules == {
        "POST /v4/pages/assets/check-missing",
        "POST /v4/pages/assets/upload",
        "POST /v4/pages/assets/upsert-hashes",
        "POST /v4/accounts/{account_id}/workers/assets/upload",
    }


def test_cloudflare_builtin_maps_cf_permissions_required_operations_to_connector_api():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["cloudflare"]
    connector_api, upload_api = firewall["apis"]

    connector_rules = {
        rule for permission in connector_api["permissions"] for rule in permission.get("rules", [])
    }
    upload_rules = {
        rule for permission in upload_api["permissions"] for rule in permission.get("rules", [])
    }

    assert "POST /v4/accounts/{account_id}/ai-search/instances/{id}/search" in connector_rules
    assert "POST /v4/accounts/{account_id}/email/sending/send" in connector_rules
    assert "DELETE /v4/accounts/{account_id}/browser-rendering/crawl/{job_id}" in connector_rules
    assert "POST /v4/accounts/{account_id}/ai-search/instances/{id}/search" not in upload_rules
    assert "POST /v4/accounts/{account_id}/email/sending/send" not in upload_rules


def test_cloudflare_builtin_auth_boundaries_have_no_route_overlaps():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["cloudflare"]
    connector_api, upload_api = firewall["apis"]

    assert (
        _find_rule_overlaps(
            _permission_rule_references(connector_api),
            _permission_rule_references(upload_api),
        )
        == []
    )


def test_read_like_builtin_permissions_do_not_own_mutation_methods():
    violations: list[str] = []

    for firewall_name, firewall in builtin_firewalls.BUILTIN_FIREWALLS.items():
        for api in firewall["apis"]:
            for permission in api.get("permissions", []):
                permission_name = permission["name"]
                if not _is_read_like_permission(permission_name):
                    continue
                for rule in permission.get("rules", []):
                    method = rule.split(" ", 1)[0]
                    if method in READ_LIKE_MUTATION_METHODS:
                        violations.append(f"{firewall_name}: {permission_name}: {rule}")

    assert violations == []


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


def test_gmail_builtin_allows_message_send_media_put_as_send():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["gmail"]
    compiled = matching.compile_firewalls([firewall])
    assert compiled is not None

    for url in (
        "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send",
        "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send",
    ):
        result = matching.match_compiled_firewall_request(
            url,
            "PUT",
            compiled,
            {
                "gmail": {
                    "allow": ["messages.send"],
                    "deny": ["messages.write"],
                    "unknownPolicy": "deny",
                }
            },
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "messages.send"
        assert result.rule == "PUT /v1/users/{userId}/messages/send"
        assert result.rel_path == "/v1/users/me/messages/send"


def test_google_drive_builtin_allows_file_update_media_put_as_write():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["google-drive"]
    compiled = matching.compile_firewalls([firewall])
    assert compiled is not None

    result = matching.match_compiled_firewall_request(
        "https://www.googleapis.com/resumable/upload/drive/v3/files/file-123",
        "PUT",
        compiled,
        {
            "google-drive": {
                "allow": ["files.write"],
                "deny": ["files.read"],
                "unknownPolicy": "deny",
            }
        },
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "files.write"
    assert result.rule == "PUT /v3/files/{fileId}"
    assert result.rel_path == "/v3/files/file-123"


def test_google_cloud_builtin_allows_storage_resumable_media_put_as_create():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["google-cloud"]
    compiled = matching.compile_firewalls([firewall])
    assert compiled is not None

    result = matching.match_compiled_firewall_request(
        "https://storage.googleapis.com/resumable/upload/storage/v1/b/bucket-1/o?upload_id=abc",
        "PUT",
        compiled,
        {
            "google-cloud": {
                "allow": ["storage.objects.create"],
                "deny": ["storage.objects.get"],
                "unknownPolicy": "deny",
            }
        },
    )

    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == "storage.objects.create"
    assert result.rule == "PUT /resumable/upload/storage/v1/b/{bucket}/o"
    assert result.rel_path == "/resumable/upload/storage/v1/b/bucket-1/o"


def test_youtube_builtin_allows_video_media_put_as_create():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["youtube"]
    compiled = matching.compile_firewalls([firewall])
    assert compiled is not None

    for url in (
        "https://youtube.googleapis.com/upload/youtube/v3/videos",
        "https://youtube.googleapis.com/resumable/upload/youtube/v3/videos",
    ):
        result = matching.match_compiled_firewall_request(
            url,
            "PUT",
            compiled,
            {
                "youtube": {
                    "allow": ["videos.create"],
                    "deny": ["videos.write"],
                    "unknownPolicy": "deny",
                }
            },
        )

        assert isinstance(result, matching.FirewallAllow)
        assert result.permission == "videos.create"
        assert result.rule == "PUT /v3/videos"
        assert result.rel_path == "/v3/videos"


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


def test_figma_builtin_firewall_uses_personal_access_token_header():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["figma"]

    assert firewall["apis"][0]["auth"]["headers"] == {"X-Figma-Token": "${{ secrets.FIGMA_TOKEN }}"}


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


def test_strava_firewall_uses_resource_permissions():
    firewall = builtin_firewalls.BUILTIN_FIREWALLS["strava"]
    permissions = {
        permission["name"] for api in firewall["apis"] for permission in api.get("permissions", [])
    }

    assert "activities:read" in permissions
    assert "activities:write" in permissions
    assert "athlete_stats:read" in permissions
    assert "clubs:read" in permissions
    assert "gear:read" in permissions
    assert "profile:read" in permissions
    assert "profile:write" in permissions
    assert "routes:read" in permissions
    assert "segment_effort_streams:read" in permissions
    assert "segment_efforts:read" in permissions
    assert "segments:read" in permissions
    assert "segments:write" in permissions
    assert "uploads:write" in permissions
    assert "activity:read" not in permissions
    assert "activity:read_all" not in permissions
    assert "activity:write" not in permissions
    assert "profile:read_all" not in permissions
    assert "read" not in permissions
    assert "read_all" not in permissions


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
    assert route_owners[("https://www.strava.com", "POST /api/v3/activities")] == (
        "activities:write"
    )
    assert route_owners[("https://www.strava.com", "GET /api/v3/athlete")] == ("profile:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/athlete/zones")] == ("profile:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/athlete/clubs")] == ("clubs:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/athletes/{id}/stats")] == (
        "athlete_stats:read"
    )
    assert route_owners[("https://www.strava.com", "GET /api/v3/gear/{id}")] == ("gear:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/routes/{id}")] == ("routes:read")
    assert route_owners[("https://www.strava.com", "GET /api/v3/segments/{id}")] == (
        "segments:read"
    )
    assert route_owners[("https://www.strava.com", "PUT /api/v3/segments/{id}/starred")] == (
        "segments:write"
    )
    assert route_owners[("https://www.strava.com", "GET /api/v3/segment_efforts/{id}/streams")] == (
        "segment_effort_streams:read"
    )
    assert route_owners[("https://www.strava.com", "GET /api/v3/segment_efforts/{id}")] == (
        "segment_efforts:read"
    )
    assert route_owners[("https://www.strava.com", "POST /api/v3/uploads")] == ("uploads:write")
