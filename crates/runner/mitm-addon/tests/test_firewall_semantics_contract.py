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


def _contract_cases(raw_contract: dict[str, object], key: str) -> list[dict[str, object]]:
    cases = raw_contract[key]
    assert isinstance(cases, list)
    assert all(isinstance(case, dict) for case in cases)
    return cases


def _load_cases() -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    raw_contract = json.loads(_CONTRACT_PATH.read_text())
    assert isinstance(raw_contract, dict)

    return (
        _contract_cases(raw_contract, "segmentParseCases"),
        _contract_cases(raw_contract, "pathSplitCases"),
        _contract_cases(raw_contract, "pathMatchCases"),
        _contract_cases(raw_contract, "hostMatchCases"),
        _contract_cases(raw_contract, "pathPrefixMatchCases"),
        _contract_cases(raw_contract, "baseUrlMatchCases"),
    )


def _case_name(case: dict[str, object]) -> str:
    name = case["name"]
    assert isinstance(name, str)
    return name


def _expected_kind(expected: dict[str, object]) -> str:
    kind = expected["kind"]
    assert isinstance(kind, str)
    return kind


def _relative_path_from_segments(segments: list[str], consumed: int) -> str:
    rest = "/".join(segments[consumed:])
    return "/" if rest == "" else f"/{rest}"


def _assert_params_match(
    actual: dict[str, str] | None,
    expected: dict[str, object],
) -> None:
    if _expected_kind(expected) == "no-match":
        assert actual is None
        return

    params = expected["params"]
    assert isinstance(params, dict)
    assert all(isinstance(key, str) for key in params)
    assert all(isinstance(value, str) for value in params.values())
    assert actual == params


def _assert_relative_path_match(
    actual: str | None,
    expected: dict[str, object],
) -> None:
    if _expected_kind(expected) == "no-match":
        assert actual is None
        return

    relative_path = expected["relativePath"]
    assert isinstance(relative_path, str)
    assert actual == relative_path


(
    _SEGMENT_PARSE_CASES,
    _PATH_SPLIT_CASES,
    _PATH_MATCH_CASES,
    _HOST_MATCH_CASES,
    _PATH_PREFIX_MATCH_CASES,
    _BASE_URL_MATCH_CASES,
) = _load_cases()


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


@pytest.mark.parametrize("case", _PATH_MATCH_CASES, ids=_case_name)
def test_path_matching_matches_shared_contract(case: dict[str, object]):
    path = case["path"]
    assert isinstance(path, str)
    pattern = case["pattern"]
    assert isinstance(pattern, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    _assert_params_match(matching.match_path(path, pattern), expected)


@pytest.mark.parametrize("case", _HOST_MATCH_CASES, ids=_case_name)
def test_host_matching_matches_shared_contract(case: dict[str, object]):
    host = case["host"]
    assert isinstance(host, str)
    pattern = case["pattern"]
    assert isinstance(pattern, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    _assert_params_match(matching.match_host(host, pattern), expected)


@pytest.mark.parametrize("case", _PATH_PREFIX_MATCH_CASES, ids=_case_name)
def test_path_prefix_matching_matches_shared_contract(case: dict[str, object]):
    path = case["path"]
    assert isinstance(path, str)
    pattern = case["pattern"]
    assert isinstance(pattern, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    path_segments = _split_path_segments(path)
    pattern_segments = _split_path_segments(pattern)
    result = matching.match_path_prefix(path_segments, pattern_segments)
    actual_relative_path = (
        None if result is None else _relative_path_from_segments(path_segments, result[1])
    )
    _assert_relative_path_match(actual_relative_path, expected)


@pytest.mark.parametrize("case", _BASE_URL_MATCH_CASES, ids=_case_name)
def test_base_url_matching_matches_shared_contract(case: dict[str, object]):
    url = case["url"]
    assert isinstance(url, str)
    base = case["base"]
    assert isinstance(base, str)

    expected = case["expected"]
    assert isinstance(expected, dict)

    result = matching.match_base_url(url, base)
    actual_relative_path = None if result is None else result[0]
    _assert_relative_path_match(actual_relative_path, expected)
