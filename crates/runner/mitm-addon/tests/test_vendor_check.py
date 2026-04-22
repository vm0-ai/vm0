"""Tests for the runtime vendor-shadow guard."""

import importlib
import sys
import types
from pathlib import Path

import pytest

import ijson
import vendor_check


def test_verify_passes_with_real_vendored_ijson():
    """The addon source tree at rest: ijson resolves to src/ijson/ and
    ``verify()`` returns cleanly."""
    vendor_check.verify()
    # The loaded ijson should sit alongside vendor_check.py under src/.
    expected_parent = Path(vendor_check.__file__).resolve().parent
    loaded_parent = Path(ijson.__file__).resolve().parent.parent
    assert loaded_parent == expected_parent


def _reimport_with_fake_ijson(tmp_path: Path, monkeypatch) -> None:
    """Stage a fake ``ijson`` ahead of ``src/ijson/`` on ``sys.path`` and
    reload ``vendor_check`` so its module-level ``import ijson`` picks up
    the fake copy.  Tests call ``vendor_check.verify()`` afterwards to
    trigger the shadow assertion.
    """
    fake_ijson = tmp_path / "ijson"
    fake_ijson.mkdir()
    (fake_ijson / "__init__.py").write_text("")
    monkeypatch.syspath_prepend(str(tmp_path))
    # sys.path order only affects the NEXT import; evict both modules so
    # reloading ``vendor_check`` re-resolves ``ijson`` against the fake.
    sys.modules.pop("ijson", None)
    sys.modules.pop("vendor_check", None)
    importlib.import_module("vendor_check")


@pytest.fixture
def _reset_modules_after_shadow_test():
    """Restore the real vendored ijson / vendor_check in sys.modules so
    subsequent tests don't pick up the fake ijson staged by this one.
    ``monkeypatch.syspath_prepend`` is reverted automatically; cached
    module entries are not."""
    yield
    sys.modules.pop("ijson", None)
    sys.modules.pop("vendor_check", None)


@pytest.mark.usefixtures("_reset_modules_after_shadow_test")
def test_verify_raises_on_shadow(tmp_path: Path, monkeypatch):
    """Simulate the failure mode: a stray ``ijson`` module on ``sys.path``
    ahead of the addon directory (what would happen if mitmdump's
    bundled Python started shipping ijson transitively).
    """
    _reimport_with_fake_ijson(tmp_path, monkeypatch)
    reloaded = importlib.import_module("vendor_check")
    with pytest.raises(RuntimeError, match="vendored ijson shadowed"):
        reloaded.verify()


@pytest.mark.usefixtures("_reset_modules_after_shadow_test")
def test_shadow_error_names_the_module(tmp_path: Path, monkeypatch):
    """The RuntimeError message must mention both the shadowing path and
    a pointer to vendor_check.py — operators see this in mitmdump's
    stderr and need to know where to look without grepping the codebase.
    """
    fake_ijson = tmp_path / "ijson"
    _reimport_with_fake_ijson(tmp_path, monkeypatch)
    reloaded = importlib.import_module("vendor_check")
    with pytest.raises(RuntimeError) as excinfo:
        reloaded.verify()

    msg = str(excinfo.value)
    assert str(fake_ijson) in msg, f"error should name the shadowing dir: {msg!r}"
    assert "vendor_check" in msg, f"error should point to vendor_check.py: {msg!r}"


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
