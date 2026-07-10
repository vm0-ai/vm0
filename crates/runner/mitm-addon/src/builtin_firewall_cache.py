"""Runner-written builtin firewall catalog cache reader."""

import json
import os
import stat
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from mitmproxy import ctx

import builtin_host_policy
import matching
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

MAX_BUILTIN_FIREWALL_CATALOG_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
_CACHE_SCHEMA_VERSION = 1
_SHA256_HEX_LENGTH = 64
_RESERVED_PERMISSION_NAMES = frozenset(("all", "__unknown__"))
_UNTRUSTED_WRITE_BITS = stat.S_IWGRP | stat.S_IWOTH
CatalogFileKey = tuple[str, int, int, int, int]
CatalogIdentity = tuple[str, str, str, CatalogFileKey]


class BuiltinFirewallCatalogCacheError(ValueError):
    """Builtin firewall catalog cache is unavailable or malformed."""


class _CatalogCacheOpenError(OSError):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class BuiltinFirewallCatalog:
    identity: CatalogIdentity
    firewalls: dict[str, dict]


@dataclass(frozen=True)
class BuiltinFirewallCatalogSnapshot:
    dependency_file_key: CatalogFileKey | None
    catalog: BuiltinFirewallCatalog | None
    cache_path: str | None = None
    unavailable_reason: str | None = None


@dataclass
class _CatalogCacheState:
    path_key: str | None = None
    loaded_key: CatalogFileKey | None = None
    failed_key: CatalogFileKey | None = None
    failed_reason: str | None = None
    catalog: BuiltinFirewallCatalog | None = None

    def reset(self, path_key: str | None = None) -> None:
        self.path_key = path_key
        self.loaded_key = None
        self.failed_key = None
        self.failed_reason = None
        self.catalog = None


_cache_state = _CatalogCacheState()


def reset_cache_for_tests() -> None:
    """Reset builtin firewall catalog cache state between tests."""
    clear_cache()


def clear_cache() -> None:
    """Drop the in-process builtin firewall catalog cache."""
    _cache_state.reset()


def _path_key(path: Path) -> str:
    return str(path.absolute())


def _state_for_path(path_key: str) -> _CatalogCacheState:
    if _cache_state.path_key != path_key:
        _cache_state.reset(path_key)
    return _cache_state


def catalog_file_key(cache_path: str | None) -> CatalogFileKey | None:
    """Return current cache file identity for registry snapshot invalidation."""
    if not cache_path:
        return None
    path = Path(cache_path)
    try:
        st = path.stat(follow_symlinks=False)
    except OSError:
        return None
    if not _cache_file_stat_is_trusted(st):
        return None
    return (_path_key(path), st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)


