"""Shared helpers for requestheaders() hook tests."""

import inspect
from collections.abc import Awaitable
from typing import cast


async def await_requestheaders_result(result: object) -> None:
    """Await the async requestheaders() path, failing if the hook stayed sync."""
    if not inspect.isawaitable(result):
        raise AssertionError("expected requestheaders() to return an awaitable")
    return await cast(Awaitable[None], result)
