"""Firewall URL/host/path pattern matching functions.

Pure functions with no module-level state or I/O.

Firewall authority matching intentionally differs from trusted request
authority and auth.base rewrite validation: config parsing may preserve
malformed authority metadata so matched malformed configs can fail closed, and
parameterized hosts are meaningful only for firewall config bases.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal, NamedTuple
from typing import TypeAlias as _TypeAlias
from urllib.parse import urlsplit

from firewall_auth_config import auth_config_injects_ordinary_upstream_credentials
from firewall_matching import base_url as _firewall_base_url
from firewall_matching import patterns as _firewall_patterns
from firewall_matching.base_url import (
    _BaseUrlParts,
    _compile_firewall_config_base,
    _CompiledBase,
    _match_compiled_base_authority,
    _match_compiled_base_url_parts,
    _split_base_match_url,
    _split_https_authority_parts,
)
from firewall_matching.patterns import (
    SegmentError,
    SegmentLiteral,
    _compiled_path_segments_match,
    _match_compiled_path_segments,
    _split_path_segments,
)
from path_security import has_unsafe_path
from url_syntax import (
    has_raw_whitespace,
    has_unsafe_url_codepoint,
)

firewall_base_config_is_valid = _firewall_base_url.firewall_base_config_is_valid
static_firewall_base_config_key = _firewall_base_url.static_firewall_base_config_key
static_firewall_base_authority_key = _firewall_base_url.static_firewall_base_authority_key
match_url_authority_key = _firewall_base_url.match_url_authority_key
match_base_url = _firewall_base_url.match_base_url

CompiledPathPattern: _TypeAlias = _firewall_patterns.CompiledPathPattern
_compiled_rule_path_is_valid = _firewall_patterns._compiled_rule_path_is_valid
compile_path_pattern = _firewall_patterns.compile_path_pattern
match_compiled_path = _firewall_patterns.match_compiled_path
match_host = _firewall_patterns.match_host
match_path = _firewall_patterns.match_path
match_path_prefix = _firewall_patterns.match_path_prefix
parse_segment = _firewall_patterns.parse_segment

# Firewall rules are encoded as ``"METHOD path"`` — a single-whitespace-split
# yields exactly two tokens.  Rows that fail this shape are malformed.
_RULE_TOKEN_COUNT = 2
_VALID_RULE_METHODS = frozenset(
    (
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "ANY",
    )
)
_VALID_AUTH_BASE_SCHEME = "https"
_AUTH_TEMPLATE_START = "${{"
_AUTH_REFERENCE_PATTERN = re.compile(r"\$\{\{\s*(?:secrets|vars)\.[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}")
_AUTH_REFERENCE_PREFIX_PATTERN = re.compile(
    r"^\$\{\{\s*(?:secrets|vars)\.[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}"
)
_AUTH_TEMPLATE_URL_PLACEHOLDER = "placeholder"
_PathSpecificity = tuple[int, int, int, int, int, int, int]


class _CompiledRule(NamedTuple):
    method: str
    raw: str
    path: CompiledPathPattern
    specificity: _PathSpecificity


class _CompiledPermission(NamedTuple):
    name: str
    rules: tuple[_CompiledRule, ...]


class _CompiledRuleEntry(NamedTuple):
    order: int
    permission: str
    rule: _CompiledRule


class _CompiledRuleTrieNode(NamedTuple):
    entries: tuple[_CompiledRuleEntry, ...]
    children: Mapping[str, "_CompiledRuleTrieNode"]


@dataclass
class _RuleTrieBuilder:
    entries: list[_CompiledRuleEntry] = field(default_factory=list)
    children: dict[str, "_RuleTrieBuilder"] = field(default_factory=dict)


class _CompiledRuleMethodIndex(NamedTuple):
    fallback: tuple[_CompiledRuleEntry, ...]
    prefix_root: _CompiledRuleTrieNode


class _CompiledRuleIndex(NamedTuple):
    all_rules: tuple[_CompiledRuleEntry, ...]
    by_method: Mapping[str, _CompiledRuleMethodIndex]


class _CompiledApiCore(NamedTuple):
    raw_api_index: int
    base: _CompiledBase
    permissions: tuple[_CompiledPermission, ...]
    rule_index: _CompiledRuleIndex
    base_malformed: bool
    auth_malformed: bool
    # True when API compilation encountered malformed permissions/rules config.
    has_malformed_rules: bool


class _CompiledApi(NamedTuple):
    raw_api_entry: dict
    core: _CompiledApiCore

    @property
    def base(self) -> _CompiledBase:
        return self.core.base

    @property
    def permissions(self) -> tuple[_CompiledPermission, ...]:
        return self.core.permissions

    @property
    def rule_index(self) -> _CompiledRuleIndex:
        return self.core.rule_index

    @property
    def base_malformed(self) -> bool:
        return self.core.base_malformed

    @property
    def auth_malformed(self) -> bool:
        return self.core.auth_malformed

    @property
    def has_malformed_rules(self) -> bool:
        return self.core.has_malformed_rules


class CompiledFirewallCore(NamedTuple):
    name: str
    api_cores: tuple[_CompiledApiCore, ...]
    name_malformed: bool


class _CompiledFirewall(NamedTuple):
    core: CompiledFirewallCore
    apis: tuple[_CompiledApi, ...]

    @property
    def name(self) -> str:
        return self.core.name

    @property
    def name_malformed(self) -> bool:
        return self.core.name_malformed


class _CompiledApiCandidate(NamedTuple):
    order: int
    firewall: _CompiledFirewall
    api: _CompiledApi


class _CompiledApiTrieNode(NamedTuple):
    candidates: tuple[_CompiledApiCandidate, ...]
    children: Mapping[str, "_CompiledApiTrieNode"]


@dataclass
class _ApiTrieBuilder:
    candidates: list[_CompiledApiCandidate] = field(default_factory=list)
    children: dict[str, "_ApiTrieBuilder"] = field(default_factory=dict)


class _CompiledApiIndex(NamedTuple):
    all_candidates: tuple[_CompiledApiCandidate, ...]
    fallback: tuple[_CompiledApiCandidate, ...]
    static_roots: Mapping[tuple[str, str], _CompiledApiTrieNode]


@dataclass(frozen=True, init=False, slots=True, eq=False, repr=False)
class CompiledFirewallSet:
    firewalls: tuple[_CompiledFirewall, ...]
    _api_index: _CompiledApiIndex = field(compare=False, repr=False)

    def __init__(self, firewalls: tuple[_CompiledFirewall, ...]) -> None:
        object.__setattr__(self, "firewalls", firewalls)
        object.__setattr__(self, "_api_index", _compile_api_candidate_index(firewalls))

    def __bool__(self) -> bool:
        return bool(self.firewalls)

    def indexed_api_candidates(self, url_parts: _BaseUrlParts) -> tuple[_CompiledApiCandidate, ...]:
        return _indexed_api_candidates(self._api_index, url_parts)

    def linear_api_candidates(self) -> tuple[_CompiledApiCandidate, ...]:
        return self._api_index.all_candidates

    def matches_ordinary_credential_authority(self, host: str, port: int) -> bool:
        url_parts = _split_https_authority_parts(host, port)
        if url_parts is None:
            return False
        return any(
            _api_matches_ordinary_credential_authority(candidate.api, url_parts)
            for candidate in self._api_index.all_candidates
            if not candidate.firewall.name_malformed
        )


UnknownPolicy = Literal["allow", "deny", "ask"]


class _CompiledNetworkPolicy(NamedTuple):
    blocked_permissions: frozenset[str]
    unknown_policy: UnknownPolicy
    permission_malformed: bool
    unknown_policy_malformed: bool


class CompiledNetworkPolicies(NamedTuple):
    policies: Mapping[str, _CompiledNetworkPolicy]
    top_level_malformed: bool


class _CompiledRuleCandidate(NamedTuple):
    permission: str
    rule: str
    specificity: _PathSpecificity
    params: dict[str, str]


def _is_string_record(value: object) -> bool:
    return isinstance(value, dict) and all(
        isinstance(key, str) and isinstance(record_value, str)
        for key, record_value in value.items()
    )


class _AuthBaseStaticValidationTarget(NamedTuple):
    url: str | None
    dynamic_prefix_suffix: str


def _auth_base_for_static_url_validation(auth_base: str) -> _AuthBaseStaticValidationTarget:
    if _AUTH_TEMPLATE_START not in auth_base:
        return _AuthBaseStaticValidationTarget(auth_base, "")

    replaced = _AUTH_REFERENCE_PATTERN.sub(_AUTH_TEMPLATE_URL_PLACEHOLDER, auth_base)
    if _AUTH_TEMPLATE_START in replaced:
        return _AuthBaseStaticValidationTarget(auth_base, "")
    prefix_match = _AUTH_REFERENCE_PREFIX_PATTERN.match(auth_base)
    if prefix_match is not None:
        suffix = _AUTH_REFERENCE_PATTERN.sub(
            _AUTH_TEMPLATE_URL_PLACEHOLDER,
            auth_base[prefix_match.end() :],
        )
        return _AuthBaseStaticValidationTarget(None, suffix)
    return _AuthBaseStaticValidationTarget(replaced, "")


def _dynamic_auth_base_suffix_is_valid(suffix: str) -> bool:
    if (
        _AUTH_TEMPLATE_START in suffix
        or has_unsafe_url_codepoint(suffix)
        or has_raw_whitespace(suffix)
        or "#" in suffix
        or (suffix != "" and not suffix.startswith(("/", "?")))
    ):
        return False
    if not suffix.startswith("/"):
        return True
    suffix_path = suffix.partition("?")[0]
    return not has_unsafe_path(suffix_path)


def _static_auth_base_is_valid(auth_base: str) -> bool:
    if "\\" in auth_base:
        return False
    target = _auth_base_for_static_url_validation(auth_base)
    if not _dynamic_auth_base_suffix_is_valid(target.dynamic_prefix_suffix):
        return False
    validation_url = target.url
    if validation_url is None:
        return True
    if _AUTH_TEMPLATE_START in validation_url:
        return False
    if has_raw_whitespace(validation_url):
        return False
    if "://" not in validation_url:
        return False

    try:
        parts = urlsplit(validation_url)
    except ValueError:
        return False
    if parts.scheme.lower() != _VALID_AUTH_BASE_SCHEME:
        return False
    if parts.fragment:
        return False
    if has_unsafe_path(parts.path):
        return False
    return (
        _split_base_match_url(
            validation_url,
            allow_query_fragment=True,
            allow_malformed_authority=False,
        )
        is not None
    )


def _auth_config_is_valid(api_entry: dict) -> bool:
    if "auth" not in api_entry:
        return False

    raw_auth = api_entry["auth"]
    if not isinstance(raw_auth, dict):
        return False

    if "headers" in raw_auth and not _is_string_record(raw_auth["headers"]):
        return False
    if "query" in raw_auth and not _is_string_record(raw_auth["query"]):
        return False
    if "awsSigv4" in raw_auth:
        raw_aws_sigv4 = raw_auth["awsSigv4"]
        if not isinstance(raw_aws_sigv4, dict):
            return False
        if set(raw_aws_sigv4) - {"accessKeyId", "secretAccessKey", "sessionToken"}:
            return False
        if not isinstance(raw_aws_sigv4.get("accessKeyId"), str):
            return False
        if not raw_aws_sigv4["accessKeyId"]:
            return False
        if not isinstance(raw_aws_sigv4.get("secretAccessKey"), str):
            return False
        if not raw_aws_sigv4["secretAccessKey"]:
            return False
        optional_value = raw_aws_sigv4.get("sessionToken")
        if optional_value is not None and not isinstance(optional_value, str):
            return False
        if optional_value == "":
            return False
        if raw_auth.get("headers"):
            return False
        if raw_auth.get("query"):
            return False
    if "base" in raw_auth and not isinstance(raw_auth["base"], str):
        return False
    return "base" not in raw_auth or _static_auth_base_is_valid(raw_auth["base"])


def _path_specificity(
    pattern: CompiledPathPattern,
) -> _PathSpecificity:
    literal_segments = 0
    mixed_param_segments = 0
    plain_param_segments = 0
    plus_greedy_segments = 0
    star_greedy_segments = 0
    literal_chars = 0

    for segment in pattern.segments:
        if isinstance(segment, SegmentLiteral):
            literal_segments += 1
            literal_chars += len(segment.value)
            continue
        if isinstance(segment, SegmentError):
            continue

        literal_chars += len(segment.prefix) + len(segment.suffix)
        if segment.prefix or segment.suffix:
            mixed_param_segments += 1
        elif segment.greedy == "+":
            plus_greedy_segments += 1
        elif segment.greedy == "*":
            star_greedy_segments += 1
        else:
            plain_param_segments += 1

    return (
        literal_segments,
        mixed_param_segments,
        plain_param_segments,
        plus_greedy_segments,
        -star_greedy_segments,
        literal_chars,
        len(pattern.segments),
    )


def _api_matches_ordinary_credential_authority(
    api_entry: _CompiledApi,
    url_parts: _BaseUrlParts,
) -> bool:
    if (
        api_entry.base_malformed
        or api_entry.auth_malformed
        or api_entry.base.parts.scheme.lower() != "https"
    ):
        return False
    if not auth_config_injects_ordinary_upstream_credentials(api_entry.raw_api_entry.get("auth")):
        return False
    return _match_compiled_base_authority(url_parts, api_entry.base)


def _path_index_key(path: str) -> tuple[str, ...]:
    return tuple(_split_path_segments(path))


def _static_api_index_key(
    base: _CompiledBase,
) -> tuple[str, str, tuple[str, ...]] | None:
    if (
        base.has_params
        or base.raw_syntax_malformed
        or base.param_parse_malformed
        or base.parts.host_malformed
        or base.parts.has_userinfo
        or base.parts.port_malformed
    ):
        return None
    return (
        base.parts.scheme.lower(),
        base.parts.authority.lower(),
        _path_index_key(base.parts.path),
    )


def _insert_api_trie_candidate(
    root: _ApiTrieBuilder,
    path_key: tuple[str, ...],
    candidate: _CompiledApiCandidate,
) -> None:
    node = root
    for segment in path_key:
        node = node.children.setdefault(segment, _ApiTrieBuilder())
    node.candidates.append(candidate)


def _freeze_api_trie_node(builder: _ApiTrieBuilder) -> _CompiledApiTrieNode:
    frozen_nodes: dict[int, _CompiledApiTrieNode] = {}
    stack: list[tuple[_ApiTrieBuilder, bool]] = [(builder, False)]
    while stack:
        node, visited = stack.pop()
        if visited:
            frozen_nodes[id(node)] = _CompiledApiTrieNode(
                tuple(node.candidates),
                MappingProxyType(
                    {segment: frozen_nodes[id(child)] for segment, child in node.children.items()}
                ),
            )
            continue
        stack.append((node, True))
        stack.extend((child, False) for child in node.children.values())
    return frozen_nodes[id(builder)]


def _extend_api_trie_candidates(
    candidates: list[_CompiledApiCandidate],
    root: _CompiledApiTrieNode,
    path_segs: list[str],
) -> None:
    candidates.extend(root.candidates)
    node = root
    for segment in path_segs:
        child = node.children.get(segment)
        if child is None:
            break
        node = child
        candidates.extend(node.candidates)


def _compile_api_candidate_index(
    firewalls: tuple[_CompiledFirewall, ...],
) -> _CompiledApiIndex:
    all_candidates: list[_CompiledApiCandidate] = []
    fallback: list[_CompiledApiCandidate] = []
    static_roots: dict[tuple[str, str], _ApiTrieBuilder] = {}

    order = 0
    for firewall in firewalls:
        for api in firewall.apis:
            candidate = _CompiledApiCandidate(order, firewall, api)
            all_candidates.append(candidate)
            key = _static_api_index_key(api.base)
            if key is None:
                fallback.append(candidate)
            else:
                scheme, authority, path_key = key
                root = static_roots.setdefault((scheme, authority), _ApiTrieBuilder())
                _insert_api_trie_candidate(root, path_key, candidate)
            order += 1

    return _CompiledApiIndex(
        tuple(all_candidates),
        tuple(fallback),
        MappingProxyType({key: _freeze_api_trie_node(root) for key, root in static_roots.items()}),
    )


def _indexed_api_candidates(
    api_index: _CompiledApiIndex,
    url_parts: _BaseUrlParts,
) -> tuple[_CompiledApiCandidate, ...]:
    candidates = list(api_index.fallback)
    root = api_index.static_roots.get((url_parts.scheme.lower(), url_parts.authority.lower()))
    if root is not None:
        _extend_api_trie_candidates(candidates, root, _split_path_segments(url_parts.path))
    if len(candidates) <= 1:
        return tuple(candidates)
    return tuple(sorted(candidates, key=lambda candidate: candidate.order))


def _rule_path_index_key(rule: _CompiledRule) -> tuple[str, ...] | None:
    prefix: list[str] = []
    for segment in rule.path.segments:
        if not isinstance(segment, SegmentLiteral):
            break
        prefix.append(segment.value)
    return tuple(prefix) if prefix else None


def _insert_rule_trie_entry(
    root: _RuleTrieBuilder,
    path_key: tuple[str, ...],
    entry: _CompiledRuleEntry,
) -> None:
    node = root
    for segment in path_key:
        node = node.children.setdefault(segment, _RuleTrieBuilder())
    node.entries.append(entry)


def _freeze_rule_trie_node(builder: _RuleTrieBuilder) -> _CompiledRuleTrieNode:
    frozen_nodes: dict[int, _CompiledRuleTrieNode] = {}
    stack: list[tuple[_RuleTrieBuilder, bool]] = [(builder, False)]
    while stack:
        node, visited = stack.pop()
        if visited:
            frozen_nodes[id(node)] = _CompiledRuleTrieNode(
                tuple(node.entries),
                MappingProxyType(
                    {segment: frozen_nodes[id(child)] for segment, child in node.children.items()}
                ),
            )
            continue
        stack.append((node, True))
        stack.extend((child, False) for child in node.children.values())
    return frozen_nodes[id(builder)]


def _add_rule_entries(
    candidates: list[_CompiledRuleEntry],
    seen_orders: set[int],
    entries: tuple[_CompiledRuleEntry, ...],
) -> None:
    for entry in entries:
        if entry.order not in seen_orders:
            seen_orders.add(entry.order)
            candidates.append(entry)


def _extend_rule_trie_candidates(
    candidates: list[_CompiledRuleEntry],
    seen_orders: set[int],
    root: _CompiledRuleTrieNode,
    rel_path_segs: list[str],
) -> None:
    _add_rule_entries(candidates, seen_orders, root.entries)
    node = root
    for segment in rel_path_segs:
        child = node.children.get(segment)
        if child is None:
            break
        node = child
        _add_rule_entries(candidates, seen_orders, node.entries)


def _compile_rule_method_index(
    entries: list[_CompiledRuleEntry],
) -> _CompiledRuleMethodIndex:
    fallback: list[_CompiledRuleEntry] = []
    prefix_root = _RuleTrieBuilder()
    for entry in entries:
        key = _rule_path_index_key(entry.rule)
        if key is None:
            fallback.append(entry)
        else:
            _insert_rule_trie_entry(prefix_root, key, entry)
    return _CompiledRuleMethodIndex(
        tuple(fallback),
        _freeze_rule_trie_node(prefix_root),
    )


def _compile_rule_index(
    permissions: tuple[_CompiledPermission, ...],
) -> _CompiledRuleIndex:
    all_rules: list[_CompiledRuleEntry] = []
    by_method_entries: dict[str, list[_CompiledRuleEntry]] = {}

    order = 0
    for permission in permissions:
        for rule in permission.rules:
            entry = _CompiledRuleEntry(order, permission.name, rule)
            all_rules.append(entry)
            by_method_entries.setdefault(rule.method, []).append(entry)
            order += 1

    return _CompiledRuleIndex(
        tuple(all_rules),
        MappingProxyType(
            {
                method: _compile_rule_method_index(entries)
                for method, entries in by_method_entries.items()
            }
        ),
    )


def _indexed_rule_candidates(
    api_entry: _CompiledApi,
    upper_method: str,
    rel_path_segs: list[str],
) -> tuple[_CompiledRuleEntry, ...]:
    candidates: list[_CompiledRuleEntry] = []
    seen_orders: set[int] = set()

    def add_method_candidates(method: str) -> None:
        method_index = api_entry.rule_index.by_method.get(method)
        if method_index is None:
            return
        _add_rule_entries(candidates, seen_orders, method_index.fallback)
        _extend_rule_trie_candidates(
            candidates,
            seen_orders,
            method_index.prefix_root,
            rel_path_segs,
        )

    add_method_candidates("ANY")
    if upper_method != "ANY":
        add_method_candidates(upper_method)

    if len(candidates) <= 1:
        return tuple(candidates)
    return tuple(sorted(candidates, key=lambda entry: entry.order))


def _compile_rule(rule_str: str) -> _CompiledRule | None:
    parts = rule_str.split(" ", 1)
    if len(parts) != _RULE_TOKEN_COUNT:
        return None
    method, path = parts
    if method not in _VALID_RULE_METHODS:
        return None
    if (
        not path.startswith("/")
        or "?" in path
        or "#" in path
        or "\\" in path
        or has_unsafe_url_codepoint(path)
        or has_raw_whitespace(path)
    ):
        return None
    pattern = compile_path_pattern(path)
    if pattern is None:
        return None
    if not _compiled_rule_path_is_valid(pattern):
        return None
    return _CompiledRule(method, rule_str, pattern, _path_specificity(pattern))


# Compiled matcher contract
#
# Registry loading stores these compiled objects and request handling later
# converts FirewallBlock into a 403, so the compile phase deliberately
# distinguishes inputs that cannot match from malformed inputs that can still
# match a base and must fail closed at match time.
#
# Registry loading rejects explicit non-null, non-list firewalls payloads for
# registered VMs before request handling. Direct compile_firewalls callers still
# get None for missing, empty, or non-list payloads. compile_firewalls skips raw
# entries that cannot participate in base matching: non-object firewall entries,
# firewalls whose "apis" is not a list, non-object APIs, non-string bases, bases
# that cannot compile into matcher data, and firewalls with no compiled APIs.
# Once an API base compiles, the API is retained and records malformed state for:
# firewall name, base syntax/authority/params, auth config, and permission/rule
# config.
#
# compile_network_policies preserves malformed policy state for a present
# non-object top-level networkPolicies payload, non-object per-firewall grants,
# malformed allow/deny/ask permission sets, and malformed unknownPolicy. It
# skips non-string policy keys because they cannot address a firewall name.
#
# match_compiled_firewall_request applies retained malformed state only after a
# request matches a compiled base. The relevant fail-closed reasons are
# "malformed_firewall_config", "malformed_network_policy", and "unsafe_path".
# Malformed config for an unrelated base does not block unrelated traffic.
#
# Preserve current decision precedence when changing this code or these docs:
# unsafe paths block immediately after base match. APIs with malformed firewall
# name, base, or auth config record malformed firewall config and then skip rule
# evaluation for that API. Malformed permission/rule config records malformed
# firewall config but still lets valid compiled rules on that API participate.
# Malformed top-level policies or malformed allow/deny/ask permission sets record
# malformed network policy and skip rule evaluation for the matched API.
# Recorded allow/deny rule decisions resolve before retained malformed state; if
# no allow/deny resolved, malformed network policy resolves before malformed
# firewall config; malformed unknownPolicy only affects unknown-endpoint
# resolution.
def compile_firewall_core(fw_entry: object) -> CompiledFirewallCore | None:
    """Compile one firewall into VM-independent matcher data."""
    if not isinstance(fw_entry, dict):
        return None

    raw_name = fw_entry.get("name")
    name_malformed = not isinstance(raw_name, str) or raw_name == ""
    firewall_name = raw_name if isinstance(raw_name, str) else ""

    raw_apis = fw_entry.get("apis", [])
    if not isinstance(raw_apis, list):
        return None

    api_cores: list[_CompiledApiCore] = []
    for api_index, api_entry in enumerate(raw_apis):
        if not isinstance(api_entry, dict):
            continue
        raw_base = api_entry.get("base", "")
        if not isinstance(raw_base, str):
            continue
        compiled_config_base = _compile_firewall_config_base(raw_base)
        if compiled_config_base is None:
            continue
        base = compiled_config_base.base
        base_malformed = compiled_config_base.malformed
        auth_malformed = not _auth_config_is_valid(api_entry)

        compiled_permissions: list[_CompiledPermission] = []
        has_malformed_rules = name_malformed
        seen_permission_names: set[str] = set()
        permissions = api_entry.get("permissions")
        permissions_present = "permissions" in api_entry
        if isinstance(permissions, list):
            for perm in permissions:
                if not isinstance(perm, dict):
                    has_malformed_rules = True
                    continue
                raw_name = perm.get("name")
                if not isinstance(raw_name, str):
                    has_malformed_rules = True
                    continue
                if raw_name in ("", "all"):
                    has_malformed_rules = True
                    continue
                if raw_name in seen_permission_names:
                    has_malformed_rules = True
                    continue
                seen_permission_names.add(raw_name)
                raw_rules = perm.get("rules", [])
                if not isinstance(raw_rules, list):
                    raw_rules = []
                    has_malformed_rules = True
                if len(raw_rules) == 0:
                    has_malformed_rules = True

                compiled_rules: list[_CompiledRule] = []
                for rule_str in raw_rules:
                    if not isinstance(rule_str, str):
                        has_malformed_rules = True
                        continue
                    rule = _compile_rule(rule_str)
                    if rule is None:
                        has_malformed_rules = True
                        continue
                    compiled_rules.append(rule)

                compiled_permissions.append(_CompiledPermission(raw_name, tuple(compiled_rules)))
        elif permissions_present:
            has_malformed_rules = True

        compiled_permissions_tuple = tuple(compiled_permissions)
        api_cores.append(
            _CompiledApiCore(
                api_index,
                base,
                compiled_permissions_tuple,
                _compile_rule_index(compiled_permissions_tuple),
                base_malformed,
                auth_malformed,
                has_malformed_rules,
            )
        )

    if not api_cores:
        return None
    return CompiledFirewallCore(firewall_name, tuple(api_cores), name_malformed)


def bind_compiled_firewall_core(
    fw_entry: dict,
    core: CompiledFirewallCore,
) -> _CompiledFirewall | None:
    """Bind VM-specific raw API entries to reusable compiled firewall core data."""
    raw_apis = fw_entry.get("apis", [])
    if not isinstance(raw_apis, list):
        return None

    compiled_apis: list[_CompiledApi] = []
    for api_core in core.api_cores:
        if api_core.raw_api_index >= len(raw_apis):
            return None
        api_entry = raw_apis[api_core.raw_api_index]
        if not isinstance(api_entry, dict):
            return None
        compiled_apis.append(_CompiledApi(api_entry, api_core))

    if not compiled_apis:
        return None
    return _CompiledFirewall(core, tuple(compiled_apis))


def compile_firewalls(vm_firewalls: object | None) -> CompiledFirewallSet | None:
    """Compile firewall data and retain selected malformed state.

    See the compiled matcher contract above for skipped versus retained inputs.
    """
    if not isinstance(vm_firewalls, list) or not vm_firewalls:
        return None

    compiled_firewalls: list[_CompiledFirewall] = []
    for fw_entry in vm_firewalls:
        core = compile_firewall_core(fw_entry)
        if core is None or not isinstance(fw_entry, dict):
            continue
        compiled_firewall = bind_compiled_firewall_core(fw_entry, core)
        if compiled_firewall is not None:
            compiled_firewalls.append(compiled_firewall)

    if not compiled_firewalls:
        return None
    return CompiledFirewallSet(tuple(compiled_firewalls))


def _compile_permission_set(raw_value: object | None) -> tuple[frozenset[str], bool]:
    if raw_value is None:
        return frozenset(), False
    if not isinstance(raw_value, list):
        return frozenset(), True
    if not all(isinstance(item, str) for item in raw_value):
        return frozenset(), True
    return frozenset(raw_value), False


def compile_network_policies(raw_network_policies: object | None) -> CompiledNetworkPolicies:
    """Compile networkPolicies and retain selected malformed policy state.

    See the compiled matcher contract above for match-time fail-closed semantics.
    """
    if raw_network_policies is None:
        return CompiledNetworkPolicies(MappingProxyType({}), False)
    if not isinstance(raw_network_policies, dict):
        return CompiledNetworkPolicies(MappingProxyType({}), True)

    compiled: dict[str, _CompiledNetworkPolicy] = {}
    for fw_name, grant in raw_network_policies.items():
        if not isinstance(fw_name, str):
            continue

        if not isinstance(grant, dict):
            compiled[fw_name] = _CompiledNetworkPolicy(
                frozenset(),
                "allow",
                True,
                False,
            )
            continue

        _allow, allow_malformed = _compile_permission_set(grant.get("allow"))
        deny, deny_malformed = _compile_permission_set(grant.get("deny"))
        ask, ask_malformed = _compile_permission_set(grant.get("ask"))

        raw_unknown_policy = grant.get("unknownPolicy")
        unknown_policy: UnknownPolicy = "allow"
        unknown_policy_malformed = False
        if raw_unknown_policy is None:
            unknown_policy = "allow"
        elif raw_unknown_policy in ("allow", "deny", "ask"):
            unknown_policy = raw_unknown_policy
        else:
            unknown_policy_malformed = True

        compiled[fw_name] = _CompiledNetworkPolicy(
            deny | ask,
            unknown_policy,
            allow_malformed or deny_malformed or ask_malformed,
            unknown_policy_malformed,
        )

    return CompiledNetworkPolicies(MappingProxyType(compiled), False)


def _ensure_compiled_network_policies(
    network_policies: object | None,
) -> CompiledNetworkPolicies:
    if isinstance(network_policies, CompiledNetworkPolicies):
        return network_policies
    return compile_network_policies(network_policies)


class FirewallAllow(NamedTuple):
    """Base URL matched and auth headers should be injected.

    ``permission`` and ``rule`` are present for a matched permission. They are
    ``None`` for unknown-endpoint allow, where the firewall base matched but no
    permission rule did and ``unknownPolicy`` allowed the request.
    """

    api_entry: dict
    name: str
    permission: str | None
    params: dict[str, str]
    rule: str | None
    rel_path: str


def _permission_allow(
    api_entry: dict,
    *,
    name: str,
    permission: str,
    params: dict[str, str],
    rule: str,
    rel_path: str,
) -> FirewallAllow:
    return FirewallAllow(api_entry, name, permission, params, rule, rel_path)


def _unknown_allow(
    api_entry: dict,
    *,
    name: str,
    params: dict[str, str],
    rel_path: str,
) -> FirewallAllow:
    return FirewallAllow(api_entry, name, None, params, None, rel_path)


FirewallBlockReason = Literal[
    "permission_denied",
    "unknown_endpoint",
    "malformed_firewall_config",
    "malformed_network_policy",
    "unsafe_path",
]


class FirewallBlock(NamedTuple):
    """Base URL matched but the request should return 403."""

    base: str
    name: str
    method: str
    path: str
    permissions: tuple[str, ...]  # denied/asked permission names only
    reason: FirewallBlockReason


class _BaseMatch(NamedTuple):
    base: str
    name: str
    rel_path: str
    api_entry: dict
    params: dict[str, str]


class _AllowedRuleMatch(NamedTuple):
    api_entry: dict
    name: str
    rel_path: str
    candidate: _CompiledRuleCandidate


class _BlockMatch(NamedTuple):
    base: str
    name: str
    method: str
    rel_path: str


class _FirewallDecisionState:
    """Mutable decision state for the single-pass compiled firewall matcher."""

    __slots__ = (
        "allowed_match",
        "base_match",
        "best_base_specificity",
        "best_rule_specificity",
        "denied_match",
        "denied_permission_names",
        "malformed_config_match",
        "malformed_policy_match",
    )

    allowed_match: _AllowedRuleMatch | None
    base_match: _BaseMatch | None
    best_base_specificity: int | None
    best_rule_specificity: _PathSpecificity | None
    denied_match: _BlockMatch | None
    # Dict keys act as an ordered set of first-seen denied permission names.
    denied_permission_names: dict[str, None]
    malformed_config_match: _BlockMatch | None
    malformed_policy_match: _BlockMatch | None

    def __init__(self) -> None:
        self.allowed_match = None
        self.base_match = None
        self.best_base_specificity = None
        self.best_rule_specificity = None
        self.denied_match = None
        self.denied_permission_names = {}
        self.malformed_config_match = None
        self.malformed_policy_match = None

    def accept_base_match(
        self,
        api_entry: _CompiledApi,
        *,
        name: str,
        rel_path: str,
        base_params: dict[str, str],
    ) -> bool:
        if (
            self.best_base_specificity is None
            or api_entry.base.specificity > self.best_base_specificity
        ):
            self.best_base_specificity = api_entry.base.specificity
            self.best_rule_specificity = None
            self.allowed_match = None
            self.base_match = None
            self.denied_match = None
            self.denied_permission_names = {}
            self.malformed_config_match = None
            self.malformed_policy_match = None
        elif api_entry.base.specificity < self.best_base_specificity:
            return False

        if self.base_match is None:
            self.base_match = _BaseMatch(
                api_entry.base.raw,
                name,
                rel_path,
                api_entry.raw_api_entry,
                base_params,
            )
        return True

    def record_malformed_config(self, match: _BlockMatch) -> None:
        if self.malformed_config_match is None:
            self.malformed_config_match = match

    def record_malformed_policy(self, match: _BlockMatch) -> None:
        if self.malformed_policy_match is None:
            self.malformed_policy_match = match

    def can_rule_specificity_affect_decision(self, specificity: _PathSpecificity) -> bool:
        if self.best_rule_specificity is None:
            return True
        if specificity > self.best_rule_specificity:
            return True
        if specificity < self.best_rule_specificity:
            return False
        return self.allowed_match is None

    def accept_rule_specificity(self, specificity: _PathSpecificity) -> bool:
        if self.best_rule_specificity is None or specificity > self.best_rule_specificity:
            self.best_rule_specificity = specificity
            self.allowed_match = None
            self.denied_match = None
            self.denied_permission_names = {}
        elif specificity < self.best_rule_specificity:
            return False

        return True

    def record_allowed_rule(self, match: _AllowedRuleMatch) -> None:
        if self.allowed_match is None:
            self.allowed_match = match

    def record_denied_rule(self, match: _BlockMatch, permission: str) -> None:
        self.denied_permission_names[permission] = None
        if self.denied_match is None:
            self.denied_match = match


def _resolve_firewall_decision(
    state: _FirewallDecisionState,
    *,
    compiled_network_policies: CompiledNetworkPolicies,
    upper_method: str,
) -> FirewallAllow | FirewallBlock | None:
    base_match = state.base_match
    if base_match is None:
        return None

    if state.allowed_match is not None:
        allowed_match = state.allowed_match
        candidate = allowed_match.candidate
        return _permission_allow(
            allowed_match.api_entry,
            name=allowed_match.name,
            permission=candidate.permission,
            params=candidate.params,
            rule=candidate.rule,
            rel_path=allowed_match.rel_path,
        )
    if state.denied_match is not None:
        denied_match = state.denied_match
        return FirewallBlock(
            denied_match.base,
            denied_match.name,
            denied_match.method,
            denied_match.rel_path,
            tuple(state.denied_permission_names),
            "permission_denied",
        )
    if state.malformed_policy_match is not None:
        match = state.malformed_policy_match
        return FirewallBlock(
            match.base,
            match.name,
            match.method,
            match.rel_path,
            (),
            "malformed_network_policy",
        )
    if state.malformed_config_match is not None:
        match = state.malformed_config_match
        return FirewallBlock(
            match.base,
            match.name,
            match.method,
            match.rel_path,
            (),
            "malformed_firewall_config",
        )

    blocked_policy = compiled_network_policies.policies.get(base_match.name)
    if blocked_policy is None:
        return _unknown_allow(
            base_match.api_entry,
            name=base_match.name,
            params=base_match.params,
            rel_path=base_match.rel_path,
        )
    if blocked_policy.unknown_policy_malformed:
        return FirewallBlock(
            base_match.base,
            base_match.name,
            upper_method,
            base_match.rel_path,
            (),
            "malformed_network_policy",
        )
    if blocked_policy.unknown_policy == "allow":
        return _unknown_allow(
            base_match.api_entry,
            name=base_match.name,
            params=base_match.params,
            rel_path=base_match.rel_path,
        )
    return FirewallBlock(
        base_match.base,
        base_match.name,
        upper_method,
        base_match.rel_path,
        (),
        "unknown_endpoint",
    )


def _evaluate_rule_entries(
    *,
    decision: _FirewallDecisionState,
    api_entry: _CompiledApi,
    fw_entry: _CompiledFirewall,
    policy: _CompiledNetworkPolicy | None,
    block_match: _BlockMatch,
    rel_path: str,
    rel_path_segs: list[str],
    base_params: dict[str, str],
    upper_method: str,
    rule_entries: tuple[_CompiledRuleEntry, ...],
) -> None:
    for entry in rule_entries:
        rule = entry.rule
        if rule.method not in ("ANY", upper_method):
            continue
        if not decision.can_rule_specificity_affect_decision(rule.specificity):
            continue

        permission_blocked = policy is not None and entry.permission in policy.blocked_permissions
        if permission_blocked:
            if not _compiled_path_segments_match(rel_path_segs, rule.path.segments):
                continue
            if not decision.accept_rule_specificity(rule.specificity):
                continue
            decision.record_denied_rule(block_match, entry.permission)
            continue

        params = _match_compiled_path_segments(rel_path_segs, rule.path.segments)
        if params is None:
            continue
        if not decision.accept_rule_specificity(rule.specificity):
            continue

        decision.record_allowed_rule(
            _AllowedRuleMatch(
                api_entry.raw_api_entry,
                fw_entry.name,
                rel_path,
                _CompiledRuleCandidate(
                    entry.permission,
                    rule.raw,
                    rule.specificity,
                    {**base_params, **params},
                ),
            )
        )


def _match_compiled_firewall_request_with_api_candidates(
    *,
    url_parts: _BaseUrlParts,
    url_has_backslash: bool,
    upper_method: str,
    compiled_network_policies: CompiledNetworkPolicies,
    api_candidates: tuple[_CompiledApiCandidate, ...],
    indexed_rules: bool,
) -> FirewallAllow | FirewallBlock | None:
    decision = _FirewallDecisionState()
    unsafe_path: bool | None = True if url_has_backslash else None

    for candidate in api_candidates:
        fw_entry = candidate.firewall
        api_entry = candidate.api
        policy = compiled_network_policies.policies.get(fw_entry.name)

        base_result = _match_compiled_base_url_parts(url_parts, api_entry.base)
        if base_result is None:
            continue

        rel_path, base_params = base_result

        if unsafe_path is None:
            unsafe_path = has_unsafe_path(url_parts.path)

        if unsafe_path:
            return FirewallBlock(
                api_entry.base.raw,
                fw_entry.name,
                upper_method,
                rel_path,
                (),
                "unsafe_path",
            )

        if not decision.accept_base_match(
            api_entry,
            name=fw_entry.name,
            rel_path=rel_path,
            base_params=base_params,
        ):
            continue

        block_match = _BlockMatch(
            api_entry.base.raw,
            fw_entry.name,
            upper_method,
            rel_path,
        )
        if api_entry.base_malformed or api_entry.auth_malformed or api_entry.has_malformed_rules:
            decision.record_malformed_config(block_match)
        if fw_entry.name_malformed or api_entry.base_malformed or api_entry.auth_malformed:
            continue
        if compiled_network_policies.top_level_malformed or (
            policy is not None and policy.permission_malformed
        ):
            decision.record_malformed_policy(block_match)
            continue

        if not api_entry.permissions:
            continue

        rel_path_segs = _split_path_segments(rel_path)
        rule_entries = (
            _indexed_rule_candidates(api_entry, upper_method, rel_path_segs)
            if indexed_rules
            else api_entry.rule_index.all_rules
        )
        _evaluate_rule_entries(
            decision=decision,
            api_entry=api_entry,
            fw_entry=fw_entry,
            policy=policy,
            block_match=block_match,
            rel_path=rel_path,
            rel_path_segs=rel_path_segs,
            base_params=base_params,
            upper_method=upper_method,
            rule_entries=rule_entries,
        )

    return _resolve_firewall_decision(
        decision,
        compiled_network_policies=compiled_network_policies,
        upper_method=upper_method,
    )


def _prepare_compiled_request_match(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None,
) -> tuple[_BaseUrlParts, bool, str, CompiledNetworkPolicies] | None:
    if not compiled_firewalls:
        return None

    url_has_backslash = "\\" in url
    url_parts = _split_base_match_url(
        url,
        allow_runtime_backslash_syntax=url_has_backslash,
    )
    if url_parts is None:
        return None

    return (
        url_parts,
        url_has_backslash,
        method.upper(),
        _ensure_compiled_network_policies(network_policies),
    )


def _match_compiled_firewall_request_linear(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None = None,
) -> FirewallAllow | FirewallBlock | None:
    prepared = _prepare_compiled_request_match(
        url,
        method,
        compiled_firewalls,
        network_policies,
    )
    if prepared is None or compiled_firewalls is None:
        return None

    url_parts, url_has_backslash, upper_method, compiled_network_policies = prepared
    return _match_compiled_firewall_request_with_api_candidates(
        url_parts=url_parts,
        url_has_backslash=url_has_backslash,
        upper_method=upper_method,
        compiled_network_policies=compiled_network_policies,
        api_candidates=compiled_firewalls.linear_api_candidates(),
        indexed_rules=False,
    )


def match_compiled_firewall_request(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None = None,
) -> FirewallAllow | FirewallBlock | None:
    """Match request against production precompiled firewall permissions.

    Retained malformed state from the compile functions applies only after the
    request matches a compiled base. It can surface as FirewallBlock reasons
    ``malformed_firewall_config`` or ``malformed_network_policy``; unsafe paths
    use ``unsafe_path`` after base match. APIs with malformed firewall name,
    base, or auth config do not evaluate their rules; malformed permission/rule
    config can still leave valid compiled rules eligible. Malformed top-level
    policies or malformed allow/deny/ask permission sets skip rule evaluation
    for the matched API. Recorded allow/deny rule decisions keep their current
    precedence over retained malformed state, and malformed ``unknownPolicy``
    only affects unknown-endpoint resolution.

    Returns:
      FirewallAllow — granted permission matched or unknown endpoint allowed
      FirewallBlock — permission denied, unknown endpoint blocked, or matched
        malformed firewall/network policy config or unsafe path failed closed
      None — no base URL match (not a firewall request)

    ``unknownPolicy="ask"`` is treated as block at the proxy layer.
    """
    prepared = _prepare_compiled_request_match(
        url,
        method,
        compiled_firewalls,
        network_policies,
    )
    if prepared is None or compiled_firewalls is None:
        return None

    url_parts, url_has_backslash, upper_method, compiled_network_policies = prepared
    return _match_compiled_firewall_request_with_api_candidates(
        url_parts=url_parts,
        url_has_backslash=url_has_backslash,
        upper_method=upper_method,
        compiled_network_policies=compiled_network_policies,
        api_candidates=compiled_firewalls.indexed_api_candidates(url_parts),
        indexed_rules=True,
    )
