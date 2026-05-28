"""Tests for bounded selective JSON extraction."""

import json

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


def _finish(extractor: JsonSelectiveExtractor):
    return extractor.finish()


_COMMON_SCALAR_FIELDS = {
    ("id",): ScalarField("string"),
    ("model",): ScalarField("string"),
    ("usage", "input_tokens"): ScalarField("int"),
    ("usage", "output_tokens"): ScalarField("int"),
    ("meta", "result_count"): ScalarField("int"),
    ("meta", "total_tweet_count"): ScalarField("int"),
}
_COMMON_ARRAY_COUNT_PATHS = {("data",), ("errors",)}
_COMMON_WILDCARD_ARRAY_COUNT_PATHS = {("includes", "*")}
_COMMON_OBJECT_PRESENCE_PATHS = {(), ("data",)}


def _get_path(data: object, path: tuple[str, ...]) -> tuple[object, bool]:
    cur = data
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None, False
        cur = cur[key]
    return cur, True


def _expected_common_extraction(data: object):
    values = {}
    for path, field in _COMMON_SCALAR_FIELDS.items():
        value, found = _get_path(data, path)
        if not found:
            continue
        if (field.kind == "string" and isinstance(value, str)) or (
            field.kind == "int" and isinstance(value, int) and not isinstance(value, bool)
        ):
            values[path] = value

    array_counts = {}
    for path in _COMMON_ARRAY_COUNT_PATHS:
        value, found = _get_path(data, path)
        if found and isinstance(value, list):
            array_counts[path] = len(value)

    wildcard_array_counts = {}
    includes = data.get("includes") if isinstance(data, dict) else None
    if isinstance(includes, dict):
        counts = {
            key: len(value)
            for key, value in includes.items()
            if isinstance(key, str)
            and isinstance(value, list)
            and not key.startswith("\0__vm0_json_")
        }
        if counts:
            wildcard_array_counts[("includes", "*")] = counts

    object_present = set()
    if isinstance(data, dict):
        object_present.add(())
        if isinstance(data.get("data"), dict):
            object_present.add(("data",))

    return values, array_counts, wildcard_array_counts, object_present


def _common_extractor() -> JsonSelectiveExtractor:
    return JsonSelectiveExtractor(
        scalar_fields=_COMMON_SCALAR_FIELDS,
        array_count_paths=_COMMON_ARRAY_COUNT_PATHS,
        wildcard_array_count_paths=_COMMON_WILDCARD_ARRAY_COUNT_PATHS,
        object_presence_paths=_COMMON_OBJECT_PRESENCE_PATHS,
    )


def test_rejects_invalid_scalar_field_kind():
    with pytest.raises(ValueError, match="kind"):
        ScalarField(json.loads('"number"'))


@pytest.mark.parametrize("max_bytes", [0, -1])
def test_rejects_invalid_scalar_field_max_bytes(max_bytes):
    with pytest.raises(ValueError, match="max_bytes"):
        ScalarField("string", max_bytes=max_bytes)


def test_rejects_bool_scalar_field_max_bytes():
    with pytest.raises(TypeError, match="max_bytes"):
        ScalarField("string", max_bytes=True)


def test_rejects_invalid_scalar_field_config_value():
    with pytest.raises(TypeError, match="ScalarField"):
        JsonSelectiveExtractor(scalar_fields=json.loads('{"model": "string"}'))


@pytest.mark.parametrize(
    ("bound", "value"),
    [
        ("max_depth", 0),
        ("max_key_bytes", 0),
        ("max_number_bytes", 0),
        ("max_wildcard_keys", 0),
    ],
)
def test_rejects_invalid_extractor_bounds(bound, value):
    with pytest.raises(ValueError, match=bound):
        JsonSelectiveExtractor(**{bound: value})


@pytest.mark.parametrize(
    ("bound", "value"),
    [
        ("max_depth", True),
        ("max_key_bytes", "1024"),
        ("max_number_bytes", 128.0),
        ("max_wildcard_keys", None),
    ],
)
def test_rejects_non_integer_extractor_bounds(bound, value):
    with pytest.raises(TypeError, match=bound):
        JsonSelectiveExtractor(**{bound: value})


