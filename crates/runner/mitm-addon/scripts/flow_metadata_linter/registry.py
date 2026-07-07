"""Registered flow metadata key loading."""

from __future__ import annotations

import importlib.util
from types import ModuleType

from flow_metadata_linter.paths import METADATA_KEYS_FILE


def _load_metadata_keys() -> ModuleType:
    spec = importlib.util.spec_from_file_location("flow_metadata_keys", METADATA_KEYS_FILE)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {METADATA_KEYS_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


metadata_keys = _load_metadata_keys()
REGISTERED_METADATA_KEYS = {
    value: name
    for name, value in vars(metadata_keys).items()
    if name.isupper() and isinstance(value, str)
}


def duplicate_registered_metadata_keys() -> dict[str, list[str]]:
    names_by_value: dict[str, list[str]] = {}
    for name, value in vars(metadata_keys).items():
        if name.isupper() and isinstance(value, str):
            names_by_value.setdefault(value, []).append(name)
    return {value: names for value, names in sorted(names_by_value.items()) if len(names) > 1}