def load_catalog_snapshot(cache_path: str | None) -> BuiltinFirewallCatalogSnapshot:
    """Load one catalog cache state for a single registry reload."""
    if not cache_path:
        return BuiltinFirewallCatalogSnapshot(
            None,
            None,
            unavailable_reason="cache_path_missing",
        )

    path = Path(cache_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)

    try:
        fd, st = _open_cache_for_read(path)
    except OSError as exc:
        state.reset(path_key)
        return BuiltinFirewallCatalogSnapshot(
            None,
            None,
            cache_path=path_key,
            unavailable_reason=_open_error_unavailable_reason(exc),
        )

    try:
        key = (path_key, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
        if key == state.loaded_key:
            return BuiltinFirewallCatalogSnapshot(key, state.catalog, cache_path=path_key)
        if key == state.failed_key:
            return BuiltinFirewallCatalogSnapshot(
                key,
                None,
                cache_path=path_key,
                unavailable_reason=state.failed_reason or "cache_invalid",
            )
        try:
            catalog = _read_catalog(fd, path, st.st_size, key)
        except (BuiltinFirewallCatalogCacheError, OSError, ValueError, RecursionError) as exc:
            state.failed_key = key
            state.failed_reason = "cache_invalid"
            state.loaded_key = None
            state.catalog = None
            _warn(f"Failed to read builtin firewall catalog cache: {exc}")
            return BuiltinFirewallCatalogSnapshot(
                key,
                None,
                cache_path=path_key,
                unavailable_reason=state.failed_reason,
            )
    finally:
        os.close(fd)

    state.loaded_key = key
    state.failed_key = None
    state.failed_reason = None
    state.catalog = catalog
    return BuiltinFirewallCatalogSnapshot(key, catalog, cache_path=path_key)


def _open_error_unavailable_reason(exc: OSError) -> str:
    if isinstance(exc, _CatalogCacheOpenError):
        return exc.reason
    if isinstance(exc, FileNotFoundError):
        return "cache_file_missing"
    if isinstance(exc, PermissionError):
        return "cache_permission_denied"
    return "cache_unavailable"


def _open_cache_for_read(path: Path) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, flag_name, 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        raise
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise _CatalogCacheOpenError(
            "cache_not_regular",
            f"builtin firewall catalog cache is not a regular file: {path}",
        )
    if not _cache_file_stat_is_trusted(st):
        os.close(fd)
        raise _CatalogCacheOpenError(
            "cache_untrusted",
            f"builtin firewall catalog cache is not trusted: {path}",
        )
    return fd, st


def _cache_file_stat_is_trusted(st: os.stat_result) -> bool:
    return (
        stat.S_ISREG(st.st_mode)
        and st.st_uid == os.geteuid()
        and (st.st_mode & _UNTRUSTED_WRITE_BITS) == 0
    )


def _read_cache_bytes(fd: int, path: Path, st_size: int) -> bytes:
    if st_size > MAX_BUILTIN_FIREWALL_CATALOG_BYTES:
        raise OSError(
            f"builtin firewall catalog cache {path} exceeds "
            f"{MAX_BUILTIN_FIREWALL_CATALOG_BYTES} bytes"
        )

    chunks: list[bytes] = []
    total = 0
    while total <= MAX_BUILTIN_FIREWALL_CATALOG_BYTES:
        to_read = min(_READ_CHUNK_BYTES, MAX_BUILTIN_FIREWALL_CATALOG_BYTES + 1 - total)
        chunk = os.read(fd, to_read)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)

    if total > MAX_BUILTIN_FIREWALL_CATALOG_BYTES:
        raise OSError(
            f"builtin firewall catalog cache {path} exceeds "
            f"{MAX_BUILTIN_FIREWALL_CATALOG_BYTES} bytes"
        )
    return b"".join(chunks)


def _read_catalog(
    fd: int,
    path: Path,
    st_size: int,
    key: CatalogFileKey,
) -> BuiltinFirewallCatalog:
    raw = json.loads(_read_cache_bytes(fd, path, st_size).decode("utf-8"))
    if not isinstance(raw, dict):
        raise BuiltinFirewallCatalogCacheError("catalog cache must be an object")

    schema_version = raw.get("schemaVersion")
    if not isinstance(schema_version, int) or isinstance(schema_version, bool):
        raise BuiltinFirewallCatalogCacheError("catalog cache schemaVersion must be an integer")
    if schema_version != _CACHE_SCHEMA_VERSION:
        raise BuiltinFirewallCatalogCacheError(
            f"unsupported catalog cache schemaVersion {schema_version}"
        )

    catalog_digest = raw.get("catalogDigest")
    if not isinstance(catalog_digest, str) or not _is_valid_catalog_digest(catalog_digest):
        raise BuiltinFirewallCatalogCacheError("catalog cache catalogDigest is invalid")
    catalog_version = raw.get("catalogVersion")
    if not isinstance(catalog_version, str) or catalog_version == "":
        raise BuiltinFirewallCatalogCacheError(
            "catalog cache catalogVersion must be a non-empty string"
        )

    firewalls = raw.get("firewalls")
    if not isinstance(firewalls, dict) or not firewalls:
        raise BuiltinFirewallCatalogCacheError("catalog cache firewalls must be a non-empty object")
    _validate_firewall_map(firewalls)

    return BuiltinFirewallCatalog(
        identity=("cache", catalog_digest, catalog_version, key),
        firewalls=firewalls,
    )


def _is_valid_catalog_digest(value: str) -> bool:
    prefix = "sha256:"
    if not value.startswith(prefix):
        return False
    digest = value[len(prefix) :]
    return (
        len(digest) == _SHA256_HEX_LENGTH
        and digest == digest.lower()
        and all(char in "0123456789abcdef" for char in digest)
    )


