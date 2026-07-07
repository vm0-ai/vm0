"""Filesystem paths for flow metadata key linting."""

from __future__ import annotations

from pathlib import Path

ADDON_ROOT = Path(__file__).resolve().parents[2]
SRC_ROOT = ADDON_ROOT / "src"
TESTS_ROOT = ADDON_ROOT / "tests"
METADATA_KEYS_FILE = SRC_ROOT / "flow_metadata_keys.py"
