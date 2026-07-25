"""Shared event-loop callback scheduling for mitm addon hooks."""

import asyncio
from collections.abc import Callable


def call_soon[CallbackArg](callback: Callable[[CallbackArg], None], arg: CallbackArg) -> None:
    asyncio.get_running_loop().call_soon(callback, arg)
