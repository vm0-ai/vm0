"""Shared rejected body-framing cases for buffered auth request integration tests."""

from dataclasses import dataclass
from typing import Literal

BufferedAuthBodyFramingRejectionKind = Literal["length_required", "too_large"]


@dataclass(frozen=True, slots=True)
class BufferedAuthBodyFramingRejectionCase:
    id: str
    header_pairs: tuple[tuple[str, str], ...]
    kind: BufferedAuthBodyFramingRejectionKind


def buffered_auth_body_framing_rejection_cases(
    *,
    max_body_bytes: int,
) -> tuple[BufferedAuthBodyFramingRejectionCase, ...]:
    return (
        BufferedAuthBodyFramingRejectionCase(
            id="transfer-encoding",
            header_pairs=(("Transfer-Encoding", "chunked"),),
            kind="length_required",
        ),
        BufferedAuthBodyFramingRejectionCase(
            id="invalid-nondigit",
            header_pairs=(("Content-Length", "not-a-number"),),
            kind="length_required",
        ),
        BufferedAuthBodyFramingRejectionCase(
            id="invalid-negative",
            header_pairs=(("Content-Length", "-1"),),
            kind="length_required",
        ),
        BufferedAuthBodyFramingRejectionCase(
            id="conflicting",
            header_pairs=(("Content-Length", "4"), ("Content-Length", "5")),
            kind="length_required",
        ),
        BufferedAuthBodyFramingRejectionCase(
            id="over-limit",
            header_pairs=(("Content-Length", str(max_body_bytes + 1)),),
            kind="too_large",
        ),
    )


def buffered_auth_body_framing_case_id(
    framing_case: BufferedAuthBodyFramingRejectionCase,
) -> str:
    return framing_case.id
