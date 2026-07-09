"""Lint registered ``flow.metadata`` key usage in the mitm addon."""

from __future__ import annotations

from flow_metadata_linter.api import metadata_key_violations, repository_metadata_key_violations
from flow_metadata_linter.cli import main
from flow_metadata_linter.registry import duplicate_registered_metadata_keys

__all__ = [
    "duplicate_registered_metadata_keys",
    "main",
    "metadata_key_violations",
    "repository_metadata_key_violations",
]
