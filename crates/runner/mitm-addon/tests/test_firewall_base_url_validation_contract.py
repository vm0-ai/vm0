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


def _load_syntax_cases() -> list[dict[str, object]]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    assert isinstance(raw_contract, dict)
    cases = raw_contract["baseUrlValidationCases"]
    assert isinstance(cases, list)
    assert cases
    assert all(isinstance(case, dict) for case in cases)
    # TypeScript owns hostname policy; this shared runner contract covers only
    # transport syntax that remains meaningful after the ASCII handoff.
    syntax_cases = [case for case in cases if case.get("category") != "hostname-policy"]
    assert syntax_cases
    names = [_case_name(case) for case in syntax_cases]
    assert len(names) == len(set(names))
    return syntax_cases


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


_BASE_URL_SYNTAX_CASES = _load_syntax_cases()


@pytest.mark.parametrize("case", _BASE_URL_SYNTAX_CASES, ids=_case_name)
def test_firewall_base_url_config_syntax_matches_shared_contract(
    case: dict[str, object],
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    expected_valid = case["expectedValid"]
    assert isinstance(expected_valid, bool)

    assert matching.firewall_base_config_is_valid(base) is expected_valid
