"""Tests for bounded JSON prefix probing helpers."""

import pytest

from usage.json_probe import probe_top_level_string_field


def test_probe_finds_top_level_string_field_without_scanning_rest():
    result = probe_top_level_string_field(
        b'{"type":"response.completed","payload":' + b"x" * 100_000
    )

    assert result.status == "found"
    assert result.value == "response.completed"
    assert result.field_seen


@pytest.mark.parametrize(
    "number",
    [
        pytest.param(b"0.0", id="zero-fraction"),
        pytest.param(b"1.25", id="positive-fraction"),
        pytest.param(b"-2.5e+3", id="negative-fraction-positive-exponent"),
        pytest.param(b"1e3", id="exponent-without-sign"),
        pytest.param(b"1E-3", id="uppercase-negative-exponent"),
    ],
)
def test_probe_skips_fractional_and_exponent_numbers_before_field(number: bytes):
    result = probe_top_level_string_field(b'{"score":' + number + b',"type":"response.completed"}')

    assert result.status == "found"
    assert result.value == "response.completed"
    assert result.field_seen


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(
            b'{"score":1.,"type":"response.completed"}',
            id="fraction-missing-digit",
        ),
        pytest.param(
            b'{"score":1e,"type":"response.completed"}',
            id="exponent-missing-digit",
        ),
        pytest.param(
            b'{"score":1e+,"type":"response.completed"}',
            id="signed-exponent-missing-digit",
        ),
        pytest.param(
            b'{"score":00.5,"type":"response.completed"}',
            id="leading-zero-fraction",
        ),
    ],
)
def test_probe_rejects_malformed_fractional_and_exponent_numbers_before_field(body: bytes):
    result = probe_top_level_string_field(body)

    assert result.status == "invalid"
    assert result.value is None
    assert not result.field_seen


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(b'{"score":1.', id="fraction-missing-digit"),
        pytest.param(b'{"score":1e', id="exponent-missing-digit"),
        pytest.param(b'{"score":1e+', id="signed-exponent-missing-digit"),
    ],
)
def test_probe_reports_incomplete_fractional_and_exponent_prefixes_before_field(body: bytes):
    result = probe_top_level_string_field(body)

    assert result.status == "incomplete"
    assert result.value is None
    assert not result.field_seen


def test_probe_ignores_nested_fields_with_same_name():
    result = probe_top_level_string_field(
        b'{"metadata":{"type":"nested","items":[{"type":"also_nested"}]},"type":"top_level"}'
    )

    assert result.status == "found"
    assert result.value == "top_level"
    assert result.field_seen


def test_probe_ignores_field_name_inside_string_payload():
    result = probe_top_level_string_field(
        b'{"text":"payload mentions \\"type\\":\\"response.completed\\"",'
        b'"type":"response.output_text.delta"}'
    )

    assert result.status == "found"
    assert result.value == "response.output_text.delta"
    assert result.field_seen


def test_probe_uses_first_duplicate_top_level_field():
    result = probe_top_level_string_field(
        b'{"type":"response.output_text.delta","type":"response.completed"}'
    )

    assert result.status == "found"
    assert result.value == "response.output_text.delta"
    assert result.field_seen


def test_probe_reports_incomplete_prefix_before_field_value_completes():
    result = probe_top_level_string_field(b'{"type":"response.comp')

    assert result.status == "incomplete"
    assert result.value is None
    assert result.field_seen


def test_probe_reports_incomplete_after_target_member_boundary():
    result = probe_top_level_string_field(b'{"type":')

    assert result.status == "incomplete"
    assert result.value is None
    assert result.field_seen


def test_probe_reports_incomplete_before_target_member_boundary():
    result = probe_top_level_string_field(b'{"padding":')

    assert result.status == "incomplete"
    assert result.value is None
    assert not result.field_seen


def test_probe_reports_invalid_after_target_member_boundary():
    result = probe_top_level_string_field(b'{"type":?}')

    assert result.status == "invalid"
    assert result.value is None
    assert result.field_seen


def test_probe_reports_not_found_when_complete_object_has_no_field():
    result = probe_top_level_string_field(b'{"metadata":{"type":"nested"}}')

    assert result.status == "not_found"
    assert result.value is None
    assert not result.field_seen


def test_probe_reports_non_string_field_value():
    result = probe_top_level_string_field(b'{"type":123}')

    assert result.status == "non_string"
    assert result.value is None
    assert result.field_seen


def test_probe_reports_non_string_once_target_value_token_starts():
    result = probe_top_level_string_field(b'{"type":t')

    assert result.status == "non_string"
    assert result.value is None
    assert result.field_seen


def test_probe_reports_invalid_json_prefix():
    result = probe_top_level_string_field(b'{"type" "response.completed"}')

    assert result.status == "invalid"
    assert result.value is None
    assert not result.field_seen


def test_probe_reports_invalid_utf8_in_skipped_string():
    result = probe_top_level_string_field(b'{"padding":"\x80","type":"response.completed"}')

    assert result.status == "invalid"
    assert result.value is None
    assert not result.field_seen


def test_probe_reports_bound_exceeded_for_oversized_value():
    result = probe_top_level_string_field(b'{"type":"abcdef"}', max_string_bytes=4)

    assert result.status == "bound_exceeded"
    assert result.value is None
    assert result.field_seen


def test_probe_reports_bound_exceeded_for_oversized_skipped_value():
    result = probe_top_level_string_field(
        b'{"padding":"' + b"x" * 12 + b'","type":"response.completed"}',
        max_string_bytes=8,
    )

    assert result.status == "bound_exceeded"
    assert result.value is None
    assert not result.field_seen


def test_probe_reports_bound_exceeded_for_depth_limit():
    result = probe_top_level_string_field(
        b'{"metadata":{"nested":true},"type":"response.completed"}',
        max_depth=1,
    )

    assert result.status == "bound_exceeded"
    assert result.value is None
    assert not result.field_seen


def test_probe_supports_custom_field_name():
    result = probe_top_level_string_field(b'{"kind":"target","type":"ignored"}', "kind")

    assert result.status == "found"
    assert result.value == "target"
    assert result.field_seen
