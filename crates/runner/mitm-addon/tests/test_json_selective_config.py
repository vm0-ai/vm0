"""Configuration contracts for bounded selective JSON extraction."""

import json

import pytest

from usage.json_selective import JsonSelectiveExtractor, ScalarField


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


def test_rejects_invalid_scalar_field_overflow_policy():
    with pytest.raises(ValueError, match="overflow_policy"):
        ScalarField("string", overflow_policy=json.loads('"ignore"'))


def test_rejects_discard_overflow_policy_for_integer_field():
    with pytest.raises(ValueError, match="requires a string field"):
        ScalarField("int", overflow_policy="discard")


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
        ("max_work_units", 0),
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
        ("max_work_units", True),
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
    result = extractor.finish()

    assert result.complete is True
    assert result.values == {}
    assert result.array_counts == {}
    assert result.wildcard_array_counts == {("includes", "*"): {"users": 0}}
    assert result.object_present == set()


def test_rejects_wildcard_pattern_without_exactly_one_wildcard():
    with pytest.raises(ValueError, match="exactly one"):
        JsonSelectiveExtractor(wildcard_array_count_paths={("includes",)})

    with pytest.raises(ValueError, match="exactly one"):
        JsonSelectiveExtractor(wildcard_array_count_paths={("*", "*")})
