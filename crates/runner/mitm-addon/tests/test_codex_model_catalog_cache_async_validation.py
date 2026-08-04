"""Integration coverage for asynchronous Codex catalog validation ownership."""

import asyncio
import json
import threading
from collections.abc import Awaitable, Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import ParamSpec, TypeVar

import pytest
from mitmproxy import http

import codex_model_catalog_cache as catalog_cache
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    catalog_flow,
    catalog_response,
    prepare_miss,
)
from tests.flow_helpers import response_stream

_P = ParamSpec("_P")
_T = TypeVar("_T")
_FlowFactory = Callable[..., http.HTTPFlow]


class _ControlledValidationExecutor(ThreadPoolExecutor):
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__(max_workers=4, thread_name_prefix="catalog-validation-test")
        self._loop = loop
        self._release = threading.Event()
        self._lock = threading.Lock()
        self._submission_count = 0
        self._active_count = 0
        self.max_active_count = 0
        self.worker_thread_ids: set[int] = set()
        self.started = asyncio.Event()

    @property
    def submission_count(self) -> int:
        with self._lock:
            return self._submission_count

    def release_workers(self) -> None:
        self._release.set()

    def submit(
        self,
        fn: Callable[_P, _T],
        /,
        *args: _P.args,
        **kwargs: _P.kwargs,
    ) -> Future[_T]:
        with self._lock:
            self._submission_count += 1

        def controlled_call() -> _T:
            with self._lock:
                self._active_count += 1
                self.max_active_count = max(self.max_active_count, self._active_count)
                self.worker_thread_ids.add(threading.get_ident())
            self._loop.call_soon_threadsafe(self.started.set)
            self._release.wait()
            try:
                return fn(*args, **kwargs)
            finally:
                with self._lock:
                    self._active_count -= 1

        return super().submit(controlled_call)


def _dense_catalog_body(label: str) -> bytes:
    item = json.dumps(
        {"slug": label, "display_name": "Dense model"},
        separators=(",", ":"),
    ).encode()
    prefix = b'{"models":['
    suffix = b"]}"
    item_count = (catalog_cache.MAX_ENTRY_BYTES - len(prefix) - len(suffix) + 1) // (len(item) + 1)
    body = prefix + b",".join([item] * item_count) + suffix
    assert len(body) <= catalog_cache.MAX_ENTRY_BYTES
    assert len(body) >= catalog_cache.MAX_ENTRY_BYTES * 9 // 10
    return body


async def _start_catalog_response(
    real_flow: _FlowFactory,
    *,
    version: str,
    body: bytes,
) -> tuple[http.HTTPFlow, Awaitable[None]]:
    flow = catalog_flow(real_flow, version=version)
    await prepare_miss(flow)
    flow.response = catalog_response(body=body, encoding="identity")
    mitm_addon.responseheaders(flow)
    assert callable(flow.response.stream)
    assert response_stream(flow)(body) == body
    continuation = mitm_addon.response(flow)
    assert continuation is not None
    return flow, continuation


async def _release_tasks(
    executor: _ControlledValidationExecutor,
    tasks: list[asyncio.Task[None]],
) -> None:
    executor.release_workers()
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _await_continuation(continuation: Awaitable[None]) -> None:
    await continuation


def _replace_default_executor(
    loop: asyncio.AbstractEventLoop,
    executor: _ControlledValidationExecutor,
) -> None:
    loop.set_default_executor(
        ThreadPoolExecutor(max_workers=1, thread_name_prefix="post-catalog-test")
    )
    executor.shutdown(wait=True)


def test_non_catalog_response_hook_stays_synchronous(real_flow: _FlowFactory) -> None:
    assert mitm_addon.response(real_flow()) is None


async def test_dense_catalog_validations_are_serialized_off_event_loop(
    real_flow: _FlowFactory,
    mitm_ctx,
) -> None:
    loop = asyncio.get_running_loop()
    loop_thread_id = threading.get_ident()
    executor = _ControlledValidationExecutor(loop)
    loop.set_default_executor(executor)
    tasks: list[asyncio.Task[None]] = []
    first_body = _dense_catalog_body("first")
    second_body = _dense_catalog_body("second")

    try:
        with mitm_ctx():
            try:
                _, first_continuation = await _start_catalog_response(
                    real_flow,
                    version="off-loop-first",
                    body=first_body,
                )
                first_task = asyncio.create_task(_await_continuation(first_continuation))
                tasks.append(first_task)
                await asyncio.wait_for(executor.started.wait(), timeout=1)

                progressed = asyncio.Event()
                loop.call_soon(progressed.set)
                await asyncio.wait_for(progressed.wait(), timeout=1)
                assert not first_task.done()
                assert executor.worker_thread_ids
                assert loop_thread_id not in executor.worker_thread_ids

                _, second_continuation = await _start_catalog_response(
                    real_flow,
                    version="off-loop-second",
                    body=second_body,
                )
                second_task = asyncio.create_task(_await_continuation(second_continuation))
                tasks.append(second_task)
                await asyncio.sleep(0)
                assert not second_task.done()
                assert executor.submission_count == 1

                executor.release_workers()
                await asyncio.gather(*tasks)
            finally:
                await _release_tasks(executor, tasks)

        assert executor.submission_count == 2
        assert executor.max_active_count == 1
        for version, expected_body in (
            ("off-loop-first", first_body),
            ("off-loop-second", second_body),
        ):
            hit = catalog_flow(real_flow, version=version)
            await catalog_cache.prepare_request(hit, request_end_stream=True)
            assert hit.response is not None
            assert hit.response.content == expected_body
            catalog_cache.release_flow_state(hit)
    finally:
        _replace_default_executor(loop, executor)