@pytest.mark.parametrize(
    "kwargs",
    [
        {"scalar_fields": {("data", "*"): ScalarField("string")}},
        {"array_count_paths": {("data", "*")}},
        {"object_presence_paths": {("data", "*")}},
    ],
)
def test_rejects_wildcards_in_exact_observation_paths(kwargs):
    with pytest.raises(ValueError, match="must not contain"):
        JsonSelectiveExtractor(**kwargs)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"scalar_fields": {"model": ScalarField("string")}},
        {"array_count_paths": {"data"}},
        {"wildcard_array_count_paths": {"includes"}},
        {"object_presence_paths": {"data"}},
    ],
)
def test_rejects_non_tuple_observation_paths(kwargs):
    with pytest.raises(TypeError, match=r"tuple\[str, \.\.\.\]"):
        JsonSelectiveExtractor(**kwargs)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"scalar_fields": {(1,): ScalarField("string")}},
        {"array_count_paths": {(1,)}},
        {"wildcard_array_count_paths": {("includes", 1)}},
        {"object_presence_paths": {(1,)}},
    ],
)
def test_rejects_non_string_path_segments(kwargs):
    with pytest.raises(TypeError, match=r"tuple\[str, \.\.\.\]"):
        JsonSelectiveExtractor(**kwargs)


def test_constructor_copies_observation_config():
    scalar_fields = {}
    array_count_paths = set()
    wildcard_array_count_paths = {("includes", "*")}
    object_presence_paths = set()

    extractor = JsonSelectiveExtractor(
        scalar_fields=scalar_fields,
        array_count_paths=array_count_paths,
        wildcard_array_count_paths=wildcard_array_count_paths,
        object_presence_paths=object_presence_paths,
    )
    scalar_fields[("model",)] = ScalarField("string")
    array_count_paths.add(("data",))
    wildcard_array_count_paths.add(("extras", "*"))
    object_presence_paths.add(("data",))

    extractor.feed(b'{"model":"claude","data":[],"includes":{"users":[]},"extras":{"items":[]}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 0}}
    assert result.object_present == set()


def test_diagnostic_scalar_can_observe_completed_value_in_incomplete_json():
    extractor = JsonSelectiveExtractor(scalar_fields={("type",): ScalarField("string")})

    extractor.feed(b'{"type":"message_start","message":{"id":"msg_1","mod')
    result = _finish(extractor)

    assert result.complete is False
    assert result.values == {}
    assert extractor.observed_scalar_for_diagnostics(("type",)) == "message_start"


def test_diagnostic_scalar_does_not_return_stale_duplicate_value():
    extractor = JsonSelectiveExtractor(scalar_fields={("type",): ScalarField("string")})

    extractor.feed(b'{"type":"message_start","type":"message_delta')
    result = _finish(extractor)

    assert result.complete is False
    assert result.values == {}
    assert extractor.observed_scalar_for_diagnostics(("type",)) is None


def test_common_extraction_matches_json_loads_across_chunk_sizes():
    payloads = [
        (
            b'{"id":"msg_1","model":"claude\\n\\u2603",'
            b'"content":[{"text":"ignored"}],'
            b'"usage":{"input_tokens":10,"output_tokens":5},'
            b'"data":[{"id":"1"},{"id":"2"}],"errors":[{"title":"bad"}],'
            b'"includes":{"users":[{"id":"u1"},{"id":"u2"}],"tweets":[{"id":"t1"}]},'
            b'"meta":{"result_count":3}}'
        ),
        (
            b'{"id":"msg_2","data":{"id":"1"},'
            b'"usage":{"input_tokens":0,"output_tokens":7},'
            b'"meta":{"total_tweet_count":9}}'
        ),
    ]

    for payload in payloads:
        expected = _expected_common_extraction(json.loads(payload))
        for chunk_size in (1, 2, 3, 5, 8, 13):
            extractor = _common_extractor()
            for idx in range(0, len(payload), chunk_size):
                extractor.feed(payload[idx : idx + chunk_size])
            result = _finish(extractor)

            assert result.complete is True
            assert (
                result.values,
                result.array_counts,
                result.wildcard_array_counts,
                result.object_present,
            ) == expected


def test_extracts_selected_scalars_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("model",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"mo')
    extractor.feed(b'del":"claude","usage":{"input_')
    extractor.feed(b'tokens":42}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {
        ("model",): "claude",
        ("usage", "input_tokens"): 42,
    }


def test_decodes_selected_escaped_strings():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude\\n\\u2603"}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values[("model",)] == "claude\n\u2603"


def test_decodes_selected_escaped_strings_across_chunks():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude\\')
    extractor.feed(b"n\\u")
    extractor.feed(b'2603"}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values[("model",)] == "claude\n\u2603"


def test_decodes_selected_surrogate_pair_escape():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude\\ud83d\\ude00"}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("model",): "claude\U0001f600"}


def test_ignores_selected_lone_surrogate_escape():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("id",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"id":"\\ud800","usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_decodes_escaped_object_keys_for_path_matching():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"us\\u0061ge":{"input_tokens":5}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 5}


def test_decodes_escaped_object_keys_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"us\\u')
    extractor.feed(b'0061ge":{"input_tokens":5}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 5}


def test_lone_surrogate_key_does_not_abort_later_selected_fields():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"\\ud800":{"input_tokens":99},"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_skips_large_unselected_string_without_storing_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )
    large_text = b"x" * (512 * 1024)

    extractor.feed(b'{"content":[{"text":"')
    extractor.feed(large_text)
    extractor.feed(b'"}],"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_accepts_multibyte_unselected_string_across_chunks():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":"\xe2')
    extractor.feed(b'\x98\x83","usage":{"input_tokens":9}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 9}


def test_rejects_invalid_utf8_in_unselected_string():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":"\xff","usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "invalid string"
    assert result.values == {}


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        (b'{"content":"\xe2\x98"}', "invalid string"),
        (b'{"content":"\xed\xa0\x80"}', "invalid string"),
        (b'{"content":"abc\x01"}', "control character in string"),
        (b'{"content":"\\x"}', "invalid string escape"),
        (b'{"content":"\\u12xz"}', "invalid unicode escape"),
    ],
)
def test_rejects_invalid_string_forms(payload, error):
    extractor = JsonSelectiveExtractor()

    extractor.feed(payload)
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == error
    assert result.values == {}


def test_accepts_selected_string_at_exact_limit():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=3)}
    )

    extractor.feed(b'{"model":"abc"}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("model",): "abc"}


def test_rejects_oversized_selected_string():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=3)}
    )

    extractor.feed(b'{"model":"abcd"}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "string limit exceeded"
    assert result.values == {}


def test_selected_string_limit_stops_collecting_current_chunk():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("model",): ScalarField("string", max_bytes=3)}
    )

    extractor.feed(b'{"model":"' + b"x" * (64 * 1024))
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "string limit exceeded"
    assert result.values == {}


