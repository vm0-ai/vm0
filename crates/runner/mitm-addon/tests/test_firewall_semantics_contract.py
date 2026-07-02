"""Shared firewall semantics contract tests."""

import json
from pathlib import Path

import pytest

import matching
from firewall_matching.patterns import _split_path_segments

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[4]
    / "turbo"
    / "packages"
    / "connectors"
    / "src"
    / "__tests__"
    / "firewall-semantics-contract.json"
)


def _load_cases() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text())
    assert isinstance(raw_contract, dict)

    segment_parse_cases = raw_contract["segmentParseCases"]
    assert isinstance(segment_parse_cases, list)
    assert all(isinstance(case, dict) for case in segment_parse_cases)

    path_split_cases = raw_contract["pathSplitCases"]
    assert isinstance(path_split_cases, list)
    assert all(isinstance(case, dict) for case in path_split_cases)

    return segment_parse_cases, path_split_cases


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


_SEGMENT_PARSE_CASES, _PATH_SPLIT_CASES = _load_cases()


@pytest.mark.parametrize("case", _SEGMENT_PARSE_CASES, ids=_case_name)
def test_segment_parsing_matches_shared_contract(case: dict[str, object]):
    segment = case["segment"]
    assert isinstance(segment, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    actual = matching.parse_segment(segment)
    expected_kind = expected["kind"]
    assert isinstance(expected_kind, str)

    if expected_kind == "error":
        assert actual["kind"] == "error"
        reason_includes = expected["reasonIncludes"]
        assert isinstance(reason_includes, str)
        reason = actual["reason"]
        assert isinstance(reason, str)
        assert reason_includes in reason
        return

    assert actual == expected


@pytest.mark.parametrize("case", _PATH_SPLIT_CASES, ids=_case_name)
def test_path_splitting_matches_shared_contract(case: dict[str, object]):
    path = case["path"]
    assert isinstance(path, str)

    expected = case["expected"]
    assert isinstance(expected, list)
    assert all(isinstance(segment, str) for segment in expected)

    assert _split_path_segments(path) == expected
