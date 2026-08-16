"""Local invariants for X request fallback hint policies.

Connector dispatch and usage emission remain covered through the X usage
integration suite. This module independently pins the compact first-match
policy matrix, including row identity and query-boundary behavior that final
billing output cannot distinguish on its own.
"""

from collections import Counter
from typing import NamedTuple

import pytest

import matching
from usage.providers.connectors.x import (
    _REQUEST_FALLBACK_HINT_POLICIES,
    _REQUEST_FALLBACK_HINT_POLICY_SPECS,
    _parse_request_query_fallback_hints,
    _request_fallback_hint_policy_for_path,
    _RequestFallbackHintPolicy,
)


class _ExpectedPolicy(NamedTuple):
    id_query_key: str | None
    id_count_max: int | None
    max_results_min: int | None
    max_results_max: int | None


class _PolicyCase(NamedTuple):
    pattern: str
    concrete_path: str
    expected_policy: _ExpectedPolicy


class _PolicyBoundaryCase(NamedTuple):
    name: str
    concrete_path: str
    query_key: str
    minimum: int
    maximum: int


_EXPECTED_IDS_100_POLICY = _ExpectedPolicy("ids", 100, None, None)
_EXPECTED_USERNAMES_100_POLICY = _ExpectedPolicy("usernames", 100, None, None)
_EXPECTED_PAGE_1_TO_100_POLICY = _ExpectedPolicy(None, None, 1, 100)
_EXPECTED_PAGE_5_TO_100_POLICY = _ExpectedPolicy(None, None, 5, 100)
_EXPECTED_PAGE_10_TO_100_POLICY = _ExpectedPolicy(None, None, 10, 100)
_EXPECTED_PAGE_1_TO_1000_POLICY = _ExpectedPolicy(None, None, 1, 1000)


