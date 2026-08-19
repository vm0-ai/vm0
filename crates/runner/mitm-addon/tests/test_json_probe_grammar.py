"""Differential grammar tests for bounded JSON field probing."""

import json

import pytest

from usage.json_probe import (
    TopLevelStringFieldProbeResult,
    probe_top_level_string_field,
)


class _ObjectPairs(list[tuple[str, object]]):
    pass


_VALID_DOCUMENTS: dict[str, bytes] = {
    "empty-object": b"{}",
    "field-first": b'{"type":"response.completed","padding":[]}',
    "field-late-all-kinds": (
        b'{"string":"text","integer":0,"number":-2.5e+3,'
        b'"true":true,"false":false,"null":null,'
        b'"array":[1,{"nested":[]}],"object":{"type":"nested"},'
        b'"type":"response.output_text.delta"}'
    ),
    "nested-only": b'{"metadata":{"type":"nested"},"items":[{"type":"also_nested"}]}',
    "whitespace-and-escapes": (
        b'{\n  "ty\\u0070e" : "response.\\u0063ompleted",\n  "padding" : null\n}'
    ),
    "duplicate-string": b'{"type":"first","type":"second"}',
    "duplicate-non-string": b'{"type":null,"type":"second"}',
    "non-string-array": b'{"type":[]}',
}


def _expected_probe_result(
    body: bytes,
    field_name: str = "type",
) -> TopLevelStringFieldProbeResult:
    decoded: object = json.loads(body, object_pairs_hook=_ObjectPairs)
    assert isinstance(decoded, _ObjectPairs)

    for key, value in decoded:
        if key != field_name:
            continue
        if isinstance(value, str):
            return TopLevelStringFieldProbeResult("found", value, field_seen=True)
        return TopLevelStringFieldProbeResult("non_string", field_seen=True)

    return TopLevelStringFieldProbeResult("not_found")


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(b'"text"', id="string"),
        pytest.param(b"-12", id="integer"),
        pytest.param(b"-2.5e+3", id="fractional-exponent-number"),
        pytest.param(b"true", id="true"),
        pytest.param(b"false", id="false"),
        pytest.param(b"null", id="null"),
        pytest.param(b"[]", id="empty-array"),
        pytest.param(b'[0,"x",true,null,{},[]]', id="non-empty-array"),
        pytest.param(b"{}", id="empty-object"),
        pytest.param(b'{"nested":[false,{"deep":null}]}', id="non-empty-object"),
    ],
)
def test_probe_skips_every_json_value_kind_before_selected_field(value: bytes):
    body = b'{"padding":' + value + b',"type":"response.completed"}'

    result = probe_top_level_string_field(body)

    assert result == TopLevelStringFieldProbeResult(
        "found",
        "response.completed",
        field_seen=True,
    )


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        pytest.param(
            b'{"type":"ok"}',
            TopLevelStringFieldProbeResult("found", "ok", field_seen=True),
            id="found",
        ),
        pytest.param(
            b'{"padding":[]}',
            TopLevelStringFieldProbeResult("not_found"),
            id="not-found",
        ),
        pytest.param(
            b'{"padding":[]',
            TopLevelStringFieldProbeResult("incomplete"),
            id="truncated-after-value",
        ),
        pytest.param(
            b'{"padding":[],',
            TopLevelStringFieldProbeResult("incomplete"),
            id="truncated-after-comma",
        ),
        pytest.param(
            b'{"padding" []}',
            TopLevelStringFieldProbeResult("invalid"),
            id="missing-colon",
        ),
        pytest.param(
            b'{"padding":[] "type":"ok"}',
            TopLevelStringFieldProbeResult("invalid"),
            id="missing-comma",
        ),
        pytest.param(
            b'{"padding":[],}',
            TopLevelStringFieldProbeResult("invalid"),
            id="trailing-comma",
        ),
        pytest.param(
            b'{"type":[]}',
            TopLevelStringFieldProbeResult("non_string", field_seen=True),
            id="non-string",
        ),
    ],
)
def test_probe_reports_complete_result_at_separator_and_truncation_boundaries(
    body: bytes,
    expected: TopLevelStringFieldProbeResult,
):
    assert probe_top_level_string_field(body) == expected


def test_probe_reports_complete_result_when_configured_bounds_are_exceeded():
    assert probe_top_level_string_field(
        b'{"padding":"longer","type":"ok"}',
        max_string_bytes=4,
    ) == TopLevelStringFieldProbeResult("bound_exceeded")
    assert probe_top_level_string_field(
        b'{"type":"longer"}',
        max_string_bytes=4,
    ) == TopLevelStringFieldProbeResult("bound_exceeded", field_seen=True)
    assert probe_top_level_string_field(
        b'{"padding":{},"type":"ok"}',
        max_depth=1,
    ) == TopLevelStringFieldProbeResult("bound_exceeded")


@pytest.mark.parametrize(
    "body",
    _VALID_DOCUMENTS.values(),
    ids=_VALID_DOCUMENTS.keys(),
)
def test_probe_matches_json_oracle_for_complete_valid_objects(body: bytes):
    assert probe_top_level_string_field(body) == _expected_probe_result(body)


@pytest.mark.parametrize(
    "body",
    _VALID_DOCUMENTS.values(),
    ids=_VALID_DOCUMENTS.keys(),
)
def test_probe_valid_document_prefixes_are_incomplete_or_correctly_terminal(body: bytes):
    expected = _expected_probe_result(body)

    for end in range(len(body) + 1):
        prefix = body[:end]
        result = probe_top_level_string_field(prefix)

        if result.status == "incomplete":
            assert result.value is None
        else:
            assert result == expected, f"unexpected result at byte {end}: {prefix!r}"
