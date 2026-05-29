"""Connector response parser result types."""

from collections.abc import Callable
from typing import NamedTuple


class ConnectorResponseParser(NamedTuple):
    """Incremental parser hooks for connector response bodies."""

    feed: Callable[[bytes], None]
    finish: Callable[[], None] | None = None
