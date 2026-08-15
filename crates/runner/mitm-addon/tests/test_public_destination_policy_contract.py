"""Shared public destination address policy contract tests."""

import json
from pathlib import Path

import pytest

import public_destination

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "public-destination-policy-contract.json"
)


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


def _load_cases() -> list[dict[str, object]]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    assert isinstance(raw_contract, dict)
    cases = raw_contract["addressPolicyCases"]
    assert isinstance(cases, list)
    assert cases
    assert all(isinstance(case, dict) for case in cases)
    names = [_case_name(case) for case in cases]
    assert len(names) == len(set(names))
    return cases


_ADDRESS_POLICY_CASES = _load_cases()


@pytest.mark.parametrize("case", _ADDRESS_POLICY_CASES, ids=_case_name)
def test_public_destination_address_policy_matches_shared_contract(
    case: dict[str, object],
) -> None:
    address = case["address"]
    assert isinstance(address, str)
    expected_public = case["expectedPublic"]
    assert isinstance(expected_public, bool)

    assert public_destination.public_ip_literal_is_public(address) is expected_public
