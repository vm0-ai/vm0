#!/usr/bin/env python3
"""Atomically cut Runner host tuning aliases to their canonical names."""

from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path

ALIAS_PAIRS = (
    ("OKOU_RUNNER_CONCURRENCY_FACTOR", "VM0_RUNNER_CONCURRENCY_FACTOR"),
    (
        "OKOU_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC",
        "VM0_RUNNER_DISK_BANDWIDTH_MIB_PER_SEC",
    ),
    ("OKOU_RUNNER_DISK_IOPS", "VM0_RUNNER_DISK_IOPS"),
    ("OKOU_RUNNER_NET_RX_MIB_PER_SEC", "VM0_RUNNER_NET_RX_MIB_PER_SEC"),
    ("OKOU_RUNNER_NET_TX_MIB_PER_SEC", "VM0_RUNNER_NET_TX_MIB_PER_SEC"),
)
ALIASES = {
    alias: (canonical, alias != canonical)
    for canonical, legacy in ALIAS_PAIRS
    for alias in (canonical, legacy)
}
BACKUP_SUFFIX = ".okou-alias-cutover-backup"
RESULT_PREFIX = "host_env_alias_cutover="


class CutoverConflict(Exception):
    """The cutover cannot proceed without weakening file safety."""


def exists(path: Path) -> bool:
    return os.path.lexists(path)


def backup_path(path: Path) -> Path:
    return path.with_name(f".{path.name}{BACKUP_SUFFIX}")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_regular_file(path: Path) -> tuple[bytes, os.stat_result]:
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode):
        raise CutoverConflict

    with path.open("rb") as source:
        content = source.read()
        opened = os.fstat(source.fileno())

    if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
        raise CutoverConflict
    return content, opened


def metadata_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_uid,
        metadata.st_gid,
        stat.S_IMODE(metadata.st_mode),
    )


def ownership_and_mode(metadata: os.stat_result) -> tuple[int, int, int]:
    return (
        metadata.st_uid,
        metadata.st_gid,
        stat.S_IMODE(metadata.st_mode),
    )


def transform(content: bytes) -> tuple[bytes, bool]:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CutoverConflict from error

    provided: set[str] = set()
    rewritten: list[str] = []
    changed = False

    for line in text.splitlines(keepends=True):
        equals = line.find("=")
        if equals < 0:
            rewritten.append(line)
            continue

        prefix = line[:equals]
        start = 0
        while start < len(prefix) and prefix[start].isspace():
            start += 1
        end = len(prefix)
        while end > start and prefix[end - 1].isspace():
            end -= 1

        key = prefix[start:end]
        alias = ALIASES.get(key)
        if alias is None:
            rewritten.append(line)
            continue

        canonical, is_legacy = alias
        if canonical in provided:
            raise CutoverConflict
        provided.add(canonical)

        if is_legacy:
            prefix = f"{prefix[:start]}{canonical}{prefix[end:]}"
            line = f"{prefix}{line[equals:]}"
            changed = True
        rewritten.append(line)

    return "".join(rewritten).encode("utf-8"), changed


def write_sibling(
    destination: Path,
    content: bytes,
    metadata: os.stat_result,
    *,
    replace: bool,
) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.tmp-",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
            output.flush()
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fsync(output.fileno())

        os.utime(
            temporary,
            ns=(metadata.st_atime_ns, metadata.st_mtime_ns),
            follow_symlinks=False,
        )
        if replace:
            os.replace(temporary, destination)
        else:
            os.link(temporary, destination)
            temporary.unlink()
        fsync_directory(destination.parent)
    finally:
        if exists(temporary):
            temporary.unlink()


def restore(path: Path) -> str:
    backup = backup_path(path)
    if not exists(backup):
        return "already-restored"

    original, original_metadata = read_regular_file(backup)
    canonical, changed = transform(original)
    if not changed:
        raise CutoverConflict

    if exists(path):
        current, current_metadata = read_regular_file(path)
        if current == original and ownership_and_mode(
            current_metadata
        ) == ownership_and_mode(original_metadata):
            backup.unlink()
            fsync_directory(path.parent)
            return "restored"
        if current not in {original, canonical}:
            raise CutoverConflict

    os.replace(backup, path)
    fsync_directory(path.parent)

    restored, restored_metadata = read_regular_file(path)
    if restored != original or ownership_and_mode(
        restored_metadata
    ) != ownership_and_mode(original_metadata):
        raise CutoverConflict
    return "restored"


def migrate_with_backup(path: Path, backup: Path) -> str:
    original, original_metadata = read_regular_file(backup)
    canonical, changed = transform(original)
    if not changed or not exists(path):
        raise CutoverConflict

    current, current_metadata = read_regular_file(path)
    if current == canonical:
        if ownership_and_mode(current_metadata) != ownership_and_mode(
            original_metadata
        ):
            raise CutoverConflict
        return "migrated"
    if current != original:
        raise CutoverConflict

    write_sibling(path, canonical, original_metadata, replace=True)
    return "migrated"


def migrate(path: Path) -> str:
    backup = backup_path(path)
    if exists(backup):
        return migrate_with_backup(path, backup)
    if not exists(path):
        return "absent"

    original, original_metadata = read_regular_file(path)
    canonical, changed = transform(original)
    if not changed:
        return "already-canonical"

    try:
        write_sibling(backup, original, original_metadata, replace=False)
        current, current_metadata = read_regular_file(path)
        if current != original or metadata_identity(
            current_metadata
        ) != metadata_identity(original_metadata):
            raise CutoverConflict
        write_sibling(path, canonical, original_metadata, replace=True)
    except (CutoverConflict, OSError) as error:
        try:
            restore(path)
        except (CutoverConflict, OSError) as restore_error:
            raise CutoverConflict from restore_error
        raise CutoverConflict from error
    return "migrated"


def finalize(path: Path) -> str:
    backup = backup_path(path)
    if not exists(backup):
        return "already-canonical"
    if not exists(path):
        raise CutoverConflict

    original, original_metadata = read_regular_file(backup)
    canonical, changed = transform(original)
    current, current_metadata = read_regular_file(path)
    if not changed or current != canonical:
        raise CutoverConflict
    if ownership_and_mode(current_metadata) != ownership_and_mode(original_metadata):
        raise CutoverConflict

    backup.unlink()
    fsync_directory(path.parent)
    return "migrated"


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"migrate", "restore", "finalize"}:
        print(f"{RESULT_PREFIX}conflict")
        return 2

    action = sys.argv[1]
    path = Path(sys.argv[2])
    try:
        if action == "migrate":
            result = migrate(path)
        elif action == "restore":
            result = restore(path)
        else:
            result = finalize(path)
    except (CutoverConflict, OSError):
        print(f"{RESULT_PREFIX}conflict")
        return 1

    print(f"{RESULT_PREFIX}{result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