async def test_catalog_validation_cancellation_preserves_atomic_ownership(
    real_flow: _FlowFactory,
    mitm_ctx,
) -> None:
    loop = asyncio.get_running_loop()
    executor = _ControlledValidationExecutor(loop)
    loop.set_default_executor(executor)
    tasks: list[asyncio.Task[None]] = []
    admitted_body = _dense_catalog_body("admitted")
    waiting_body = _dense_catalog_body("waiting")

    try:
        with mitm_ctx():
            try:
                admitted_flow, admitted_continuation = await _start_catalog_response(
                    real_flow,
                    version="cancel-admitted",
                    body=admitted_body,
                )
                admitted_task = asyncio.create_task(_await_continuation(admitted_continuation))
                tasks.append(admitted_task)
                await asyncio.wait_for(executor.started.wait(), timeout=1)

                waiting_flow, waiting_continuation = await _start_catalog_response(
                    real_flow,
                    version="cancel-waiting",
                    body=waiting_body,
                )
                waiting_task = asyncio.create_task(_await_continuation(waiting_continuation))
                tasks.append(waiting_task)
                await asyncio.sleep(0)
                assert executor.submission_count == 1

                follower = catalog_flow(real_flow, version="cancel-waiting")
                follower_prepare = asyncio.create_task(
                    catalog_cache.prepare_request(follower, request_end_stream=True)
                )
                await asyncio.sleep(0)
                assert not follower_prepare.done()

                waiting_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await waiting_task
                await asyncio.wait_for(follower_prepare, timeout=1)
                assert follower.response is None
                assert follower.request.headers["Accept-Encoding"] == "br"
                assert executor.submission_count == 1
                catalog_cache.handle_error(follower)

                admitted_task.cancel()
                await asyncio.sleep(0)
                admitted_task.cancel()
                await asyncio.sleep(0)
                assert not admitted_task.done()

                executor.release_workers()
                with pytest.raises(asyncio.CancelledError):
                    await admitted_task
            finally:
                await _release_tasks(executor, tasks)

        assert "_codex_model_catalog_cache_state" not in admitted_flow.metadata
        assert "_codex_model_catalog_cache_state" not in waiting_flow.metadata

        admitted_hit = catalog_flow(real_flow, version="cancel-admitted")
        await catalog_cache.prepare_request(admitted_hit, request_end_stream=True)
        assert admitted_hit.response is not None
        assert admitted_hit.response.content == admitted_body
        catalog_cache.release_flow_state(admitted_hit)

        missing_hit = catalog_flow(real_flow, version="cancel-waiting")
        await prepare_miss(missing_hit)
        catalog_cache.handle_error(missing_hit)

        owners = [
            catalog_flow(real_flow, version=f"post-cancel-capacity-{index}")
            for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS)
        ]
        for owner in owners:
            await prepare_miss(owner)
        overflow = catalog_flow(real_flow, version="post-cancel-capacity-overflow")
        await catalog_cache.prepare_request(overflow, request_end_stream=True)
        assert overflow.response is None
        assert overflow.request.headers["Accept-Encoding"] == "identity"
        overflow_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
        assert overflow_telemetry == {
            "model_catalog_cache_status": "model_catalog_bypass",
            "model_catalog_cache_bypass_reason": "request_capacity",
        }
        for owner in owners:
            catalog_cache.handle_error(owner)
    finally:
        _replace_default_executor(loop, executor)


async def test_executor_submission_failure_releases_catalog_owner(
    real_flow: _FlowFactory,
    mitm_ctx,
) -> None:
    loop = asyncio.get_running_loop()
    failed_executor = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="failed-catalog-test",
    )
    loop.set_default_executor(failed_executor)
    failed_executor.shutdown(wait=True)

    try:
        with mitm_ctx():
            flow, continuation = await _start_catalog_response(
                real_flow,
                version="executor-failure",
                body=b'{"models":[]}',
            )
            with pytest.raises(RuntimeError):
                await continuation

        assert "_codex_model_catalog_cache_state" not in flow.metadata
        retry = catalog_flow(real_flow, version="executor-failure")
        await prepare_miss(retry)
        catalog_cache.handle_error(retry)
    finally:
        loop.set_default_executor(
            ThreadPoolExecutor(max_workers=1, thread_name_prefix="post-catalog-failure-test")
        )
