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
        "/api/..;matrix=1/admin",
        "/api/%2e%2e%3bmatrix=1/admin",
        "/api/%252e%252e/admin",
        "/api/%252E%252E/admin",
        "/api/%252e%252e%253bmatrix=1/admin",
        "/api/%252e%252e%252fadmin",
        "/api/%252f..",
        "/api/%25252525252e%25252525252e/admin",
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
        "/api/%255cadmin",
        "/api/%255C..%255Cadmin",
    ],
)
def test_has_unsafe_path_blocks_backslashes(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%/admin",
        "/api/%2/admin",
        "/api/%zz/admin",
        "/api/%2e%zz/admin",
        "/api/%25zz/admin",
    ],
)
def test_has_unsafe_path_blocks_invalid_percent_escapes(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%00/admin",
        "/api/%0a/admin",
        "/api/%7f/admin",
        "/api/%2500/admin",
    ],
)
def test_has_unsafe_path_blocks_percent_encoded_unsafe_codepoints(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%ef%bc%8e%ef%bc%8e/admin",
        "/api/%ef%bc%8e./admin",
        "/api/%ef%bc%8f../admin",
        "/api/..%ef%bc%8fadmin",
        "/api/%ef%bc%bc..%ef%bc%bcadmin",
        "/api/%ef%bc%852e/admin",
        "/api/\u2024\u2024/admin",
        "/api/\u2025/admin",
        "/api/\ufe52\ufe52/admin",
        "/api/\ufe30/admin",
        "/api/..\u037ematrix/admin",
        "/api/\ufe68admin",
        "/api/\ufe6a2e/admin",
    ],
)
def test_has_unsafe_path_blocks_compatibility_normalized_syntax(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/api/%ff/admin",
        "/api/%c0%af../admin",
        "/api/%ed%a0%80/admin",
        "/api/%25ff/admin",
        "/api/%25ed%25a0%2580/admin",
    ],
)
def test_has_unsafe_path_blocks_invalid_percent_encoded_utf8(path):
    assert path_security.has_unsafe_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/api/users",
        "/api/..hidden/admin",
        "/api/a..b/admin",
        "/api/callback;matrix=1",
        "/api/foo%2Fbar",
        "/api/foo%252Fbar",
        "/api/%E2%9C%93",
        "/api/✓",
        "/api/%ef%bc%a1",
        "/api/%ef%bc%8e%ef%bc%8ehidden",
        "/api/foo%ef%bc%8fbar",
        "/api/foo\u2024bar",
        "/api/\u2024\u2024hidden",
        "/api/\u2025hidden",
        "/api/%2e%2ehidden",
        "/api/%252e%252ehidden",
    ],
)
def test_has_unsafe_path_allows_regular_segments(path):
    assert path_security.has_unsafe_path(path) is False
