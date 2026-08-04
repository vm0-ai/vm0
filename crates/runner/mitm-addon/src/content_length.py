"""Bounded parsing for HTTP Content-Length field values."""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal

ContentLengthKind = Literal["missing", "valid", "invalid", "conflicting", "over_limit"]


@dataclass(frozen=True, slots=True)
class ContentLengthResult:
    kind: ContentLengthKind
    value: int = 0


def parse(values: Iterable[str], *, max_value: int) -> ContentLengthResult:
    """Parse repeated Content-Length fields without converting unbounded integers."""
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