# Keep this inventory literal and independent from the production table. A
# legitimate policy change must update both sides explicitly so row drift is
# visible in review and fails before it can silently affect fallback billing.
_EXPECTED_POLICY_CASES: tuple[_PolicyCase, ...] = (
    _PolicyCase("/2/spaces", "/2/spaces", _EXPECTED_IDS_100_POLICY),
    _PolicyCase("/2/tweets", "/2/tweets", _EXPECTED_IDS_100_POLICY),
    _PolicyCase("/2/tweets/analytics", "/2/tweets/analytics", _EXPECTED_IDS_100_POLICY),
    _PolicyCase("/2/users", "/2/users", _EXPECTED_IDS_100_POLICY),
    _PolicyCase("/2/users/by", "/2/users/by", _EXPECTED_USERNAMES_100_POLICY),
    _PolicyCase("/2/users/public_keys", "/2/users/public_keys", _EXPECTED_IDS_100_POLICY),
    _PolicyCase(
        "/2/chat/conversations",
        "/2/chat/conversations",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/communities/search",
        "/2/communities/search",
        _EXPECTED_PAGE_10_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/dm_conversations/with/{participant_id}/dm_events",
        "/2/dm_conversations/with/participant-123/dm_events",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/dm_conversations/{id}/dm_events",
        "/2/dm_conversations/conversation-123/dm_events",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase("/2/dm_events", "/2/dm_events", _EXPECTED_PAGE_1_TO_100_POLICY),
    _PolicyCase(
        "/2/lists/{id}/followers",
        "/2/lists/list-123/followers",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/lists/{id}/members",
        "/2/lists/list-123/members",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/lists/{id}/tweets",
        "/2/lists/list-123/tweets",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase("/2/news/search", "/2/news/search", _EXPECTED_PAGE_1_TO_100_POLICY),
    _PolicyCase(
        "/2/notes/search/notes_written",
        "/2/notes/search/notes_written",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/notes/search/posts_eligible_for_notes",
        "/2/notes/search/posts_eligible_for_notes",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase("/2/spaces/search", "/2/spaces/search", _EXPECTED_PAGE_1_TO_100_POLICY),
    _PolicyCase(
        "/2/spaces/{id}/buyers",
        "/2/spaces/space-123/buyers",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/spaces/{id}/tweets",
        "/2/spaces/space-123/tweets",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/tweets/search/recent",
        "/2/tweets/search/recent",
        _EXPECTED_PAGE_10_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/tweets/{id}/liking_users",
        "/2/tweets/tweet-123/liking_users",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/tweets/{id}/quote_tweets",
        "/2/tweets/tweet-123/quote_tweets",
        _EXPECTED_PAGE_10_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/tweets/{id}/retweeted_by",
        "/2/tweets/tweet-123/retweeted_by",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/tweets/{id}/retweets",
        "/2/tweets/tweet-123/retweets",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/reposts_of_me",
        "/2/users/reposts_of_me",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase("/2/users/search", "/2/users/search", _EXPECTED_PAGE_1_TO_1000_POLICY),
    _PolicyCase(
        "/2/users/{id}/affiliates",
        "/2/users/user-123/affiliates",
        _EXPECTED_PAGE_1_TO_1000_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/blocking",
        "/2/users/user-123/blocking",
        _EXPECTED_PAGE_1_TO_1000_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/bookmarks",
        "/2/users/user-123/bookmarks",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/bookmarks/folders",
        "/2/users/user-123/bookmarks/folders",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/followed_lists",
        "/2/users/user-123/followed_lists",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/followers",
        "/2/users/user-123/followers",
        _EXPECTED_PAGE_1_TO_1000_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/following",
        "/2/users/user-123/following",
        _EXPECTED_PAGE_1_TO_1000_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/liked_tweets",
        "/2/users/user-123/liked_tweets",
        _EXPECTED_PAGE_5_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/list_memberships",
        "/2/users/user-123/list_memberships",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/mentions",
        "/2/users/user-123/mentions",
        _EXPECTED_PAGE_5_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/muting",
        "/2/users/user-123/muting",
        _EXPECTED_PAGE_1_TO_1000_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/owned_lists",
        "/2/users/user-123/owned_lists",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/timelines/reverse_chronological",
        "/2/users/user-123/timelines/reverse_chronological",
        _EXPECTED_PAGE_1_TO_100_POLICY,
    ),
    _PolicyCase(
        "/2/users/{id}/tweets",
        "/2/users/user-123/tweets",
        _EXPECTED_PAGE_5_TO_100_POLICY,
    ),
)

_POLICY_BOUNDARY_CASES: tuple[_PolicyBoundaryCase, ...] = (
    _PolicyBoundaryCase("ids-1-to-100", "/2/tweets", "ids", 1, 100),
    _PolicyBoundaryCase("usernames-1-to-100", "/2/users/by", "usernames", 1, 100),
    _PolicyBoundaryCase("page-1-to-100", "/2/news/search", "max_results", 1, 100),
    _PolicyBoundaryCase(
        "page-5-to-100",
        "/2/users/user-123/liked_tweets",
        "max_results",
        5,
        100,
    ),
    _PolicyBoundaryCase(
        "page-10-to-100",
        "/2/tweets/search/recent",
        "max_results",
        10,
        100,
    ),
    _PolicyBoundaryCase("page-1-to-1000", "/2/users/search", "max_results", 1, 1000),
)


def _normalize_policy(policy: _RequestFallbackHintPolicy) -> _ExpectedPolicy:
    return _ExpectedPolicy(
        policy.id_query_key,
        policy.id_count_max,
        policy.max_results_min,
        policy.max_results_max,
    )


def _duplicate_values(values: list[str]) -> list[str]:
    return sorted(value for value, count in Counter(values).items() if count > 1)


def _first_matching_production_pattern(path: str) -> str | None:
    for (pattern, _policy), (compiled_pattern, _compiled_policy) in zip(
        _REQUEST_FALLBACK_HINT_POLICY_SPECS,
        _REQUEST_FALLBACK_HINT_POLICIES,
        strict=True,
    ):
        if matching.match_compiled_path(path, compiled_pattern) is not None:
            return pattern
    return None


def _query_for_count(case: _PolicyBoundaryCase, count: int) -> str:
    if case.query_key == "max_results":
        return f"max_results={count}"
    if count == 0:
        return f"{case.query_key}=,,"
    return f"{case.query_key}={','.join(str(index) for index in range(1, count + 1))}"


def _parse_boundary_case(case: _PolicyBoundaryCase, count: int) -> dict:
    query = _query_for_count(case, count)
    return _parse_request_query_fallback_hints(f"https://api.x.com{case.concrete_path}?{query}")


def _expected_hints(case: _PolicyBoundaryCase, count: int) -> dict:
    if case.query_key == "max_results":
        return {"request_ids_count": None, "max_results": count}
    return {"request_ids_count": count, "max_results": None}


def test_expected_policy_fixture_covers_production_table_exactly():
    expected_rows = [(case.pattern, case.expected_policy) for case in _EXPECTED_POLICY_CASES]
    production_rows = [
        (pattern, _normalize_policy(policy))
        for pattern, policy in _REQUEST_FALLBACK_HINT_POLICY_SPECS
    ]
    expected_patterns = [pattern for pattern, _policy in expected_rows]
    production_patterns = [pattern for pattern, _policy in production_rows]

    assert not _duplicate_values(expected_patterns), (
        "X fallback hint test fixture has duplicate path patterns: "
        f"{_duplicate_values(expected_patterns)}"
    )
    assert not _duplicate_values(production_patterns), (
        "X fallback hint production table has duplicate path patterns hidden by "
        f"first-match lookup: {_duplicate_values(production_patterns)}"
    )

    expected_by_pattern = dict(expected_rows)
    production_by_pattern = dict(production_rows)
    missing_from_fixture = sorted(production_by_pattern.keys() - expected_by_pattern.keys())
    missing_from_production = sorted(expected_by_pattern.keys() - production_by_pattern.keys())
    mismatched_policies = {
        pattern: (expected_by_pattern[pattern], production_by_pattern[pattern])
        for pattern in sorted(expected_by_pattern.keys() & production_by_pattern.keys())
        if expected_by_pattern[pattern] != production_by_pattern[pattern]
    }

    assert not missing_from_fixture, (
        f"production X fallback hint rows are missing from the fixture: {missing_from_fixture}"
    )
    assert not missing_from_production, (
        f"expected X fallback hint rows are missing from production: {missing_from_production}"
    )
    assert not mismatched_policies, (
        f"X fallback hint policy assignments drifted: {mismatched_policies}"
    )


@pytest.mark.parametrize(
    "case",
    _EXPECTED_POLICY_CASES,
    ids=[case.pattern for case in _EXPECTED_POLICY_CASES],
)
def test_every_policy_path_selects_expected_policy(case: _PolicyCase):
    policy = _request_fallback_hint_policy_for_path(case.concrete_path)

    assert policy is not None, f"no fallback hint policy matched {case.concrete_path!r}"
    assert _normalize_policy(policy) == case.expected_policy


@pytest.mark.parametrize(
    "case",
    _EXPECTED_POLICY_CASES,
    ids=[case.pattern for case in _EXPECTED_POLICY_CASES],
)
def test_every_policy_row_is_first_match_reachable(case: _PolicyCase):
    expected_pattern = matching.compile_path_pattern(case.pattern)
    assert expected_pattern is not None, f"invalid expected path pattern: {case.pattern!r}"
    assert matching.match_compiled_path(case.concrete_path, expected_pattern) is not None, (
        f"fixture path {case.concrete_path!r} does not match its expected pattern {case.pattern!r}"
    )

    first_match = _first_matching_production_pattern(case.concrete_path)
    assert first_match == case.pattern, (
        f"production pattern {first_match!r} shadows {case.pattern!r} "
        f"for fixture path {case.concrete_path!r}"
    )


@pytest.mark.parametrize(
    "case",
    _POLICY_BOUNDARY_CASES,
    ids=[case.name for case in _POLICY_BOUNDARY_CASES],
)
def test_policy_family_accepts_minimum_and_maximum(case: _PolicyBoundaryCase):
    for count in (case.minimum, case.maximum):
        assert _parse_boundary_case(case, count) == _expected_hints(case, count)


@pytest.mark.parametrize(
    "case",
    _POLICY_BOUNDARY_CASES,
    ids=[case.name for case in _POLICY_BOUNDARY_CASES],
)
def test_policy_family_rejects_immediately_outside_bounds(case: _PolicyBoundaryCase):
    for count in (case.minimum - 1, case.maximum + 1):
        assert _parse_boundary_case(case, count) == {
            "request_ids_count": None,
            "max_results": None,
        }, f"{case.name} accepted out-of-range count {count}"
