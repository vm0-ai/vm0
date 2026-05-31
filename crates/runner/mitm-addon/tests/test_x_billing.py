"""Cross-file static invariants for :mod:`usage.providers.connectors.x_billing`.

End-to-end classifier behaviour (defaults, overrides, body refinement)
is covered by ``tests/test_connector_usage.py``.  This module only holds the
consistency suites that can't be expressed at the integration level:
every firewall scope must be classified or intentionally unmapped,
every override must exist in the firewall generator output, every
emitted bucket must have a dev-seed row, etc.
"""

from __future__ import annotations

import functools
import json
import pathlib
import re
import subprocess
from typing import ClassVar, NamedTuple, NoReturn

import pytest

import matching
from usage.providers.connectors import _HANDLERS as CONNECTOR_USAGE_HANDLERS
from usage.providers.connectors.x_billing import (
    _INCLUDES_TO_BUCKET,
    _PATH_OVERRIDES,
    _PERMISSION_TO_BUCKET,
    _build_override_index,
    classify_bucket,
    refine_bucket_with_body,
)


class _FirewallPermission(NamedTuple):
    base: str
    name: str
    rules: tuple[str, ...]


class _FirewallApiEntry(NamedTuple):
    base: str
    permission_count: int


class _XFirewallExport(NamedTuple):
    name: str
    registered_name: str
    billable_connectors: tuple[str, ...]
    registered_api_entries: tuple[_FirewallApiEntry, ...]
    api_entries: tuple[_FirewallApiEntry, ...]
    registered_permissions: tuple[_FirewallPermission, ...]
    permissions: tuple[_FirewallPermission, ...]


class _XFirewallExportTimeout(NamedTuple):
    timeout_seconds: int


_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent.parent
_TURBO_DIR = _REPO_ROOT / "turbo"
_X_FIREWALL_PATH = _TURBO_DIR / "packages" / "connectors" / "src" / "firewalls" / "x.generated.ts"
_X_FIREWALL_EXPORT_TIMEOUT_SECONDS = 30
_X_FIREWALL_TSX_COMMAND = "node_modules/.bin/tsx"
_X_FIREWALL_TSX_DISPLAY = f"{_X_FIREWALL_TSX_COMMAND} -e <script>"
_X_FIREWALL_TSX_PATH = _TURBO_DIR / "node_modules" / ".bin" / "tsx"
_PATH_PARAM_RE = re.compile(r"^(?P<prefix>[^{}]*)\{(?P<name>[^{}]+)\}(?P<suffix>[^{}]*)$")
_SIMPLE_PATH_PARAM_SEGMENT_RE = re.compile(r"^\{[^{}+*]+\}$")
_X_FIREWALL_EXPORT_SCRIPT = """
import { collectAndValidatePermissions } from "./packages/connectors/src/firewall-expander.ts";
import {
  BILLABLE_CONNECTORS,
  getConnectorFirewall,
} from "./packages/connectors/src/firewalls/index.ts";
import { xFirewall } from "./packages/connectors/src/firewalls/x.generated.ts";

collectAndValidatePermissions(xFirewall);
const registeredXFirewall = getConnectorFirewall("x");
collectAndValidatePermissions(registeredXFirewall);

const flattenPermissions = (firewall) => firewall.apis.flatMap((api) =>
  (api.permissions ?? []).map((permission) => ({ ...permission, base: api.base }))
);
const flattenApiEntries = (firewall) => firewall.apis.map((api) => ({
  base: api.base,
  permissionCount: api.permissions?.length ?? 0,
}));

console.log(JSON.stringify({
  name: xFirewall.name,
  registeredName: registeredXFirewall.name,
  billableConnectors: BILLABLE_CONNECTORS,
  registeredApiEntries: flattenApiEntries(registeredXFirewall),
  apiEntries: flattenApiEntries(xFirewall),
  registeredPermissions: flattenPermissions(registeredXFirewall),
  permissions: flattenPermissions(xFirewall),
}));
""".strip()


def _fail_x_firewall_load(message: str, *, stdout: str = "", stderr: str = "") -> NoReturn:
    details = message
    if stdout:
        details += f"\n\nstdout:\n{stdout}"
    if stderr:
        details += f"\n\nstderr:\n{stderr}"
    pytest.fail(details)


def _parse_x_firewall_permissions(raw: object) -> tuple[_FirewallPermission, ...]:
    if not isinstance(raw, list):
        _fail_x_firewall_load(
            f"Expected xFirewall permissions JSON to be a list, got {type(raw).__name__}."
        )

    permissions: list[_FirewallPermission] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            _fail_x_firewall_load(
                "Expected each xFirewall permission entry to be an object, "
                f"but entry {index} is {type(entry).__name__}."
            )

        base = entry.get("base")
        if not isinstance(base, str):
            _fail_x_firewall_load(
                "Expected each xFirewall permission entry to have a string "
                f"`base`, but entry {index} has {type(base).__name__}."
            )

        name = entry.get("name")
        if not isinstance(name, str):
            _fail_x_firewall_load(
                "Expected each xFirewall permission entry to have a string "
                f"`name`, but entry {index} has {type(name).__name__}."
            )

        rules = entry.get("rules")
        if not isinstance(rules, list):
            _fail_x_firewall_load(
                "Expected xFirewall permission "
                f"{name!r} to have a `rules` list, got {type(rules).__name__}."
            )

        validated_rules: list[str] = []
        for rule_index, rule in enumerate(rules):
            if not isinstance(rule, str):
                _fail_x_firewall_load(
                    "Expected every xFirewall rule to be a string, but "
                    f"{name!r} rule {rule_index} is {type(rule).__name__}."
                )
            validated_rules.append(rule)

        permissions.append(_FirewallPermission(base=base, name=name, rules=tuple(validated_rules)))

    return tuple(permissions)


