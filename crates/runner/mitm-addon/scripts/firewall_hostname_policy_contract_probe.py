"""Verify the shared hostname policy inside the pinned mitmdump runtime."""

from __future__ import annotations

import json
import re
import sys
from importlib import import_module
from pathlib import Path
from typing import NamedTuple, Protocol, cast
from unicodedata import unidata_version

_ROOT = Path(__file__).resolve().parents[4]
_CONTRACT_PATH = (
    _ROOT
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-base-url-validation-contract.json"
)
_ADDON_SRC_PATH = Path(__file__).resolve().parents[1] / "src"
_POLICY_PATTERN = re.compile(r"^vm0-uts46-(?P<unicode_version>\d+\.\d+)-v[1-9]\d*$")
_POLICY_UNICODE_COMPONENT_COUNT = 2


class _HostnamePolicyCase(NamedTuple):
    name: str
    hostname: str
    expected_canonical_hostname: str


class _HostNormalizerModule(Protocol):
    def normalize_idna_hostname(self, host: str) -> str: ...


def _require_object(value: object, location: str) -> dict[object, object]:
    if not isinstance(value, dict):
        raise TypeError(f"{location} must be an object")
    return cast(dict[object, object], value)


def _require_string(value: object, location: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{location} must be a string")
    return value


def _load_contract() -> tuple[str, list[_HostnamePolicyCase]]:
    raw_contract: object = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    contract = _require_object(raw_contract, "contract")
    policy = _require_string(contract.get("hostnamePolicy"), "hostnamePolicy")

    raw_cases = contract.get("hostnamePolicyCases")
    if not isinstance(raw_cases, list):
        raise TypeError("hostnamePolicyCases must be an array")
    if not raw_cases:
        raise ValueError("hostnamePolicyCases must not be empty")

    cases: list[_HostnamePolicyCase] = []
    names: set[str] = set()
    for index, raw_case in enumerate(raw_cases):
        location = f"hostnamePolicyCases[{index}]"
        case = _require_object(raw_case, location)
        name = _require_string(case.get("name"), f"{location}.name")
        if name in names:
            raise RuntimeError(f"duplicate hostname policy case name: {name}")
        names.add(name)
        cases.append(
            _HostnamePolicyCase(
                name=name,
                hostname=_require_string(case.get("hostname"), f"{location}.hostname"),
                expected_canonical_hostname=_require_string(
                    case.get("expectedCanonicalHostname"),
                    f"{location}.expectedCanonicalHostname",
                ),
            )
        )

    return policy, cases


def _expected_unicode_version(policy: str) -> str:
    match = _POLICY_PATTERN.fullmatch(policy)
    if match is None:
        raise RuntimeError(f"unsupported firewall hostname policy: {policy}")
    return match.group("unicode_version")


def _runtime_unicode_version() -> str:
    components = unidata_version.split(".")
    if len(components) < _POLICY_UNICODE_COMPONENT_COUNT:
        raise RuntimeError(f"unexpected runtime Unicode version: {unidata_version}")
    return ".".join(components[:_POLICY_UNICODE_COMPONENT_COUNT])


def _load_host_normalizer() -> _HostNormalizerModule:
    sys.path.insert(0, str(_ADDON_SRC_PATH))
    return cast(_HostNormalizerModule, import_module("host_normalization"))


def _main() -> None:
    policy, cases = _load_contract()
    expected_unicode_version = _expected_unicode_version(policy)
    runtime_unicode_version = _runtime_unicode_version()
    if runtime_unicode_version != expected_unicode_version:
        raise RuntimeError(
            "pinned mitmdump Unicode version does not match firewall hostname policy: "
            f"expected {expected_unicode_version}, got {unidata_version}"
        )

    host_normalizer = _load_host_normalizer()
    for case in cases:
        actual = host_normalizer.normalize_idna_hostname(case.hostname)
        if actual != case.expected_canonical_hostname:
            raise RuntimeError(
                f"hostname policy case {case.name!r} produced {actual!r}; "
                f"expected {case.expected_canonical_hostname!r}"
            )


_main()
raise SystemExit(0)