def test_skips_oversized_unmatched_object_key():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_key_bytes=32,
    )

    extractor.feed(b'{"long_unmatched_key":{"input_tokens":99},"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_skips_long_uninteresting_key_inside_unselected_subtree():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_key_bytes=32,
    )

    extractor.feed(b'{"content":[{"input":{"')
    extractor.feed(b"a" * 4096)
    extractor.feed(b'":1}}],"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_wildcard_count_skips_oversized_key_and_keeps_later_keys():
    extractor = JsonSelectiveExtractor(
        wildcard_array_count_paths={("includes", "*")},
        max_key_bytes=32,
    )

    extractor.feed(b'{"includes":{"')
    extractor.feed(b"a" * 4096)
    extractor.feed(b'":[{"id":"ignored"}],"users":[{"id":"u1"},{"id":"u2"}]}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 2}}


def test_wildcard_count_skips_internal_marker_key():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(
        b'{"includes":{"\\u0000__vm0_json_array_element__":[{"id":"internal"}],'
        b'"users":[{"id":"u1"}]}}'
    )
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 1}}


def test_wildcard_count_skips_unknown_internal_marker_key():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(
        b'{"includes":{"\\u0000__vm0_json_unknown_key__":[{"id":"internal"}],'
        b'"users":[{"id":"u1"}]}}'
    )
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 1}}


def test_rejects_oversized_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"usage":{"input_tokens":1234}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "number limit exceeded"


def test_rejects_oversized_number_with_field_limit():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int", max_bytes=3)},
        max_number_bytes=128,
    )

    extractor.feed(b'{"usage":{"input_tokens":1234}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "number limit exceeded"


def test_skips_oversized_unselected_number_without_storing_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")},
        max_number_bytes=3,
    )

    extractor.feed(b'{"content":{"score":1234567890},"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_rejects_invalid_unselected_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"content":{"score":01},"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "invalid number"


def test_extracts_root_number_at_eof():
    extractor = JsonSelectiveExtractor(scalar_fields={(): ScalarField("int")})

    extractor.feed(b"42")
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {(): 42}


def test_finishes_selected_number_when_delimiter_arrives_next_chunk():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42')
    extractor.feed(b"}}")
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 42}


def test_selected_float_is_valid_json_but_not_an_int_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":1.5}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {}


def test_rejects_invalid_json_number():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":01}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "invalid number"


def test_incomplete_json_discards_seen_values():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.values == {}


def test_incomplete_json_after_number_reports_error():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":42')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "incomplete json"
    assert result.values == {}


def test_incomplete_literal_reports_error():
    extractor = JsonSelectiveExtractor()

    extractor.feed(b'{"ok":tru')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "incomplete literal"


