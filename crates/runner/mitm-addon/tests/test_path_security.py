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
def test_has_unsafe_path_blocks_dot_segments(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api\\admin",
        "/api/%5cadmin",
        "/api/%5Cadmin",
        "/api/%5c..%5cadmin",
        "/api/%5C..%5Cadmin",
        "/api/foo%5cbar",
    ],
)
def test_has_unsafe_path_blocks_backslashes(path):
    assert path_security.has_unsafe_path(path) is True


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
def test_has_unsafe_path_allows_regular_segments(path):
    assert path_security.has_unsafe_path(path) is False
