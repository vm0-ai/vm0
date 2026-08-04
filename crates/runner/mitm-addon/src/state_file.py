"""Safe bounded reads for runner-owned state files."""

import os
import stat
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, Self

_READ_CHUNK_BYTES = 1024 * 1024

type StatValidator = Callable[[Path, os.stat_result], None]


class StateFileIdentity(NamedTuple):
    """Identity of the descriptor opened for a state-file read."""

    absolute_path: str
    st_dev: int
    st_ino: int
    st_mtime_ns: int
    st_size: int


class StateFileNotRegularError(OSError):
    """The opened state-file path does not identify a regular file."""


@dataclass(frozen=True)
class OpenedStateFile:
    """Validated state-file descriptor owned by a context manager."""

    fd: int
    path: Path
    description: str
    identity: StateFileIdentity

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_args: object) -> None:
        os.close(self.fd)

    def read_bytes(self, max_bytes: int) -> bytes:
        """Read at most `max_bytes`, probing one extra byte for size drift."""
        if self.identity.st_size > max_bytes:
            raise OSError(f"{self.description} {self.path} exceeds {max_bytes} bytes")

        chunks: list[bytes] = []
        total = 0
        while total <= max_bytes:
            to_read = min(_READ_CHUNK_BYTES, max_bytes + 1 - total)
            chunk = os.read(self.fd, to_read)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)

        if total > max_bytes:
            raise OSError(f"{self.description} {self.path} exceeds {max_bytes} bytes")
        return b"".join(chunks)


def open_state_file(
    path: Path,
    *,
    description: str,
    validate_stat: StatValidator | None = None,
) -> OpenedStateFile:
    """Open and validate a state file, closing it if setup fails."""
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, flag_name, 0)
    fd = os.open(path, flags)
    try:
        st = _validate_opened_file(fd, path, description, validate_stat)
        return OpenedStateFile(
            fd=fd,
            path=path,
            description=description,
            identity=StateFileIdentity(
                absolute_path=str(path.absolute()),
                st_dev=st.st_dev,
                st_ino=st.st_ino,
                st_mtime_ns=st.st_mtime_ns,
                st_size=st.st_size,
            ),
        )
    except BaseException:
        os.close(fd)
        raise


def _validate_opened_file(
    fd: int,
    path: Path,
    description: str,
    validate_stat: StatValidator | None,
) -> os.stat_result:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise StateFileNotRegularError(f"{description} is not a regular file: {path}")
    if validate_stat is not None:
        validate_stat(path, st)
    return st
