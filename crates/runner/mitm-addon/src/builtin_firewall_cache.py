"""Runner-written builtin firewall catalog cache reader."""

import json
import os
import stat
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from mitmproxy import ctx

MAX_BUILTIN_FIREWALL_CATALOG_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
_CACHE_SCHEMA_VERSION = 1
_SHA256_HEX_LENGTH = 64
CatalogFileKey = tuple[str, int, int, int, int]
CatalogIdentity = tuple[str, str, str, CatalogFileKey]


class BuiltinFirewallCatalogCacheError(ValueError):
    """Builtin firewall catalog cache is unavailable or malformed."""


@dataclass(frozen=True)
class BuiltinFirewallCatalog:
    identity: CatalogIdentity
    firewalls: dict[str, dict]


@dataclass
class _CatalogCacheState:
    path_key: str | None = None
    loaded_key: CatalogFileKey | None = None
    failed_key: CatalogFileKey | None = None
    catalog: BuiltinFirewallCatalog | None = None

    def reset(self, path_key: str | None = None) -> None:
        self.path_key = path_key
        self.loaded_key = None
        self.failed_key = None
        self.catalog = None


_cache_state = _CatalogCacheState()


def reset_cache_for_tests() -> None:
    """Reset builtin firewall catalog cache state between tests."""
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
    if not stat.S_ISREG(st.st_mode):
        return None
    return (_path_key(path), st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)


def load_catalog(cache_path: str | None) -> BuiltinFirewallCatalog | None:
    """Load the runner-written catalog cache, returning None when unavailable."""
    if not cache_path:
        return None

    path = Path(cache_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)

    try:
        fd, st = _open_cache_for_read(path)
    except OSError:
        state.reset(path_key)
        return None

    try:
        key = (path_key, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
        if key == state.loaded_key:
            return state.catalog
        if key == state.failed_key:
            return None
        try:
            catalog = _read_catalog(fd, path, st.st_size, key)
        except (BuiltinFirewallCatalogCacheError, OSError, ValueError, RecursionError) as exc:
            state.failed_key = key
            state.loaded_key = None
            state.catalog = None
            _warn(f"Failed to read builtin firewall catalog cache: {exc}")
            return None
    finally:
        os.close(fd)

    state.loaded_key = key
    state.failed_key = None
    state.catalog = catalog
    return catalog


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
        raise OSError(f"builtin firewall catalog cache is not a regular file: {path}")
    return fd, st


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


def _warn(message: str) -> None:
    with suppress(Exception):
        ctx.log.warn(message)