def test_split_literals_continue_to_later_selected_fields():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"ok":tr')
    extractor.feed(b'ue,"missing":nul')
    extractor.feed(b'l,"off":fal')
    extractor.feed(b'se,"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_counts_arrays_and_wildcard_child_arrays():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",), ("errors",)},
        wildcard_array_count_paths={("includes", "*")},
    )

    extractor.feed(
        b'{"data":[{"id":"1"},{"id":"2"}],'
        b'"errors":[{"title":"bad"}],'
        b'"includes":{"users":[{"id":"u1"}],"tweets":[{"id":"t1"},{"id":"t2"}]}}'
    )
    result = _finish(extractor)

    assert result.complete is True
    assert result.array_counts == {("data",): 2, ("errors",): 1}
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 1, "tweets": 2}}


def test_counts_all_matching_wildcard_patterns():
    extractor = JsonSelectiveExtractor(
        wildcard_array_count_paths={("a", "*"), ("*", "b")},
    )

    extractor.feed(b'{"a":{"b":[{"id":"1"},{"id":"2"}]}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {
        ("a", "*"): {"b": 2},
        ("*", "b"): {"a": 2},
    }


def test_wildcard_pattern_collects_keys_after_wildcard_segment():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("*", "items")})

    extractor.feed(b'{"a":{"items":[1,2]},"b":{"items":[3]}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {("*", "items"): {"a": 2, "b": 1}}


def test_leading_wildcard_does_not_match_array_element_marker():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("*", "items")})

    extractor.feed(b'[{"items":[1,2]}]')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {}


def test_rejects_wildcard_pattern_without_exactly_one_wildcard():
    with pytest.raises(ValueError, match="exactly one"):
        JsonSelectiveExtractor(wildcard_array_count_paths={("includes",)})

    with pytest.raises(ValueError, match="exactly one"):
        JsonSelectiveExtractor(wildcard_array_count_paths={("*", "*")})


def test_counts_empty_arrays_as_zero():
    extractor = JsonSelectiveExtractor(array_count_paths={("data",), ("errors",)})

    extractor.feed(b'{"data":[],"errors":[]}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.array_counts == {("data",): 0, ("errors",): 0}


def test_array_element_object_does_not_record_parent_object_presence():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",)},
        object_presence_paths={(), ("data",)},
    )

    extractor.feed(b'{"data":[{"id":"1"}]}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.array_counts == {("data",): 1}
    assert result.object_present == {()}


def test_array_element_object_fields_do_not_match_object_paths():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("model",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        },
        wildcard_array_count_paths={("includes", "*")},
    )

    extractor.feed(
        b'[{"model":"claude","usage":{"input_tokens":7},"includes":{"users":[{"id":"u1"}]}}]'
    )
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {}
    assert result.wildcard_array_counts == {}


