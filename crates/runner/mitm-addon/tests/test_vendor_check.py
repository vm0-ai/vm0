"""Tests for the runtime vendor-shadow guard."""

import importlib
import sys
import types
from pathlib import Path

import pytest

import ijson
import vendor_check


def test_vendor_check_passes_with_real_vendored_ijson():
    """The addon source tree at rest: ijson resolves to src/ijson/ and
    vendor_check imports cleanly. A passing import in the test suite is
    effectively the check — re-import to exercise it once more."""
    importlib.reload(vendor_check)
    # The loaded ijson should sit alongside vendor_check.py under src/.
    expected_parent = Path(vendor_check.__file__).resolve().parent
    loaded_parent = Path(ijson.__file__).resolve().parent.parent
    assert loaded_parent == expected_parent


def test_vendor_check_raises_on_shadow(tmp_path: Path, monkeypatch):
    """Simulate the failure mode: a stray ``ijson`` module appearing in a
    sys.path entry ahead of the addon directory (what would happen if
    mitmdump's bundled Python started shipping ijson transitively).

    We stage a fake ``ijson`` at ``tmp_path/ijson/__init__.py``, drop
    ``ijson`` / ``vendor_check`` from ``sys.modules`` so the next import
    is resolved fresh, prepend ``tmp_path`` to ``sys.path``, and expect
    ``import vendor_check`` to raise.
    """
    fake_ijson = tmp_path / "ijson"
    fake_ijson.mkdir()
    (fake_ijson / "__init__.py").write_text("__file__ = __file__\n")

    monkeypatch.syspath_prepend(str(tmp_path))
    # Force re-import of both modules; sys.path ordering only affects the
    # NEXT import, not modules already cached in sys.modules.
    sys.modules.pop("ijson", None)
    sys.modules.pop("vendor_check", None)

    with pytest.raises(RuntimeError, match="vendored ijson shadowed"):
        importlib.import_module("vendor_check")

    # Cleanup: drop the fake ijson so other tests get the real vendored
    # copy back. monkeypatch reverts sys.path automatically.
    sys.modules.pop("ijson", None)
    sys.modules.pop("vendor_check", None)


def test_vendor_check_error_names_the_module(tmp_path: Path, monkeypatch):
    """The RuntimeError message must mention both the shadowing path and
    a pointer to vendor_check.py — operators see this in mitmdump's
    stderr and need to know where to look without grepping the codebase.
    """
    fake_ijson = tmp_path / "ijson"
    fake_ijson.mkdir()
    (fake_ijson / "__init__.py").write_text("")

    monkeypatch.syspath_prepend(str(tmp_path))
    sys.modules.pop("ijson", None)
    sys.modules.pop("vendor_check", None)

    with pytest.raises(RuntimeError) as excinfo:
        importlib.import_module("vendor_check")

    msg = str(excinfo.value)
    assert str(fake_ijson) in msg, f"error should name the shadowing dir: {msg!r}"
    assert "vendor_check" in msg, f"error should point to vendor_check.py: {msg!r}"

    sys.modules.pop("ijson", None)
    sys.modules.pop("vendor_check", None)


def test_verify_helper_accepts_correctly_placed_module():
    """Unit-level coverage of the internal helper against a fabricated
    module whose ``__file__`` sits at ``<expected>/foo/__init__.py``."""
    fake = types.ModuleType("foo")
    fake.__file__ = "/fake/vendor_root/foo/__init__.py"
    vendor_check._verify(fake, Path("/fake/vendor_root"))  # should not raise


def test_verify_helper_rejects_mismatched_module():
    fake = types.ModuleType("foo")
    fake.__file__ = "/opt/site-packages/foo/__init__.py"
    with pytest.raises(RuntimeError, match="vendored foo shadowed"):
        vendor_check._verify(fake, Path("/fake/vendor_root"))
