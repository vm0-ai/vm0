"""Local invariants for :mod:`usage.providers.connectors.x_billing`.

Request/response parsing, body refinement, handler dispatch, and usage emission
are covered through the connector usage integration suites. This module checks
the executable local classifier configuration and its pricing seed contract.
"""

from __future__ import annotations

import pathlib
import re

import pytest

import matching
from usage.providers.connectors.x_billing import (
    _BODY_REFINEMENT_RULES,
    _INCLUDES_TO_BUCKET,
    _PATH_OVERRIDES,
    _PERMISSION_TO_BUCKET,
    _build_override_index,
    classify_bucket,
)

_PATH_PARAM_RE = re.compile(r"^(?P<prefix>[^{}]*)\{(?P<name>[^{}]+)\}(?P<suffix>[^{}]*)$")
_SIMPLE_PATH_PARAM_SEGMENT_RE = re.compile(r"^\{[^{}+*]+\}$")


def _sample_path_for_pattern(pattern: str) -> str:
    segments: list[str] = []
    for segment in pattern.split("/"):
        if not segment:
            continue
        match = _PATH_PARAM_RE.match(segment)
        if match is None:
            segments.append(segment)
            continue

        name = match.group("name")
        if name.endswith(("+", "*")):
            segments.append("sample")
        else:
            segments.append(f"{match.group('prefix')}sample{match.group('suffix')}")

    return "/" + "/".join(segments)


@pytest.mark.parametrize(
    ("permission", "method", "path", "expected"),
    [
        ("tweet.read", "GET", "/2/tweets/123", "posts.read"),
        ("tweet.read", "get", "/2/tweets/123/retweeted_by", "user.read"),
        ("like.write", "DELETE", "/2/users/1/likes/2", "interaction.delete"),
        ("app-only", "GET", "/2/tweets", None),
        ("unknown", "GET", "/", None),
    ],
)
def test_classifies_explicit_local_bucket_cases(
    permission: str,
    method: str,
    path: str,
    expected: str | None,
):
    assert classify_bucket(permission, method, path) == expected