def _parse_x_firewall_api_entries(raw: object) -> tuple[_FirewallApiEntry, ...]:
    if not isinstance(raw, list):
        _fail_x_firewall_load(
            f"Expected xFirewall API entry JSON to be a list, got {type(raw).__name__}."
        )

    api_entries: list[_FirewallApiEntry] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            _fail_x_firewall_load(
                "Expected each xFirewall API entry to be an object, "
                f"but entry {index} is {type(entry).__name__}."
            )

        base = entry.get("base")
        if not isinstance(base, str):
            _fail_x_firewall_load(
                "Expected each xFirewall API entry to have a string "
                f"`base`, but entry {index} has {type(base).__name__}."
            )

        permission_count = entry.get("permissionCount")
        if not isinstance(permission_count, int):
            _fail_x_firewall_load(
                "Expected each xFirewall API entry to have an integer "
                f"`permissionCount`, but entry {index} has {type(permission_count).__name__}."
            )

        api_entries.append(_FirewallApiEntry(base=base, permission_count=permission_count))

    return tuple(api_entries)


def _parse_string_list(raw: object, name: str) -> tuple[str, ...]:
    if not isinstance(raw, list):
        _fail_x_firewall_load(f"Expected xFirewall export JSON `{name}` to be a list.")
    values: list[str] = []
    for index, value in enumerate(raw):
        if not isinstance(value, str):
            _fail_x_firewall_load(
                f"Expected xFirewall export JSON `{name}` entry {index} to be a string, "
                f"got {type(value).__name__}."
            )
        values.append(value)
    return tuple(values)


def _parse_x_firewall_export(raw: object) -> _XFirewallExport:
    if not isinstance(raw, dict):
        _fail_x_firewall_load(
            f"Expected xFirewall export JSON to be an object, got {type(raw).__name__}."
        )

    name = raw.get("name")
    if not isinstance(name, str):
        _fail_x_firewall_load(
            f"Expected xFirewall export JSON to have a string `name`, got {type(name).__name__}."
        )

    registered_name = raw.get("registeredName")
    if not isinstance(registered_name, str):
        _fail_x_firewall_load(
            "Expected xFirewall export JSON to have a string "
            f"`registeredName`, got {type(registered_name).__name__}."
        )

    billable_connectors = _parse_string_list(raw.get("billableConnectors"), "billableConnectors")
    registered_api_entries = _parse_x_firewall_api_entries(raw.get("registeredApiEntries"))
    api_entries = _parse_x_firewall_api_entries(raw.get("apiEntries"))
    registered_permissions = _parse_x_firewall_permissions(raw.get("registeredPermissions"))
    permissions = _parse_x_firewall_permissions(raw.get("permissions"))
    return _XFirewallExport(
        name=name,
        registered_name=registered_name,
        billable_connectors=billable_connectors,
        registered_api_entries=registered_api_entries,
        api_entries=api_entries,
        registered_permissions=registered_permissions,
        permissions=permissions,
    )


