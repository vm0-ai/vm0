"""Firewall metadata access helpers."""

from collections.abc import Mapping

import flow_metadata_keys as metadata_keys


def get_firewall_name_metadata(meta: Mapping[str, object]) -> str:
    value = meta.get(metadata_keys.FIREWALL_NAME)
    return value if isinstance(value, str) else ""
