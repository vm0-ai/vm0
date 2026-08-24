"""Shared bounded failure evidence for model-provider HTTP body inspection."""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Protocol

from .json_selective import (
    FIRST_ARRAY_ELEMENT,
    JsonExtractionResult,
    ScalarField,
)
from .json_selective import Path as JsonPath

_MAX_FAILURE_STRING_BYTES = 128

FAILURE_SCALAR_FIELDS: Mapping[JsonPath, ScalarField] = {
    ("type",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("code",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("status",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error_type",): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "code"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("error", "metadata", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "id"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "status"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error", "type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error", "code"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("response", "error", "error_type"): ScalarField("string", max_bytes=_MAX_FAILURE_STRING_BYTES),
    ("choices", FIRST_ARRAY_ELEMENT, "error", "metadata", "error_type"): ScalarField(
        "string", max_bytes=_MAX_FAILURE_STRING_BYTES
    ),
}

FAILURE_VALUE_PRESENCE_PATHS = (
    ("error",),
    ("response", "error"),
    ("choices", FIRST_ARRAY_ELEMENT, "error"),
    ("choices",),
)

_FAILURE_CODE_PATHS = (
    ("error", "metadata", "error_type"),
    ("choices", FIRST_ARRAY_ELEMENT, "error", "metadata", "error_type"),
    ("error", "error_type"),
    ("response", "error_type"),
    ("response", "error", "error_type"),
    ("error_type",),
    ("response", "error", "code"),
    ("error", "code"),
    ("response", "error", "type"),
    ("error", "type"),
)


@dataclass(frozen=True)
class ModelHttpFailureEvidence:
    """Immutable failure-classification evidence from one JSON document or SSE event."""

    event_name: str | None = None
    payload_type: str | None = None
    status: str | None = None
    response_status: str | None = None
    response_id: str | None = None
    failure_codes: tuple[str, ...] = ()
    has_error: bool = False
    has_choices: bool = False
    is_done: bool = False
    is_valid: bool = False


class ModelHttpFailureObserver(Protocol):
    """Parser-free consumer of shared model HTTP failure evidence."""

    def needs_sse_event(self, event_name: str | None) -> bool:
        raise NotImplementedError

    def observe(self, evidence: ModelHttpFailureEvidence) -> None:
        raise NotImplementedError

    def observe_json(self, evidence: ModelHttpFailureEvidence) -> None:
        raise NotImplementedError

    def finish(self) -> object:
        raise NotImplementedError


def combined_scalar_fields(
    usage_fields: Mapping[JsonPath, ScalarField],
    *,
    include_usage: bool,
    include_failure: bool,
) -> dict[JsonPath, ScalarField]:
    """Return the exact selected-field union for the active consumers."""

    fields = dict(usage_fields) if include_usage else {}
    if include_failure:
        for path, field in FAILURE_SCALAR_FIELDS.items():
            if path not in fields:
                fields[path] = replace(field, overflow_policy="discard") if include_usage else field
    return fields


def combined_value_presence_paths(
    usage_paths: tuple[JsonPath, ...],
    *,
    include_usage: bool,
    include_failure: bool,
) -> set[JsonPath]:
    paths = set(usage_paths) if include_usage else set()
    if include_failure:
        paths.update(FAILURE_VALUE_PRESENCE_PATHS)
    return paths


def failure_evidence_from_result(
    result: JsonExtractionResult,
    *,
    event_name: str | None = None,
    is_done: bool = False,
) -> ModelHttpFailureEvidence:
    """Project one shared extraction result into the strict failure evidence contract."""

    if not result.complete or _failure_fields_overflowed(result):
        return ModelHttpFailureEvidence(event_name=event_name, is_done=is_done)

    payload_type = _string_value(result, ("type",))
    failure_codes = tuple(
        value for path in _FAILURE_CODE_PATHS if (value := _string_value(result, path)) is not None
    )
    top_level_code = _string_value(result, ("code",))
    if payload_type == "error" and top_level_code is not None:
        failure_codes = (*failure_codes, top_level_code)
    return ModelHttpFailureEvidence(
        event_name=event_name,
        payload_type=payload_type,
        status=_string_value(result, ("status",)),
        response_status=_string_value(result, ("response", "status")),
        response_id=_string_value(result, ("response", "id")),
        failure_codes=failure_codes,
        has_error=any(
            path in result.value_present
            for path in (
                ("error",),
                ("response", "error"),
                ("choices", FIRST_ARRAY_ELEMENT, "error"),
            )
        ),
        has_choices=("choices",) in result.value_present,
        is_done=is_done,
        is_valid=True,
    )


def _failure_fields_overflowed(result: JsonExtractionResult) -> bool:
    if result.discarded_scalar_paths.intersection(FAILURE_SCALAR_FIELDS):
        return True
    return any(
        raw_bytes > _MAX_FAILURE_STRING_BYTES
        for path, raw_bytes in result.selected_string_max_raw_bytes.items()
        if path in FAILURE_SCALAR_FIELDS
    )


def _string_value(result: JsonExtractionResult, path: JsonPath) -> str | None:
    value = result.values.get(path)
    return value if isinstance(value, str) else None