def _validate_firewall_map(firewalls: dict[str, dict]) -> None:
    for name, firewall in firewalls.items():
        if not isinstance(name, str) or name == "":
            raise BuiltinFirewallCatalogCacheError("catalog cache firewall keys must be non-empty")
        if not isinstance(firewall, dict):
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{name}" must be an object'
            )
        if firewall.get("name") != name:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall key "{name}" does not match firewall.name'
            )
        apis = firewall.get("apis")
        if not isinstance(apis, list) or not apis:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{name}" apis must be a non-empty list'
            )
        for api in apis:
            if not isinstance(api, dict):
                raise BuiltinFirewallCatalogCacheError(
                    f'catalog cache firewall "{name}" api entries must be objects'
                )
            _validate_api_entry(name, api)


def _validate_api_entry(firewall_name: str, api: dict) -> None:
    raw_base = api.get("base")
    if not isinstance(raw_base, str) or raw_base == "":
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base must be non-empty'
        )
    template_syntax_target = _base_url_template_syntax_target(firewall_name, raw_base)
    raw_syntax_target = template_syntax_target or raw_base
    if (
        "\\" in raw_syntax_target
        or has_raw_whitespace(raw_syntax_target)
        or has_unsafe_url_codepoint(raw_syntax_target)
        or "?" in raw_syntax_target
        or "#" in raw_syntax_target
    ):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base has invalid syntax'
        )
    if (
        template_syntax_target is not None
        and ("{" in template_syntax_target or "}" in template_syntax_target)
        and "://" in template_syntax_target
        and not matching.firewall_base_config_is_valid(template_syntax_target)
    ):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base has invalid parameters'
        )
    if template_syntax_target is None and not matching.firewall_base_config_is_valid(raw_base):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base is invalid'
        )

    if not matching.firewall_api_auth_config_is_valid(api):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api auth is invalid'
        )

    host_policy = api.get("hostPolicy")
    builtin_host_policy.validate_host_policy_shape_for_cache(
        firewall_name=firewall_name,
        host_policy=host_policy,
    )

    permissions = api.get("permissions")
    if permissions is None:
        return
    if not isinstance(permissions, list):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api permissions must be a list'
        )

    seen_names: set[str] = set()
    for permission in permissions:
        if not isinstance(permission, dict):
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permissions must be objects'
            )
        raw_name = permission.get("name")
        if not isinstance(raw_name, str) or raw_name == "":
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission names must be non-empty'
            )
        if raw_name in _RESERVED_PERMISSION_NAMES:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission name is reserved'
            )
        if raw_name in seen_names:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission names must be unique per api'
            )
        seen_names.add(raw_name)

        rules = permission.get("rules")
        if not isinstance(rules, list) or not rules:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission rules must be non-empty'
            )
        for rule in rules:
            if not isinstance(rule, str) or rule == "":
                raise BuiltinFirewallCatalogCacheError(
                    f'catalog cache firewall "{firewall_name}" permission rules must be strings'
                )
            if not matching.firewall_rule_is_valid(rule):
                raise BuiltinFirewallCatalogCacheError(
                    f'catalog cache firewall "{firewall_name}" permission rule is invalid'
                )


def _base_url_template_syntax_target(firewall_name: str, raw_base: str) -> str | None:
    search_start = 0
    result: list[str] = []
    found = False
    while True:
        start = raw_base.find("${{", search_start)
        if start == -1:
            if not found:
                return None
            result.append(raw_base[search_start:])
            return "".join(result)
        found = True
        content_start = start + len("${{")
        end = raw_base.find("}}", content_start)
        if end == -1:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" api base template is unterminated'
            )
        _validate_base_url_var_reference(firewall_name, raw_base[content_start:end])
        result.append(raw_base[search_start:start])
        result.append("template")
        search_start = end + len("}}")


def _validate_base_url_var_reference(firewall_name: str, content: str) -> None:
    stripped = content.strip()
    if not stripped.startswith("vars."):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base template must use vars'
        )
    name = stripped[len("vars.") :]
    if not name or not _is_ascii_identifier_start(name[0]):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base template variable is invalid'
        )
    if not all(_is_ascii_identifier_continue(char) for char in name):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base template variable is invalid'
        )


def _is_ascii_identifier_start(char: str) -> bool:
    return ("A" <= char <= "Z") or ("a" <= char <= "z") or char == "_"


def _is_ascii_identifier_continue(char: str) -> bool:
    return _is_ascii_identifier_start(char) or ("0" <= char <= "9")


def _warn(message: str) -> None:
    with suppress(Exception):
        ctx.log.warn(message)