def test_array_value_fields_do_not_match_object_paths():
    extractor = JsonSelectiveExtractor(
        scalar_fields={
            ("model",): ScalarField("string"),
            ("usage", "input_tokens"): ScalarField("int"),
        }
    )

    extractor.feed(b'{"model":"claude","usage":[{"input_tokens":7}]}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("model",): "claude"}


def test_root_array_object_does_not_record_root_object_presence():
    extractor = JsonSelectiveExtractor(object_presence_paths={()})

    extractor.feed(b'[{"id":"1"}]')
    result = _finish(extractor)

    assert result.complete is True
    assert result.object_present == set()


def test_duplicate_scalar_parent_uses_last_value():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )

    extractor.feed(b'{"usage":{"input_tokens":7},"usage":{}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {}


def test_duplicate_array_path_uses_last_value_kind():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",)},
        object_presence_paths={("data",)},
    )

    extractor.feed(b'{"data":[{"id":"1"},{"id":"2"}],"data":{"id":"3"}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.array_counts == {}
    assert result.object_present == {("data",)}


def test_duplicate_object_path_replaced_by_array_clears_presence():
    extractor = JsonSelectiveExtractor(
        array_count_paths={("data",)},
        object_presence_paths={("data",)},
    )

    extractor.feed(b'{"data":{"id":"1"},"data":[]}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.array_counts == {("data",): 0}
    assert result.object_present == set()


def test_duplicate_wildcard_parent_clears_previous_counts():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(b'{"includes":{"users":[{"id":"1"},{"id":"2"}]},"includes":{}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {}


def test_duplicate_wildcard_child_uses_last_array_count():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("includes", "*")})

    extractor.feed(b'{"includes":{"users":[{"id":"1"},{"id":"2"}],"users":[]}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 0}}


def test_duplicate_wildcard_prefix_keeps_unrelated_keys():
    extractor = JsonSelectiveExtractor(wildcard_array_count_paths={("*", "items")})

    extractor.feed(b'{"a":{"items":[1,2]},"b":{"items":[3]},"b":{}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.wildcard_array_counts == {("*", "items"): {"a": 2}}


def test_records_object_presence():
    extractor = JsonSelectiveExtractor(object_presence_paths={("data",)})

    extractor.feed(b'{"data":{"id":"1"}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.object_present == {("data",)}


def test_rejects_excessive_depth():
    extractor = JsonSelectiveExtractor(max_depth=2)

    extractor.feed(b'{"a":{"b":{"c":1}}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "max depth exceeded"


def test_default_depth_allows_deep_unselected_subtree():
    extractor = JsonSelectiveExtractor(
        scalar_fields={("usage", "input_tokens"): ScalarField("int")}
    )
    depth = 80

    extractor.feed(b'{"content":')
    extractor.feed(b'{"x":' * depth)
    extractor.feed(b"0")
    extractor.feed(b"}" * depth)
    extractor.feed(b',"usage":{"input_tokens":7}}')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("usage", "input_tokens"): 7}


def test_rejects_too_many_wildcard_keys():
    extractor = JsonSelectiveExtractor(
        wildcard_array_count_paths={("includes", "*")},
        max_wildcard_keys=1,
    )

    extractor.feed(b'{"includes":{"users":[],"tweets":[]}}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "max wildcard keys exceeded"


@pytest.mark.parametrize(
    ("payload", "error"),
    [
        (b'{"model" "claude"}', "expected colon"),
        (b'{"a":1 "b":2}', "expected object comma or end"),
        (b'{"data":[{}{}]}', "expected array comma or end"),
    ],
)
def test_rejects_missing_separators(payload, error):
    extractor = JsonSelectiveExtractor()

    extractor.feed(payload)
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == error


@pytest.mark.parametrize(
    "chunks",
    [
        [b"[1,]"],
        [b"[1,2,]"],
        [b'["x",]'],
        [b"[true,]"],
        [b"[false,]"],
        [b"[null,]"],
        [b"[{},]"],
        [b"[[],]"],
        [b"[1, ]"],
        [b"[1,", b"]"],
    ],
)
def test_rejects_trailing_commas_in_arrays(chunks):
    extractor = JsonSelectiveExtractor(array_count_paths={()})

    for chunk in chunks:
        extractor.feed(chunk)
    result = _finish(extractor)

    assert result.complete is False
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()


@pytest.mark.parametrize(
    "chunks",
    [
        [b'{"a":1,}'],
        [b'{"a":1,"b":2,}'],
        [b'{"s":"x",}'],
        [b'{"a":true,}'],
        [b'{"a":false,}'],
        [b'{"a":null,}'],
        [b'{"a":{},}'],
        [b'{"a":[],}'],
        [b'{"a":1, }'],
        [b'{"a":1,', b"}"],
    ],
)
def test_rejects_trailing_commas_in_objects(chunks):
    extractor = JsonSelectiveExtractor(
        scalar_fields={("a",): ScalarField("int"), ("s",): ScalarField("string")},
        array_count_paths={("a",)},
        object_presence_paths={("a",)},
    )

    for chunk in chunks:
        extractor.feed(chunk)
    result = _finish(extractor)

    assert result.complete is False
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {}
    assert result.object_present == set()


@pytest.mark.parametrize(
    "payload",
    [
        b"[]",
        b"{}",
        b"[1, 2]",
        b'["x", true, false, null, -1, {}, []]',
        b'{"a":1, "b":2}',
        b'{"a":{}, "b":[]}',
    ],
)
def test_accepts_valid_empty_containers_and_commas(payload):
    extractor = JsonSelectiveExtractor(scalar_fields={("a",): ScalarField("int")})

    extractor.feed(payload)
    result = _finish(extractor)

    assert result.complete is True


def test_rejects_trailing_data():
    extractor = JsonSelectiveExtractor()

    extractor.feed(b"{}{}")
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "trailing data after root value"


def test_allows_trailing_whitespace_after_root():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":"claude"} \n\t\r')
    result = _finish(extractor)

    assert result.complete is True
    assert result.values == {("model",): "claude"}


def test_feed_after_error_does_not_recover():
    extractor = JsonSelectiveExtractor(scalar_fields={("model",): ScalarField("string")})

    extractor.feed(b'{"model":@')
    extractor.feed(b'"claude"}')
    result = _finish(extractor)

    assert result.complete is False
    assert result.error == "expected json value"
    assert result.values == {}
