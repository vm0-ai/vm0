"""Verify canonical API hostname output with the pinned runner runtime."""

from __future__ import annotations

import os
import sys
from importlib import import_module
from pathlib import Path
from typing import Protocol, cast

_CORPUS_PATH_ENV = "VM0_FIREWALL_HOSTNAME_CORPUS_PATH"
_ADDON_SRC_PATH_ENV = "VM0_MITM_ADDON_SRC_PATH"
_SAMPLE_LIMIT = 20


class _HostNormalizerModule(Protocol):
    def normalize_idna_hostname(self, host: str) -> str: ...


def _load_host_normalizer() -> _HostNormalizerModule:
    source_path = os.environ.get(_ADDON_SRC_PATH_ENV)
    if not source_path:
        raise RuntimeError(f"{_ADDON_SRC_PATH_ENV} is required")
    sys.path.insert(0, source_path)
    return cast(_HostNormalizerModule, import_module("host_normalization"))


def _verify_corpus(path: Path) -> None:
    host_normalizer = _load_host_normalizer()
    failures: list[str] = []
    count = 0
    with path.open(encoding="utf-8") as corpus:
        for raw_line in corpus:
            hostname = raw_line.rstrip("\n")
            if not hostname:
                continue
            count += 1
            try:
                normalized = host_normalizer.normalize_idna_hostname(hostname)
            except (UnicodeError, ValueError):
                if len(failures) < _SAMPLE_LIMIT:
                    failures.append(f"rejected {hostname!r}")
                continue
            if normalized != hostname and len(failures) < _SAMPLE_LIMIT:
                failures.append(f"changed {hostname!r} to {normalized!r}")

    if count == 0:
        raise RuntimeError("firewall hostname corpus is empty")
    if failures:
        details = "; ".join(failures)
        raise RuntimeError(f"pinned runner rejected canonical API hostnames: {details}")


def _main() -> None:
    corpus_path = os.environ.get(_CORPUS_PATH_ENV)
    if not corpus_path:
        raise RuntimeError(f"{_CORPUS_PATH_ENV} is required")
    _verify_corpus(Path(corpus_path))


_main()
raise SystemExit(0)
