"""Command-line entry point for flow metadata key linting."""

from __future__ import annotations

import sys

from flow_metadata_linter.api import repository_metadata_key_violations
from flow_metadata_linter.registry import duplicate_registered_metadata_keys


def main() -> int:
    messages: list[str] = []
    for value, names in duplicate_registered_metadata_keys().items():
        messages.append(
            f"src/flow_metadata_keys.py: duplicate metadata key {value!r}: {', '.join(names)}"
        )
    messages.extend(repository_metadata_key_violations())
    if not messages:
        return 0
    sys.stdout.write("\n".join(messages) + "\n")
    return 1
