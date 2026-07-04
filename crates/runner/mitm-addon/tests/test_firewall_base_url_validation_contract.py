"""Shared firewall base URL validation contract tests."""

import json
from pathlib import Path

import pytest

import matching

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-base-url-validation-contract.json"
)


def _load_cases() -> list[dict[str, object]]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text())
    assert isinstance(raw_contract, dict)
    cases = raw_contract["baseUrlValidationCases"]
    assert isinstance(cases, list)
    assert all(isinstance(case, dict) for case in cases)
    return cases


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


_BASE_URL_VALIDATION_CASES = _load_cases()


@pytest.mark.parametrize("case", _BASE_URL_VALIDATION_CASES, ids=_case_name)
def test_firewall_base_url_config_validity_matches_shared_contract(
    case: dict[str, object],
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    expected_valid = case["expectedValid"]
    assert isinstance(expected_valid, bool)

    assert matching.firewall_base_config_is_valid(base) is expected_valid
