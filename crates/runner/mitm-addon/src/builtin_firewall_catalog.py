"""Local runner cache provider for builtin firewall definitions."""

import json
import os
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import Any, TypeGuard

from mitmproxy import ctx

SCHEMA_VERSION = 1
MAX_CACHE_BYTES = 16 * 1024 * 1024
_READ_CHUNK_BYTES = 1024 * 1024
_FILE_CACHE_KEY_LENGTH = 5

_CacheKey = tuple[str, int, int, int, int] | tuple[str, str] | None
_loaded_key: _CacheKey = None
_loaded_entries: dict[str, dict[str, Any]] = {}


def reset_cache_for_tests() -> None:
    global _loaded_key, _loaded_entries
    _loaded_key = None
    _loaded_entries = {}


def cache_key() -> _CacheKey:
    path = _cache_path()
    if not path:
        return None
    try:
        st = Path(path).stat(follow_symlinks=False)
    except OSError:
        return (path, "missing")
    if not stat.S_ISREG(st.st_mode):
        return (path, "not-regular")
    return (path, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)


def get_builtin_firewall(
    name: str,
    bundled_catalog: Mapping[str, dict[str, Any]],
) -> dict[str, Any] | None:
    entries = _local_entries()
    local = entries.get(name)
    if local is not None:
        return local
    return bundled_catalog.get(name)


def _cache_path() -> str:
    options = getattr(ctx, "options", None)
    return getattr(options, "vm0_builtin_firewall_catalog_cache_path", "") or ""


def _local_entries() -> dict[str, dict[str, Any]]:
    global _loaded_key, _loaded_entries
    key = cache_key()
    if key is None:
        _loaded_key = key
        _loaded_entries = {}
        return _loaded_entries
    if key == _loaded_key:
        return _loaded_entries

    path = _cache_path()
    entries = _read_local_entries(Path(path), key)
    _loaded_key = key
    _loaded_entries = entries
    return _loaded_entries


def _read_local_entries(path: Path, key: _CacheKey) -> dict[str, dict[str, Any]]:
    if not _is_file_cache_key(key):
        return {}
    try:
        raw_cache = json.loads(_read_cache_bytes(path).decode("utf-8"))
    except (OSError, ValueError, RecursionError) as exc:
        ctx.log.warn(f"Failed to read builtin firewall catalog cache: {type(exc).__name__}: {exc}")
        return {}

    if not isinstance(raw_cache, dict):
        ctx.log.warn("Ignoring builtin firewall catalog cache: root must be an object")
        return {}
    if raw_cache.get("schemaVersion") != SCHEMA_VERSION:
        ctx.log.warn("Ignoring builtin firewall catalog cache: unsupported schemaVersion")
        return {}
    raw_entries = raw_cache.get("entries")
    if not isinstance(raw_entries, dict):
        ctx.log.warn("Ignoring builtin firewall catalog cache: entries must be an object")
        return {}

    entries: dict[str, dict[str, Any]] = {}
    for name, raw_entry in raw_entries.items():
        if not isinstance(name, str) or not isinstance(raw_entry, dict):
            continue
        firewall = raw_entry.get("firewall")
        if _is_valid_firewall(firewall, name=name):
            entries[name] = firewall
    return entries


def _is_file_cache_key(key: _CacheKey) -> bool:
    return isinstance(key, tuple) and len(key) == _FILE_CACHE_KEY_LENGTH


def _is_valid_firewall(firewall: object, *, name: str) -> TypeGuard[dict[str, Any]]:
    if not isinstance(firewall, dict):
        return False
    raw_name = firewall.get("name")
    if raw_name is not None and raw_name != name:
        return False
    apis = firewall.get("apis")
    return isinstance(apis, list) and all(isinstance(api, dict) for api in apis)


def _read_cache_bytes(path: Path) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise OSError(f"builtin firewall catalog cache {path} is not a regular file")
        if st.st_size > MAX_CACHE_BYTES:
            raise OSError(f"builtin firewall catalog cache {path} exceeds {MAX_CACHE_BYTES} bytes")
        chunks: list[bytes] = []
        total = 0
        while True:
            to_read = min(_READ_CHUNK_BYTES, MAX_CACHE_BYTES + 1 - total)
            if to_read <= 0:
                raise OSError(
                    f"builtin firewall catalog cache {path} exceeds {MAX_CACHE_BYTES} bytes"
                )
            chunk = os.read(fd, to_read)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > MAX_CACHE_BYTES:
            raise OSError(f"builtin firewall catalog cache {path} exceeds {MAX_CACHE_BYTES} bytes")
        return b"".join(chunks)
    finally:
        os.close(fd)