@functools.cache
def _run_x_firewall_export() -> subprocess.CompletedProcess[str] | _XFirewallExportTimeout:
    command = [_X_FIREWALL_TSX_COMMAND, "-e", _X_FIREWALL_EXPORT_SCRIPT]
    # Trusted workspace tooling with constant argv; no user-controlled shell input.
    try:
        return subprocess.run(  # noqa: S603
            command,
            cwd=_TURBO_DIR,
            text=True,
            capture_output=True,
            check=False,
            timeout=_X_FIREWALL_EXPORT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return _XFirewallExportTimeout(timeout_seconds=_X_FIREWALL_EXPORT_TIMEOUT_SECONDS)


@functools.cache
def _load_x_firewall_export() -> _XFirewallExport:
    if not _X_FIREWALL_PATH.exists():
        pytest.fail(
            f"x.generated.ts not found at {_X_FIREWALL_PATH}.\n"
            "This file is generated by the firewall generator's postinstall "
            "hook and is gitignored — run `cd turbo && pnpm install` to "
            "produce it before running these tests.  If the file still "
            "isn't created after install, the generator output path has "
            "likely moved; update this test's path computation."
        )

    if not _X_FIREWALL_TSX_PATH.exists():
        pytest.fail(
            f"tsx executable not found at {_X_FIREWALL_TSX_PATH}.\n"
            "Run `cd turbo && pnpm install` before running these tests."
        )

    completed = _run_x_firewall_export()
    if isinstance(completed, _XFirewallExportTimeout):
        _fail_x_firewall_load(
            "Timed out loading xFirewall from x.generated.ts with "
            f"`{_X_FIREWALL_TSX_DISPLAY}` after {completed.timeout_seconds}s."
        )

    if completed.returncode != 0:
        _fail_x_firewall_load(
            "Failed to load xFirewall from x.generated.ts with "
            f"`{_X_FIREWALL_TSX_DISPLAY}` "
            f"(exit code {completed.returncode}).",
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    try:
        raw: object = json.loads(completed.stdout)
    except json.JSONDecodeError:
        _fail_x_firewall_load(
            "Failed to parse xFirewall permissions JSON emitted by tsx.",
            stdout=completed.stdout,
            stderr=completed.stderr,
        )

    return _parse_x_firewall_export(raw)


def _load_x_firewall_permissions() -> tuple[_FirewallPermission, ...]:
    return _load_x_firewall_export().permissions


@functools.cache
def _compile_generated_x_firewall() -> matching.CompiledFirewallSet:
    export = _load_x_firewall_export()
    permissions_by_base: dict[str, list[dict[str, object]]] = {}
    for permission in export.permissions:
        permissions_by_base.setdefault(permission.base, []).append(
            {"name": permission.name, "rules": list(permission.rules)}
        )
    compiled = matching.compile_firewalls(
        [
            {
                "name": export.name,
                "apis": [
                    {
                        "base": entry.base,
                        "permissions": permissions_by_base.get(entry.base, []),
                    }
                    for entry in export.api_entries
                ],
            }
        ]
    )
    if compiled is None:
        pytest.fail("Generated X firewall failed to compile with the production matcher.")
    return compiled


def _sample_path_for_pattern(pattern: str) -> str:
    segments: list[str] = []
    for segment in pattern.split("/"):
        if not segment:
            continue
        match = _PATH_PARAM_RE.match(segment)
        if match is None:
            segments.append(segment)
            continue

        name = match.group("name")
        if name.endswith(("+", "*")):
            segments.append("sample")
        else:
            segments.append(f"{match.group('prefix')}sample{match.group('suffix')}")

    return "/" + "/".join(segments)


class TestFirewallConsistency:
    """Every permission group produced by the X firewall generator must
    either have a classifier mapping or appear in the intentionally
    unmapped set.  Without this check, an OpenAPI-driven firewall
    regeneration could introduce a new OAuth scope that silently skips
    billing (``classify_bucket`` returns ``None`` → request not
    recorded).
    """

    # Permission names that the classifier deliberately skips.  Requests
    # matching these scopes do not emit ``usage_event`` rows.
    _INTENTIONALLY_UNMAPPED: frozenset[str] = frozenset({"app-only"})

    def test_generated_firewall_name_matches_billing_handler(self):
        assert _load_x_firewall_export().name == "x", (
            "Connector usage dispatch is keyed by firewall_name.  If the "
            "generated X firewall is renamed, update the billing dispatcher "
            "handler key and billable connector config before trusting these "
            "scope/path drift checks."
        )

    def test_generated_firewall_name_is_billable_and_dispatchable(self):
        export = _load_x_firewall_export()
        assert export.registered_name == export.name, (
            "The connector firewall registry does not return the generated X "
            "firewall, so API run contexts may not attach X firewall rules."
        )
        assert export.name in CONNECTOR_USAGE_HANDLERS, (
            "The generated X firewall name is not registered in the mitm-addon "
            "connector usage dispatcher, so billable X flows would be dropped."
        )
        assert export.name in export.billable_connectors, (
            "The generated X firewall name is not listed in BILLABLE_CONNECTORS, "
            "so API run contexts would not mark X flows as billable."
        )

    def test_registered_firewall_shape_matches_generated_file(self):
        export = _load_x_firewall_export()
        assert export.registered_api_entries == export.api_entries, (
            "The X connector firewall registry does not expose the same API "
            "entry shape and order as x.generated.ts. Runtime firewall matching "
            "uses the registry and first-match semantics make order meaningful, "
            "so generated-file drift checks must not silently ignore registry-only "
            "or reordered API entries."
        )
        assert export.registered_permissions == export.permissions, (
            "The X connector firewall registry does not expose the same "
            "permission/rule set and order as x.generated.ts. Runtime firewall "
            "matching uses the registry and first-match semantics make order "
            "meaningful, so classifier drift checks must not silently validate "
            "a different or reordered generated object."
        )

    def _load_firewall_permissions(self) -> set[str]:
        return {permission.name for permission in _load_x_firewall_permissions()}

    def _load_firewall_rules(self) -> dict[str, set[tuple[str, str]]]:
        """Return ``{scope: {(method, pattern), ...}}`` from the generated
        firewall.  Used to verify that every classifier path override
        actually exists as a rule under its claimed scope."""
        result: dict[str, set[tuple[str, str]]] = {}
        for permission in _load_x_firewall_permissions():
            rules: set[tuple[str, str]] = set()
            for rule in permission.rules:
                parts = rule.split(" ", 1)
                if len(parts) != 2:
                    pytest.fail(
                        "Expected xFirewall rule to be shaped like "
                        f"`METHOD /path`, got {rule!r} for permission {permission.name!r}."
                    )
                method, pattern = parts
                if matching.compile_path_pattern(pattern) is None:
                    pytest.fail(
                        "Expected xFirewall rule path to compile with the "
                        f"production matcher, got {rule!r} for permission {permission.name!r}."
                    )
                rules.add((method, pattern))
            result.setdefault(permission.name, set()).update(rules)
        return result

    def test_generated_firewall_rules_are_uniquely_owned(self):
        owners: dict[tuple[str, str, str], list[str]] = {}
        for permission in _load_x_firewall_permissions():
            for rule in permission.rules:
                method, pattern = rule.split(" ", 1)
                owners.setdefault((permission.base, method, pattern), []).append(permission.name)

        duplicates = [
            (base, method, pattern, permission_names)
            for (base, method, pattern), permission_names in owners.items()
            if len(permission_names) > 1
        ]
        assert not duplicates, (
            "Generated xFirewall has duplicate base/method/path rules: "
            f"{duplicates}. Runtime firewall matching returns the first "
            "matching permission, so duplicate endpoint ownership can make "
            "X billing classify a different scope than these drift checks expect."
        )

    def test_generated_firewall_rules_do_not_use_any_method(self):
        wildcard_rules: list[tuple[str, str, str]] = []
        for permission in _load_x_firewall_permissions():
            for rule in permission.rules:
                method, pattern = rule.split(" ", 1)
                if method == "ANY":
                    wildcard_rules.append((permission.name, method, pattern))

        assert not wildcard_rules, (
            "Generated xFirewall has wildcard HTTP method rules: "
            f"{wildcard_rules}. Production firewall matching supports ANY, "
            "but X billing override classification is indexed by the concrete "
            "request method and would not apply ANY-specific overrides without "
            "additional classifier logic."
        )

    def test_generated_firewall_rules_use_simple_parameter_segments(self):
        complex_patterns: list[tuple[str, str, str, str]] = []
        for permission in _load_x_firewall_permissions():
            for rule in permission.rules:
                method, pattern = rule.split(" ", 1)
                for segment in pattern.split("/"):
                    if "{" not in segment and "}" not in segment:
                        continue
                    if _SIMPLE_PATH_PARAM_SEGMENT_RE.fullmatch(segment) is None:
                        complex_patterns.append((permission.name, method, pattern, segment))
                        break

        assert not complex_patterns, (
            "Generated xFirewall rules use mixed or greedy parameter segments: "
            f"{complex_patterns}. The X billing drift tests use representative "
            "sample paths to prove runtime first-match bucket preservation; "
            "upgrade those overlap checks before accepting generated paths "
            "beyond literal segments and whole-segment `{param}` placeholders."
        )

    def test_generated_firewall_api_entries_use_supported_base(self):
        export = _load_x_firewall_export()
        assert export.api_entries == (
            _FirewallApiEntry(
                base="https://api.x.com",
                permission_count=len(export.permissions),
            ),
        ), (
            "X billing classification and the runtime drift tests assume a single "
            "generated xFirewall API entry at https://api.x.com containing every "
            f"permission.  Generated entries are now {export.api_entries}; review "
            "whether billing classification needs to include API base or preserve "
            "multi-entry firewall ordering before trusting path-level drift checks."
        )

    def test_generated_firewall_api_entries_have_permissions(self):
        empty_entries = [
            entry.base
            for entry in _load_x_firewall_export().api_entries
            if entry.permission_count == 0
        ]
        assert not empty_entries, (
            "Generated xFirewall has API entries without permissions: "
            f"{empty_entries}. X billing is keyed by matched permission, so "
            "permissionless entries would be treated as unknown endpoints and "
            "skip usage_event emission."
        )

    def test_generated_firewall_payload_has_expected_stable_scopes(self):
        firewall_scopes = self._load_firewall_permissions()
        expected = {"tweet.read", "users.read"}
        missing = expected - firewall_scopes
        assert not missing, (
            "Loaded xFirewall permissions payload is missing stable known "
            f"scopes: {sorted(missing)}.  Check the generated firewall export "
            "and the JSON loader before trusting classifier drift assertions."
        )

    def test_generated_firewall_permissions_have_rules(self):
        empty: list[str] = []
        for permission in _load_x_firewall_permissions():
            if not permission.rules:
                empty.append(permission.name)

        assert not empty, (
            "Generated xFirewall permissions contain empty rule groups: "
            f"{empty}.  Empty groups can make classifier scope checks pass "
            "while no firewall paths actually exercise that scope."
        )

    def test_every_firewall_scope_is_mapped_or_intentionally_skipped(self):
        firewall_scopes = self._load_firewall_permissions()
        classified = set(_PERMISSION_TO_BUCKET.keys())
        accounted_for = classified | self._INTENTIONALLY_UNMAPPED
        missing = firewall_scopes - accounted_for
        assert not missing, (
            "The X firewall generator produces permission names that the "
            f"classifier does not handle: {sorted(missing)}.  Either add an "
            f"entry to `_PERMISSION_TO_BUCKET` in x_billing.py or (if the "
            "scope should stay unbilled) add it to "
            "`TestFirewallConsistency._INTENTIONALLY_UNMAPPED`."
        )

    def test_no_classifier_entry_is_stale(self):
        """Guard against typos: every key in `_PERMISSION_TO_BUCKET` must
        correspond to an actual scope the firewall generator emits."""
        firewall_scopes = self._load_firewall_permissions()
        stale = set(_PERMISSION_TO_BUCKET.keys()) - firewall_scopes
        assert not stale, (
            "The classifier has entries for scopes that no longer appear "
            f"in the firewall generator output: {sorted(stale)}.  Either "
            "these scopes were renamed/removed upstream, or the keys are "
            "typos."
        )

    def test_no_acknowledged_default_scope_is_stale(self):
        stale = set(self._ACKNOWLEDGED_DEFAULT_PATHS) - set(_PERMISSION_TO_BUCKET)
        assert not stale, (
            "The acknowledged-default path table has entries for scopes that "
            f"the classifier no longer maps: {sorted(stale)}.  Remove the "
            "stale default-path entries or restore the classifier mapping."
        )

    def test_overrides_never_reference_intentionally_unmapped(self):
        """`classify_bucket` consults ``_PATH_OVERRIDES`` before
        ``_PERMISSION_TO_BUCKET``, so an override under an
        intentionally-unmapped scope would silently enable billing for
        a scope we've decided not to bill (e.g. ``app-only``)."""
        override_scopes = {scope for scope, *_ in _PATH_OVERRIDES}
        clashing = override_scopes & self._INTENTIONALLY_UNMAPPED
        assert not clashing, (
            "These scopes are in _INTENTIONALLY_UNMAPPED but also appear "
            f"in _PATH_OVERRIDES: {sorted(clashing)}.  The override would "
            "override the unmapped decision and start emitting usage_event "
            "rows.  Either remove the override or drop the scope from "
            "_INTENTIONALLY_UNMAPPED and add it to _PERMISSION_TO_BUCKET."
        )

    def test_every_override_path_exists_in_firewall(self):
        """Each `_PATH_OVERRIDES` entry must point at a real rule in the
        firewall generator output, or at a literal generated path that
        runtime first-match semantics routes through a broader rule under
        the claimed permission.  Catches typos in the method or path pattern
        that would otherwise silently fail to match at runtime."""
        firewall = self._load_firewall_rules()
        all_generated_rules = {
            (generated_method, generated_pattern)
            for rules in firewall.values()
            for generated_method, generated_pattern in rules
        }
        generated_rule_buckets: dict[tuple[str, str], set[str | None]] = {}
        for permission in _load_x_firewall_permissions():
            for rule in permission.rules:
                generated_method, generated_pattern = rule.split(" ", 1)
                sample_path = _sample_path_for_pattern(generated_pattern)
                bucket = classify_bucket(permission.name, generated_method, sample_path)
                generated_rule_buckets.setdefault((generated_method, generated_pattern), set()).add(
                    bucket
                )
        compiled_firewall = _compile_generated_x_firewall()
        missing: list[tuple[str, str, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            rules = firewall.get(scope, set())
            if (method, pattern) in rules:
                continue
            if (method, pattern) not in all_generated_rules:
                missing.append((scope, method, pattern))
                continue
            sample_path = _sample_path_for_pattern(pattern)
            if bucket not in generated_rule_buckets.get((method, pattern), set()):
                missing.append((scope, method, pattern))
                continue
            runtime_match = matching.match_compiled_firewall_request(
                f"https://api.x.com{sample_path}",
                method,
                compiled_firewall,
            )
            if not isinstance(runtime_match, matching.FirewallAllow):
                missing.append((scope, method, pattern))
                continue
            if runtime_match.permission != scope:
                missing.append((scope, method, pattern))
        assert not missing, (
            "Classifier overrides reference (scope, method, path) tuples "
            f"that are not reachable through the firewall generator output: {missing}.  "
            "Either the firewall rule was renamed/removed upstream, the "
            "runtime first-match permission changed, or the override has a typo."
        )

    def test_runtime_firewall_rules_match_their_generated_permission(self):
        """Static drift checks read generated rule ownership, but runtime
        firewall matching decides authorization metadata, network policy, and
        billing attribution.  A broader generated rule must not capture a
        later, more specific generated rule under another permission.
        """
        compiled_firewall = _compile_generated_x_firewall()
        shadows: list[tuple[str, str, str, str, str]] = []
        for permission in _load_x_firewall_permissions():
            for rule in permission.rules:
                method, pattern = rule.split(" ", 1)
                sample_path = _sample_path_for_pattern(pattern)
                runtime_match = matching.match_compiled_firewall_request(
                    f"{permission.base}{sample_path}",
                    method,
                    compiled_firewall,
                )
                if not isinstance(runtime_match, matching.FirewallAllow):
                    continue

                runtime_permission = runtime_match.permission or ""
                if runtime_permission != permission.name:
                    shadows.append(
                        (permission.name, runtime_permission, method, pattern, sample_path)
                    )

        assert not shadows, (
            "Generated X firewall rules are shadowed by another runtime "
            f"permission: {shadows}.  Check path specificity handling before "
            "expanding X firewall output."
        )

    # Firewall paths that deliberately take their scope's default bucket.
    # Any firewall rule under a classified scope must either be in
    # `_PATH_OVERRIDES` or listed here, forcing an explicit decision for
    # every path instead of defaulting silently when a new endpoint is
    # added upstream.  Review each entry: if the scope default is wrong
    # for a path, move it into `_PATH_OVERRIDES` with the correct bucket.
    _ACKNOWLEDGED_DEFAULT_PATHS: ClassVar[dict[str, set[tuple[str, str]]]] = {
        "block.read": {("GET", "/2/users/{id}/blocking")},
        "bookmark.read": {
            ("GET", "/2/users/{id}/bookmarks"),
            ("GET", "/2/users/{id}/bookmarks/folders"),
            ("GET", "/2/users/{id}/bookmarks/folders/{folder_id}"),
        },
        "bookmark.write": {("POST", "/2/users/{id}/bookmarks")},
        "dm.read": {
            ("POST", "/2/activity/subscriptions"),
            ("GET", "/2/chat/conversations"),
            ("GET", "/2/chat/conversations/{id}"),
            ("GET", "/2/dm_conversations/media/{dm_id}/{media_id}/{resource_id}"),
            ("GET", "/2/dm_conversations/with/{participant_id}/dm_events"),
            ("GET", "/2/dm_conversations/{id}/dm_events"),
            ("GET", "/2/dm_events"),
            ("GET", "/2/dm_events/{event_id}"),
            ("GET", "/2/users/public_keys"),
            ("GET", "/2/users/{id}/public_keys"),
        },
        "dm.write": {
            ("GET", "/2/account_activity/webhooks/{webhook_id}/subscriptions/all"),
            ("POST", "/2/account_activity/webhooks/{webhook_id}/subscriptions/all"),
            ("POST", "/2/chat/conversations/group"),
            ("POST", "/2/chat/conversations/group/initialize"),
            ("POST", "/2/chat/conversations/{id}/keys"),
            ("POST", "/2/chat/conversations/{id}/members"),
            ("POST", "/2/chat/conversations/{id}/messages"),
            ("POST", "/2/chat/conversations/{id}/read"),
            ("POST", "/2/chat/conversations/{id}/typing"),
            ("POST", "/2/dm_conversations"),
            ("POST", "/2/dm_conversations/with/{participant_id}/messages"),
            ("POST", "/2/dm_conversations/{dm_conversation_id}/messages"),
            ("POST", "/2/users/{id}/dm/block"),
            ("POST", "/2/users/{id}/dm/unblock"),
            ("POST", "/2/users/{id}/public_keys"),
        },
        "follows.read": {
            ("GET", "/2/users/{id}/followers"),
            ("GET", "/2/users/{id}/following"),
        },
        "follows.write": {("POST", "/2/users/{id}/following")},
        "like.read": {
            ("GET", "/2/tweets/{id}/liking_users"),
            ("GET", "/2/users/{id}/liked_tweets"),
        },
        "like.write": {("POST", "/2/users/{id}/likes")},
        "list.read": {
            ("GET", "/2/communities/{id}"),
            ("GET", "/2/lists/{id}"),
            ("GET", "/2/lists/{id}/followers"),
            ("GET", "/2/lists/{id}/members"),
            ("GET", "/2/lists/{id}/tweets"),
            ("GET", "/2/users/{id}/followed_lists"),
            ("GET", "/2/users/{id}/list_memberships"),
            ("GET", "/2/users/{id}/owned_lists"),
            ("GET", "/2/users/{id}/pinned_lists"),
        },
        "list.write": {("POST", "/2/lists")},
        "media.write": {
            ("POST", "/2/media/upload"),
            ("POST", "/2/media/upload/initialize"),
            ("POST", "/2/media/upload/{id}/append"),
            ("POST", "/2/media/upload/{id}/finalize"),
        },
        "mute.read": {("GET", "/2/users/{id}/muting")},
        "mute.write": {("POST", "/2/users/{id}/muting")},
        "space.read": {
            ("GET", "/2/spaces"),
            ("GET", "/2/spaces/by/creator_ids"),
            ("GET", "/2/spaces/search"),
            ("GET", "/2/spaces/{id}"),
            ("GET", "/2/spaces/{id}/buyers"),
            ("GET", "/2/spaces/{id}/tweets"),
        },
        "timeline.read": {("GET", "/2/users/reposts_of_me")},
        "tweet.moderate.write": {("PUT", "/2/tweets/{tweet_id}/hidden")},
        "tweet.read": {
            ("GET", "/2/tweets"),
            ("GET", "/2/tweets/search/recent"),
            ("GET", "/2/tweets/{id}"),
            ("GET", "/2/tweets/{id}/quote_tweets"),
            ("GET", "/2/tweets/{id}/retweets"),
        },
        "tweet.write": {
            ("POST", "/2/notes"),
            ("POST", "/2/tweets"),
        },
        "users.read": {
            ("GET", "/2/news/search"),
            ("GET", "/2/news/{id}"),
            ("GET", "/2/users"),
            ("GET", "/2/users/by"),
            ("GET", "/2/users/by/username/{username}"),
            ("GET", "/2/users/me"),
            ("GET", "/2/users/personalized_trends"),
            ("GET", "/2/users/search"),
            ("GET", "/2/users/{id}"),
            ("GET", "/2/users/{id}/affiliates"),
        },
    }

    def test_every_firewall_path_has_an_explicit_decision(self):
        """Every firewall rule under a classified scope must either be
        in ``_PATH_OVERRIDES`` (explicitly routed to a non-default bucket)
        or in ``_ACKNOWLEDGED_DEFAULT_PATHS`` (explicitly confirmed to
        take the scope default).  This catches the case where X adds a
        new endpoint under an existing scope whose correct bucket is
        NOT the scope default — without this check, the new endpoint
        would silently bill at the wrong rate (e.g. 10-40× off) until
        someone noticed."""
        firewall = self._load_firewall_rules()
        override_paths: dict[str, set[tuple[str, str]]] = {}
        for scope, method, pattern, _bucket in _PATH_OVERRIDES:
            override_paths.setdefault(scope, set()).add((method, pattern))

        unreviewed: list[tuple[str, str, str]] = []
        obsolete: list[tuple[str, str, str]] = []
        for scope, rules in firewall.items():
            if scope in self._INTENTIONALLY_UNMAPPED:
                continue
            expected_defaults = self._ACKNOWLEDGED_DEFAULT_PATHS.get(scope, set())
            actual_defaults = rules - override_paths.get(scope, set())
            for method, pattern in sorted(actual_defaults - expected_defaults):
                unreviewed.append((scope, method, pattern))
            for method, pattern in sorted(expected_defaults - actual_defaults):
                obsolete.append((scope, method, pattern))

        drift_msg = (
            "Firewall path coverage drifted.\n\n"
            "Unreviewed (new firewall paths, confirm scope default or add override): "
            f"{unreviewed}\n\n"
            "Obsolete (in acknowledged list but no longer in firewall): "
            f"{obsolete}\n\n"
            "For each unreviewed path: inspect X's bucket pricing and EITHER add "
            "an override in `_PATH_OVERRIDES` (if the scope default is wrong) OR "
            "add the path to `_ACKNOWLEDGED_DEFAULT_PATHS` under the scope (if "
            "the default is correct).  Do not silently let new endpoints take "
            "the default — that is how billing drifts undetected."
        )
        assert not unreviewed, drift_msg
        assert not obsolete, drift_msg


class TestOverrideClassification:
    def test_path_overrides_use_simple_parameter_segments(self):
        """The representative-path overlap tests below are intentionally
        simple.  Keep manual X billing overrides to literal segments and
        whole-segment ``{param}`` placeholders unless the overlap checker
        is upgraded to reason about mixed prefix/suffix parameter forms.
        """
        complex_patterns: list[tuple[str, str, str, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            for segment in pattern.split("/"):
                if "{" not in segment and "}" not in segment:
                    continue
                if _SIMPLE_PATH_PARAM_SEGMENT_RE.fullmatch(segment) is None:
                    complex_patterns.append((scope, method, pattern, bucket))
                    break

        assert not complex_patterns, (
            "X billing path overrides use mixed or greedy parameter segments: "
            f"{complex_patterns}. The current representative-path shadowing "
            "tests only prove non-shadowing for literal segments and "
            "whole-segment `{param}` placeholders; upgrade the overlap check "
            "before adding more complex override patterns."
        )

    def test_every_path_override_classifies_sample_to_configured_bucket(self):
        mismatches: list[tuple[str, str, str, str, str, str | None]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            sample_path = _sample_path_for_pattern(pattern)
            actual = classify_bucket(scope, method, sample_path)
            if actual != bucket:
                mismatches.append((scope, method, pattern, sample_path, bucket, actual))

        assert not mismatches, (
            "X billing path overrides do not classify representative sample "
            f"paths to their configured buckets: {mismatches}."
        )

    def test_path_override_order_does_not_shadow_different_bucket_overrides(self):
        compiled_overrides: list[tuple[str, str, str, str, matching.CompiledPathPattern, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            compiled_pattern = matching.compile_path_pattern(pattern)
            if compiled_pattern is None:
                pytest.fail(f"invalid X billing override path pattern: {scope} {method} {pattern}")

            sample_path = _sample_path_for_pattern(pattern)
            if matching.match_compiled_path(sample_path, compiled_pattern) is None:
                pytest.fail(
                    "The X billing override shadowing check generated a non-matching "
                    f"sample path {sample_path!r} for pattern {pattern!r}."
                )
            compiled_overrides.append(
                (scope, method, pattern, bucket, compiled_pattern, sample_path)
            )

        shadowed: list[tuple[str, str, str, str, str, str, str]] = []
        for index, current in enumerate(compiled_overrides):
            scope, method, pattern, bucket, compiled_pattern, sample_path = current
            for other in compiled_overrides[index + 1 :]:
                (
                    other_scope,
                    other_method,
                    other_pattern,
                    other_bucket,
                    _other_compiled,
                    other_sample,
                ) = other
                if scope != other_scope or method != other_method or bucket == other_bucket:
                    continue
                if matching.match_compiled_path(other_sample, compiled_pattern) is not None:
                    shadowed.append(
                        (scope, method, pattern, bucket, other_pattern, other_bucket, other_sample)
                    )

        assert not shadowed, (
            "Earlier X billing path overrides shadow later overrides with "
            f"different buckets: {shadowed}. classify_bucket uses "
            "first-match-wins, so put the more specific override before the "
            "broader pattern or split the patterns so they do not overlap."
        )

    def test_no_duplicate_path_overrides(self):
        seen: dict[tuple[str, str, str], str] = {}
        duplicates: list[tuple[str, str, str, str, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            key = (scope, method, pattern)
            previous = seen.get(key)
            if previous is not None:
                duplicates.append((scope, method, pattern, previous, bucket))
            seen[key] = bucket

        assert not duplicates, (
            "Duplicate X billing path overrides would be hidden by "
            f"first-match-wins classification: {duplicates}."
        )

    def test_path_overrides_match_compiled_patterns(self):
        assert classify_bucket("tweet.read", "GET", "/2/tweets/123/retweeted_by") == "user.read"
        assert classify_bucket("tweet.read", "GET", "/2/tweets/123") == "posts.read"
        assert classify_bucket("like.write", "DELETE", "/2/users/1/likes/2") == "interaction.delete"

    def test_invalid_static_override_path_fails_fast(self):
        with pytest.raises(ValueError, match="invalid X billing override path pattern"):
            _build_override_index(
                [
                    ("tweet.read", "GET", "/2/tweets/{id}literal{other}", "user.read"),
                ]
            )


class TestSeedConsistency:
    """Every bucket the classifier can emit must have a pricing row in
    ``turbo/apps/api/src/scripts/dev-seed.ts``.  Without that, the billing
    processor would stamp ``billing_error = 'missing_pricing'`` and
    charge $0 for legitimate requests.
    """

    def _load_seed_category_entries(self) -> tuple[str, ...]:
        seed_path = (
            pathlib.Path(__file__).resolve().parent.parent.parent.parent.parent
            / "turbo"
            / "apps"
            / "api"
            / "src"
            / "scripts"
            / "dev-seed.ts"
        )
        if not seed_path.exists():
            pytest.fail(
                f"dev-seed.ts not found at {seed_path}.  The X connector "
                "pricing block has likely moved — update this test's path "
                "computation."
            )
        text = seed_path.read_text()
        # Scope the scan to the `usageGroup("connector", "x", [...])` call so
        # we don't scoop up categories for other connectors / kinds that share
        # the same `USAGE_PRICING` array.
        start_marker = 'usageGroup("connector", "x", ['
        try:
            start = text.index(start_marker)
            end = text.index("])", start)
        except ValueError:
            pytest.fail(
                f"Could not locate the `{start_marker}...])` block in "
                f"{seed_path}.  Either the helper was renamed, the connector "
                "key changed, or the call shape changed — update this test to "
                "match."
            )
        block = text[start:end]
        # Entries are tuples: `["<category>", usd(<price>), <quantity>]`. The
        # category is the first string in each tuple.
        return tuple(re.findall(r'\[\s*"([^"]+)"\s*,', block))

    def _load_seed_categories(self) -> set[str]:
        return set(self._load_seed_category_entries())

    def _emitted_buckets(self) -> set[str]:
        emitted = set(_PERMISSION_TO_BUCKET.values())
        emitted.update(bucket for _, _, _, bucket in _PATH_OVERRIDES)
        emitted.update(_INCLUDES_TO_BUCKET.values())
        # refine_bucket_with_body may downgrade the with-url bucket —
        # derive the target by invoking it on a no-URL body rather than
        # hardcoding the bucket name.
        downgraded = refine_bucket_with_body(
            "content.create_with_url",
            "POST",
            "/2/tweets",
            json.dumps({"text": "plain text without any link"}).encode(),
        )
        emitted.add(downgraded)
        # Unknown ``includes.<key>`` categories are synthetic per-request
        # strings; they intentionally have no seed row — the billing
        # processor applies a server-side fallback price.  Not included
        # in the check.
        return emitted

    def test_every_emitted_bucket_is_in_seed(self):
        seed = self._load_seed_categories()
        emitted = self._emitted_buckets()
        missing = emitted - seed
        assert not missing, f"classifier emits buckets not present in dev-seed: {sorted(missing)}"

    def test_seed_categories_are_unique(self):
        seen: set[str] = set()
        duplicates: list[str] = []
        for category in self._load_seed_category_entries():
            if category in seen:
                duplicates.append(category)
            seen.add(category)

        assert not duplicates, (
            "dev-seed.ts has duplicate X connector usage categories: "
            f"{duplicates}. usage_pricing is keyed by kind/provider/category, "
            "so duplicate seed rows make the intended price ambiguous."
        )

    def test_fallback_row_is_seeded(self):
        """Unknown ``includes.<key>`` categories rely on the
        ``__fallback__`` seed row for server-side pricing.  If that row
        is deleted the billing processor silently charges $0 for any
        unrecognised includes type."""
        seed = self._load_seed_categories()
        assert "__fallback__" in seed, (
            "dev-seed.ts lost the `__fallback__` row in the X connector "
            "usageGroup.  Unknown includes keys would bill at $0 — restore "
            "the row."
        )
