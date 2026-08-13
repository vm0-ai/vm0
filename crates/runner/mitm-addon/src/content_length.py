"""Bounded parsing for HTTP Content-Length field values."""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

ContentLengthKind = Literal["missing", "valid", "invalid", "conflicting", "over_limit"]


@dataclass(frozen=True, slots=True)
class ContentLengthResult:
    """Result of bounded Content-Length field parsing.

    In this contract, ``max_value`` is the limit supplied to ``parse()``.
    ``kind`` describes the parser outcome:

    - ``missing``: no field values were supplied.
    - ``valid``: every part is valid, agrees after normalization, and does not exceed
      ``max_value``.
    - ``invalid``: parsing encountered an empty part or a part that is not an ASCII decimal
      after surrounding HTTP optional whitespace was trimmed.
    - ``conflicting``: parsing encountered a normalized decimal value that differs from the
      first value.
    - ``over_limit``: valid parts agree on a value greater than ``max_value``.

    Parsing stops at the first ``invalid`` or ``conflicting`` part. Numeric limit
    classification occurs only after every part has been scanned and agrees.

    ``value`` is the exact normalized integer for ``valid``. It remains the default zero for
    ``missing``, ``invalid``, and ``conflicting``. For ``over_limit``, it is exact when the
    normalized numeral's significant digit count does not exceed that of ``max_value``;
    otherwise, it is the bounded ``max_value + 1`` sentinel rather than a guaranteed exact
    declared value. Always interpret ``value`` through ``kind`` because a valid zero also has
    value zero.
    """

    kind: ContentLengthKind
    value: int = 0


def parse(values: Iterable[str], *, max_value: int) -> ContentLengthResult:
    """Parse repeated Content-Length fields with a bounded integer result.

    The parser scans comma-separated parts across repeated fields after trimming only surrounding
    HTTP optional whitespace (space and horizontal tab). Parts must be nonempty ASCII decimals.
    Leading zeroes are ignored when comparing parts, and all normalized values must agree.

    Integer conversion is limited to normalized values whose significant digit count does not
    exceed that of ``max_value``; longer agreed values use the bounded ``over_limit`` sentinel
    described by ``ContentLengthResult``.
    """
    first_value: str | None = None
    first_start = 0
    first_end = 0
    parsed_value = 0
    over_limit = False
    limit_digits = len(str(max_value))

    for field_value in values:
        part_start = 0
        while True:
            comma = field_value.find(",", part_start)
            part_end = len(field_value) if comma == -1 else comma

            while part_start < part_end and field_value[part_start] in (" ", "\t"):
                part_start += 1
            while part_end > part_start and field_value[part_end - 1] in (" ", "\t"):
                part_end -= 1
            if part_start == part_end:
                return ContentLengthResult("invalid")

            significant_start = part_start
            while significant_start < part_end and field_value[significant_start] == "0":
                significant_start += 1
            if significant_start == part_end:
                significant_start -= 1

            for index in range(significant_start, part_end):
                character = field_value[index]
                if character < "0" or character > "9":
                    return ContentLengthResult("invalid")

            if first_value is None:
                first_value = field_value
                first_start = significant_start
                first_end = part_end
                significant_digits = part_end - significant_start
                if significant_digits > limit_digits:
                    parsed_value = max_value + 1
                    over_limit = True
                else:
                    parsed_value = int(field_value[significant_start:part_end])
                    over_limit = parsed_value > max_value
            else:
                significant_digits = part_end - significant_start
                if significant_digits != first_end - first_start or any(
                    first_value[first_start + offset] != field_value[significant_start + offset]
                    for offset in range(significant_digits)
                ):
                    return ContentLengthResult("conflicting")

            if comma == -1:
                break
            part_start = comma + 1

    if first_value is None:
        return ContentLengthResult("missing")
    if over_limit:
        return ContentLengthResult("over_limit", parsed_value)
    return ContentLengthResult("valid", parsed_value)
