"""Public helper API for flow metadata key linting."""

from __future__ import annotations

import ast
import tokenize
from pathlib import Path

from flow_metadata_linter.paths import METADATA_KEYS_FILE, SRC_ROOT, TESTS_ROOT
from flow_metadata_linter.visitor import _MetadataKeyVisitor


def _python_files() -> list[Path]:
    files: list[Path] = []
    for root in (SRC_ROOT, TESTS_ROOT):
        files.extend(path for path in root.rglob("*.py") if path != METADATA_KEYS_FILE)
    return sorted(files)


def metadata_key_violations(path: Path) -> list[str]:
    with tokenize.open(str(path)) as source_file:
        source = source_file.read()
    tree = ast.parse(source, filename=str(path))
    visitor = _MetadataKeyVisitor(path)
    visitor.visit(tree)
    return visitor.violations


def repository_metadata_key_violations() -> list[str]:
    return [violation for path in _python_files() for violation in metadata_key_violations(path)]
