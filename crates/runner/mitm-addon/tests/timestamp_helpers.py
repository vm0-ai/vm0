"""Shared timestamp assertions for mitm-addon logging tests."""

import re
from datetime import datetime, timezone

_UTC_MILLISECOND_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def assert_utc_millisecond_timestamp(value: object) -> None:
    assert isinstance(value, str)
    assert _UTC_MILLISECOND_TIMESTAMP_RE.fullmatch(value)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert parsed.utcoffset() == timezone.utc.utcoffset(None)
