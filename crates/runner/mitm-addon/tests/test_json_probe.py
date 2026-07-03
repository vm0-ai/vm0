"""Tests for bounded JSON prefix probing helpers."""

from usage.json_probe import probe_top_level_string_field


def test_probe_finds_top_level_string_field_without_scanning_rest():
    result = probe_top_level_string_field(
        b'{"type":"response.completed","payload":' + b"x" * 100_000
    )

    assert result.status == "found"
    assert result.value == "response.completed"


def test_probe_ignores_nested_fields_with_same_name():
    result = probe_top_level_string_field(
        b'{"metadata":{"type":"nested","items":[{"type":"also_nested"}]},"type":"top_level"}'
    )

    assert result.status == "found"
    assert result.value == "top_level"


def test_probe_ignores_field_name_inside_string_payload():
    result = probe_top_level_string_field(
        b'{"text":"payload mentions \\"type\\":\\"response.completed\\"",'
        b'"type":"response.output_text.delta"}'
    )

    assert result.status == "found"
    assert result.value == "response.output_text.delta"


def test_probe_uses_first_duplicate_top_level_field():
    result = probe_top_level_string_field(
        b'{"type":"response.output_text.delta","type":"response.completed"}'
    )

    assert result.status == "found"
    assert result.value == "response.output_text.delta"


def test_probe_reports_incomplete_prefix_before_field_value_completes():
    result = probe_top_level_string_field(b'{"type":"response.comp')

    assert result.status == "incomplete"
    assert result.value is None


def test_probe_reports_not_found_when_complete_object_has_no_field():
    result = probe_top_level_string_field(b'{"metadata":{"type":"nested"}}')

    assert result.status == "not_found"
    assert result.value is None


def test_probe_reports_non_string_field_value():
    result = probe_top_level_string_field(b'{"type":123}')

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


def test_probe_supports_custom_field_name():
    result = probe_top_level_string_field(b'{"kind":"target","type":"ignored"}', "kind")

    assert result.status == "found"
    assert result.value == "target"
