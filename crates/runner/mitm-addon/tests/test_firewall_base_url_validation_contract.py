"""Shared firewall base URL validation contract tests."""

import json
from pathlib import Path

import pytest

import builtin_base_url
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


def _load_cases(key: str) -> list[dict[str, object]]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    assert isinstance(raw_contract, dict)
    cases = raw_contract[key]
    assert isinstance(cases, list)
    assert cases
    assert all(isinstance(case, dict) for case in cases)
    names = [_case_name(case) for case in cases]
    assert len(names) == len(set(names))
    return cases


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


_BASE_URL_VALIDATION_CASES = _load_cases("baseUrlValidationCases")
_BASE_URL_TEMPLATE_RESOLUTION_CASES = _load_cases("baseUrlTemplateResolutionCases")


@pytest.mark.parametrize("case", _BASE_URL_VALIDATION_CASES, ids=_case_name)
def test_firewall_base_url_config_validity_matches_shared_contract(
    case: dict[str, object],
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    expected_valid = case["expectedValid"]
    assert isinstance(expected_valid, bool)

    assert matching.firewall_base_config_is_valid(base) is expected_valid


@pytest.mark.parametrize("case", _BASE_URL_TEMPLATE_RESOLUTION_CASES, ids=_case_name)
def test_firewall_base_url_template_resolution_matches_shared_contract(
    case: dict[str, object],
) -> None:
    base = case["base"]
    assert isinstance(base, str)
    raw_vars = case["vars"]
    assert isinstance(raw_vars, dict)
    vars_map: dict[str, str] = {}
    for name, value in raw_vars.items():
        assert isinstance(name, str)
        assert isinstance(value, str)
        vars_map[name] = value
    expected_resolved_base = case["expectedResolvedBase"]
    assert expected_resolved_base is None or isinstance(expected_resolved_base, str)

    if expected_resolved_base is None:
        with pytest.raises(builtin_base_url.BuiltinBaseUrlResolutionError):
            builtin_base_url.resolve_base_url_template(
                firewall_name="contract",
                base=base,
                vars_map=vars_map,
            )
        return

    assert (
        builtin_base_url.resolve_base_url_template(
            firewall_name="contract",
            base=base,
            vars_map=vars_map,
        )
        == expected_resolved_base
    )
