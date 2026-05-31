"""Tests for URL path safety helpers."""

import pytest

import path_security


@pytest.mark.parametrize(
    "path",
    [
        "/api/./admin",
        "/api/../admin",
        "/api/%2e/admin",
        "/api/%2e%2e/admin",
        "/api/%2E%2E/admin",
        "/api/%2e%2e%2fadmin",
        "/api/foo%2F..",
    ],
)
def test_has_unsafe_dot_segment_blocks_dot_segments(path):
    assert path_security.has_unsafe_dot_segment(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/api/users",
        "/api/..hidden/admin",
        "/api/a..b/admin",
        "/api/foo%2Fbar",
        "/api/%2e%2ehidden",
    ],
)
def test_has_unsafe_dot_segment_allows_regular_segments(path):
    assert path_security.has_unsafe_dot_segment(path) is False
