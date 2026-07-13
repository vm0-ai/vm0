"""Command-line entry point for flow metadata key linting."""

from __future__ import annotations

import sys

from flow_metadata_linter.api import repository_metadata_key_violations
from flow_metadata_linter.paths import ADDON_ROOT, METADATA_KEYS_FILE
from flow_metadata_linter.registry import duplicate_registered_metadata_keys


def main() -> int:
    metadata_keys_location = METADATA_KEYS_FILE.relative_to(ADDON_ROOT)
    messages: list[str] = []
    for value, names in duplicate_registered_metadata_keys().items():
        messages.append(
            f"{metadata_keys_location}: duplicate metadata key {value!r}: {', '.join(names)}"
        )
    messages.extend(repository_metadata_key_violations())
    if not messages:
        return 0
    sys.stdout.write("\n".join(messages) + "\n")
    return 1
