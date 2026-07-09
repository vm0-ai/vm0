"""Shared event-loop callback scheduling for mitm addon hooks."""

import asyncio
from collections.abc import Callable
from typing import TypeVar

_CallbackArg = TypeVar("_CallbackArg")


def call_soon(callback: Callable[[_CallbackArg], None], arg: _CallbackArg) -> None:
    asyncio.get_running_loop().call_soon(callback, arg)