class TestOverrideClassification:
    def test_path_overrides_use_simple_parameter_segments(self):
        """Keep local overlap checks within the pattern shapes they understand."""
        complex_patterns: list[tuple[str, str, str, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            for segment in pattern.split("/"):
                if "{" not in segment and "}" not in segment:
                    continue
                if _SIMPLE_PATH_PARAM_SEGMENT_RE.fullmatch(segment) is None:
                    complex_patterns.append((scope, method, pattern, bucket))
                    break

        assert not complex_patterns, (
            "X billing path overrides use mixed or greedy parameter segments: "
            f"{complex_patterns}. The representative-path shadowing checks only prove "
            "non-shadowing for literal segments and whole-segment placeholders."
        )

    def test_every_path_override_classifies_sample_to_configured_bucket(self):
        mismatches: list[tuple[str, str, str, str, str, str | None]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            sample_path = _sample_path_for_pattern(pattern)
            actual = classify_bucket(scope, method, sample_path)
            if actual != bucket:
                mismatches.append((scope, method, pattern, sample_path, bucket, actual))

        assert not mismatches, (
            "X billing path overrides do not classify representative sample "
            f"paths to their configured buckets: {mismatches}."
        )

    def test_path_override_order_does_not_shadow_different_bucket_overrides(self):
        compiled_overrides: list[tuple[str, str, str, str, matching.CompiledPathPattern, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            compiled_pattern = matching.compile_path_pattern(pattern)
            if compiled_pattern is None:
                pytest.fail(f"invalid X billing override path pattern: {scope} {method} {pattern}")

            sample_path = _sample_path_for_pattern(pattern)
            if matching.match_compiled_path(sample_path, compiled_pattern) is None:
                pytest.fail(
                    "The X billing override shadowing check generated a non-matching "
                    f"sample path {sample_path!r} for pattern {pattern!r}."
                )
            compiled_overrides.append(
                (scope, method, pattern, bucket, compiled_pattern, sample_path)
            )

        shadowed: list[tuple[str, str, str, str, str, str, str]] = []
        for index, current in enumerate(compiled_overrides):
            scope, method, pattern, bucket, compiled_pattern, _sample_path = current
            for other in compiled_overrides[index + 1 :]:
                (
                    other_scope,
                    other_method,
                    other_pattern,
                    other_bucket,
                    _other_compiled,
                    other_sample,
                ) = other
                if scope != other_scope or method != other_method or bucket == other_bucket:
                    continue
                if matching.match_compiled_path(other_sample, compiled_pattern) is not None:
                    shadowed.append(
                        (scope, method, pattern, bucket, other_pattern, other_bucket, other_sample)
                    )

        assert not shadowed, (
            "Earlier X billing path overrides shadow later overrides with "
            f"different buckets: {shadowed}. classify_bucket uses first-match-wins."
        )

    def test_no_duplicate_path_overrides(self):
        seen: dict[tuple[str, str, str], str] = {}
        duplicates: list[tuple[str, str, str, str, str]] = []
        for scope, method, pattern, bucket in _PATH_OVERRIDES:
            key = (scope, method, pattern)
            previous = seen.get(key)
            if previous is not None:
                duplicates.append((scope, method, pattern, previous, bucket))
            seen[key] = bucket

        assert not duplicates, (
            "Duplicate X billing path overrides would be hidden by "
            f"first-match-wins classification: {duplicates}."
        )

    def test_invalid_static_override_path_fails_fast(self):
        with pytest.raises(ValueError, match="invalid X billing override path pattern"):
            _build_override_index(
                [
                    ("tweet.read", "GET", "/2/tweets/{id}literal{other}", "user.read"),
                ]
            )


class TestSeedConsistency:
    """Every bucket emitted by local classifier code must have a pricing row."""

    def _load_seed_category_entries(self) -> tuple[str, ...]:
        seed_path = (
            pathlib.Path(__file__).resolve().parent.parent.parent.parent.parent
            / "turbo"
            / "apps"
            / "api"
            / "src"
            / "scripts"
            / "dev-seed.ts"
        )
        if not seed_path.exists():
            pytest.fail(
                f"dev-seed.ts not found at {seed_path}. The X connector "
                "pricing block has likely moved."
            )
        text = seed_path.read_text()
        start_marker = 'usageGroup("connector", "x", ['
        try:
            start = text.index(start_marker)
            end = text.index("])", start)
        except ValueError:
            pytest.fail(
                f"Could not locate the `{start_marker}...])` block in "
                f"{seed_path}. Update this test to match the current seed shape."
            )
        block = text[start:end]
        return tuple(re.findall(r'\[\s*"([^"]+)"\s*,', block))

    def _load_seed_categories(self) -> set[str]:
        return set(self._load_seed_category_entries())

    def _emitted_buckets(self) -> set[str]:
        emitted = set(_PERMISSION_TO_BUCKET.values())
        emitted.update(bucket for _, _, _, bucket in _PATH_OVERRIDES)
        emitted.update(_INCLUDES_TO_BUCKET.values())
        emitted.update(rule.target_bucket for rule in _BODY_REFINEMENT_RULES)
        return emitted

    def test_every_emitted_bucket_is_in_seed(self):
        seed = self._load_seed_categories()
        emitted = self._emitted_buckets()
        missing = emitted - seed
        assert not missing, f"classifier emits buckets not present in dev-seed: {sorted(missing)}"

    def test_seed_categories_are_unique(self):
        seen: set[str] = set()
        duplicates: list[str] = []
        for category in self._load_seed_category_entries():
            if category in seen:
                duplicates.append(category)
            seen.add(category)

        assert not duplicates, (
            "dev-seed.ts has duplicate X connector usage categories: "
            f"{duplicates}. usage_pricing is keyed by kind/provider/category."
        )

    def test_fallback_row_is_seeded(self):
        seed = self._load_seed_categories()
        assert "__fallback__" in seed, (
            "dev-seed.ts lost the X connector `__fallback__` row. "
            "Unknown includes keys would bill at $0."
        )
