"""Filesystem integration contracts for safe state-file reads."""

import errno
import os
from pathlib import Path
from unittest.mock import patch

import pytest

import state_file
from tests.thread_helpers import ThreadUnderTest


def _assert_descriptor_closed(fd: int) -> None:
    with pytest.raises(OSError, match="Bad file descriptor") as exc_info:
        os.fstat(fd)

    assert exc_info.value.errno == errno.EBADF


def test_reads_exact_limit_from_opened_identity_and_closes(tmp_path):
    path = tmp_path / "state.json"
    payload = b"state"
    path.write_bytes(payload)

    with state_file.open_state_file(path, description="test state") as opened_file:
        fd = opened_file.fd
        st = os.fstat(fd)

        assert opened_file.identity == state_file.StateFileIdentity(
            absolute_path=str(path.absolute()),
            st_dev=st.st_dev,
            st_ino=st.st_ino,
            st_mtime_ns=st.st_mtime_ns,
            st_size=st.st_size,
        )
        assert opened_file.read_bytes(len(payload)) == payload
        assert not os.get_inheritable(fd)

    _assert_descriptor_closed(fd)


def test_rejects_initially_oversized_file(tmp_path):
    path = tmp_path / "state.json"
    path.write_bytes(b"too large")

    with (
        state_file.open_state_file(path, description="test state") as opened_file,
        pytest.raises(OSError, match=r"test state .* exceeds 3 bytes"),
    ):
        opened_file.read_bytes(3)


def test_rejects_bytes_beyond_underreported_size():
    path = Path("/proc/self/status")
    assert path.stat().st_size == 0

    with (
        state_file.open_state_file(path, description="test state") as opened_file,
        pytest.raises(OSError, match=r"test state .* exceeds 1 bytes"),
    ):
        opened_file.read_bytes(1)


def test_rejects_symlink_without_following_target(tmp_path):
    target = tmp_path / "target.json"
    target.write_text("{}")
    path = tmp_path / "state.json"
    path.symlink_to(target)

    with pytest.raises(OSError, match="symbolic links"):
        state_file.open_state_file(path, description="test state")


def test_rejects_fifo_without_blocking(tmp_path):
    path = tmp_path / "state.json"
    os.mkfifo(path)

    def open_fifo() -> None:
        with pytest.raises(state_file.StateFileNotRegularError):
            state_file.open_state_file(path, description="test state")

    thread = ThreadUnderTest(target=open_fifo, daemon=True)
    thread.start()
    thread.join_and_raise(1)

    assert not thread.is_alive(), "state-file open blocked on FIFO"


def test_rejects_directory(tmp_path):
    path = tmp_path / "state.json"
    path.mkdir()

    with pytest.raises(state_file.StateFileNotRegularError):
        state_file.open_state_file(path, description="test state")


def test_fstat_failure_closes_opened_descriptor(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{}")
    opened_fds: list[int] = []
    real_open = os.open

    def record_open(open_path: Path, flags: int) -> int:
        fd = real_open(open_path, flags)
        opened_fds.append(fd)
        return fd

    with (
        patch.object(state_file.os, "open", side_effect=record_open),
        patch.object(state_file.os, "fstat", side_effect=OSError("fstat failed")),
        pytest.raises(OSError, match="fstat failed"),
    ):
        state_file.open_state_file(path, description="test state")

    assert len(opened_fds) == 1
    _assert_descriptor_closed(opened_fds[0])


def test_stat_validator_failure_closes_opened_descriptor(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{}")
    opened_fds: list[int] = []
    real_open = os.open

    def record_open(open_path: Path, flags: int) -> int:
        fd = real_open(open_path, flags)
        opened_fds.append(fd)
        return fd

    def reject_stat(_path: Path, _st: os.stat_result) -> None:
        raise PermissionError("untrusted")

    with (
        patch.object(state_file.os, "open", side_effect=record_open),
        pytest.raises(PermissionError, match="untrusted"),
    ):
        state_file.open_state_file(
            path,
            description="test state",
            validate_stat=reject_stat,
        )

    assert len(opened_fds) == 1
    _assert_descriptor_closed(opened_fds[0])


def test_identity_setup_failure_closes_opened_descriptor(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{}")
    opened_fds: list[int] = []
    real_open = os.open

    def record_open(open_path: Path, flags: int) -> int:
        fd = real_open(open_path, flags)
        opened_fds.append(fd)
        return fd

    with (
        patch.object(state_file.os, "open", side_effect=record_open),
        patch.object(state_file.Path, "absolute", side_effect=OSError("absolute failed")),
        pytest.raises(OSError, match="absolute failed"),
    ):
        state_file.open_state_file(path, description="test state")

    assert len(opened_fds) == 1
    _assert_descriptor_closed(opened_fds[0])
