"""Integration coverage for Codex model catalog cache request coordination."""

import asyncio
from unittest.mock import patch

import pytest
from mitmproxy.flow import Error

import codex_model_catalog_cache as catalog_cache
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    catalog_flow,
    catalog_response,
    finish_response,
    install_catalog,
    prepare_miss,
    responses_flow,
)


async def test_singleflight_delivers_owner_response_to_follower(real_flow):
    first = catalog_flow(real_flow, version="concurrent")
    second = catalog_flow(real_flow, version="concurrent")
    await prepare_miss(first)
    second_prepare = asyncio.create_task(
        catalog_cache.prepare_request(second, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not second_prepare.done()
    assert second.request.headers["Accept-Encoding"] == "identity"

    first_body = b'{"models":[{"slug":"first"}]}'
    first.response = catalog_response(body=first_body, encoding="br")
    assert finish_response(first)["model_catalog_cache_status"] == "model_catalog_cold_stored"
    await second_prepare
    assert second.response is not None
    assert second.response.content == first_body
    second_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(second, second_telemetry)
    assert second_telemetry["model_catalog_cache_status"] == "model_catalog_fresh_hit"

    hit = catalog_flow(real_flow, version="concurrent")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == first_body


async def test_prefetch_marker_is_stripped_and_roles_distinguish_consumers(real_flow):
    prefetch = catalog_flow(
        real_flow,
        version="prefetched",
        extra_headers={"X-VM0-Codex-Model-Catalog-Prefetch": "1"},
    )
    catalog_cache.capture_and_strip_prefetch_marker(prefetch)
    assert "X-VM0-Codex-Model-Catalog-Prefetch" not in prefetch.request.headers
    await prepare_miss(prefetch)

    in_flight_consumer = catalog_flow(real_flow, version="prefetched")
    consumer_prepare = asyncio.create_task(
        catalog_cache.prepare_request(in_flight_consumer, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not consumer_prepare.done()

    prefetch.response = catalog_response(encoding="br")
    prefetch_telemetry = finish_response(prefetch)
    assert prefetch_telemetry["model_catalog_prefetch_role"] == "producer"

    await consumer_prepare
    in_flight_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(in_flight_consumer, in_flight_telemetry)
    assert in_flight_telemetry["model_catalog_prefetch_role"] == "inflight_consumer"

    completed_consumer = catalog_flow(real_flow, version="prefetched")
    await catalog_cache.prepare_request(completed_consumer, request_end_stream=True)
    completed_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(completed_consumer, completed_telemetry)
    assert completed_telemetry["model_catalog_prefetch_role"] == "completed_consumer"
    catalog_cache.release_flow_state(prefetch)
    assert "_codex_model_catalog_prefetch_request" not in prefetch.metadata


async def test_failed_prefetch_releases_consumer_to_retry_upstream(real_flow):
    prefetch = catalog_flow(
        real_flow,
        version="prefetch-failure",
        extra_headers={"X-VM0-Codex-Model-Catalog-Prefetch": "1"},
    )
    catalog_cache.capture_and_strip_prefetch_marker(prefetch)
    await prepare_miss(prefetch)

    consumer = catalog_flow(real_flow, version="prefetch-failure")
    consumer_prepare = asyncio.create_task(
        catalog_cache.prepare_request(consumer, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not consumer_prepare.done()

    prefetch.error = Error("upstream reset")
    catalog_cache.handle_error(prefetch)
    await consumer_prepare

    assert consumer.response is None
    assert consumer.request.headers["Accept-Encoding"] == "br"
    consumer_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(consumer, consumer_telemetry)
    assert consumer_telemetry == {}
    catalog_cache.handle_error(consumer)


async def test_non_cacheable_identity_headers_release_singleflight_follower(real_flow):
    owner = catalog_flow(real_flow, version="identity-header-bypass")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="identity-header-bypass")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = catalog_response(
        encoding="identity",
        headers={"Cache-Control": "no-store"},
    )
    mitm_addon.responseheaders(owner)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "br"
    owner_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(owner, owner_telemetry)
    validation_latency = owner_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert owner_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": "response_cache_control",
        "model_catalog_cache_upstream_encoding": "identity",
    }
    catalog_cache.handle_error(follower)


async def test_released_owner_wakes_singleflight_follower(real_flow):
    owner = catalog_flow(real_flow, version="released-owner")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="released-owner")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    catalog_cache.release_flow_state(owner)
    await follower_prepare

    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "br"
    catalog_cache.handle_error(follower)


async def test_cancelled_follower_does_not_cancel_singleflight_owner(real_flow):
    owner = catalog_flow(real_flow, version="cancelled-follower")
    await prepare_miss(owner)

    cancelled_follower = asyncio.create_task(
        catalog_cache.prepare_request(
            catalog_flow(real_flow, version="cancelled-follower"),
            request_end_stream=True,
        )
    )
    await asyncio.sleep(0)
    cancelled_follower.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_follower

    surviving_follower = catalog_flow(real_flow, version="cancelled-follower")
    surviving_prepare = asyncio.create_task(
        catalog_cache.prepare_request(surviving_follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not surviving_prepare.done()

    owner.response = catalog_response(encoding="br")
    finish_response(owner)
    await surviving_prepare
    assert surviving_follower.response is not None
    assert surviving_follower.response.content == CATALOG_BODY


async def test_singleflight_wait_is_bounded_without_canceling_owner(real_flow):
    owner = catalog_flow(real_flow, version="bounded-wait")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="bounded-wait")

    with patch.object(catalog_cache, "MAX_IN_FLIGHT_WAIT_SECONDS", 0):
        await catalog_cache.prepare_request(follower, request_end_stream=True)

    follower_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(follower, follower_telemetry)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    assert follower_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    owner.response = catalog_response(encoding="br")
    finish_response(owner)
    hit = catalog_flow(real_flow, version="bounded-wait")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == CATALOG_BODY


async def test_singleflight_wait_deadline_spans_replacement_owners(real_flow):
    with patch.object(catalog_cache, "time") as cache_time:
        cache_time.monotonic.return_value = 100.0
        first_owner = catalog_flow(real_flow, version="bounded-retry")
        await prepare_miss(first_owner)
        follower = catalog_flow(real_flow, version="bounded-retry")
        follower_prepare = asyncio.create_task(
            catalog_cache.prepare_request(follower, request_end_stream=True)
        )
        await asyncio.sleep(0)
        assert not follower_prepare.done()

        catalog_cache.handle_error(first_owner)
        replacement_owner = catalog_flow(real_flow, version="bounded-retry")
        await prepare_miss(replacement_owner)
        cache_time.monotonic.return_value = 100.0 + catalog_cache.MAX_IN_FLIGHT_WAIT_SECONDS

        await asyncio.wait_for(follower_prepare, timeout=0.1)
        follower_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(follower, follower_telemetry)
        assert follower.response is None
        assert follower.request.headers["Accept-Encoding"] == "identity"
        assert follower_telemetry == {
            "model_catalog_cache_status": "model_catalog_bypass",
            "model_catalog_cache_bypass_reason": "request_capacity",
        }
        catalog_cache.handle_error(replacement_owner)


async def test_singleflight_rechecks_entry_after_etag_invalidation(real_flow):
    owner = catalog_flow(real_flow, version="invalidated-inflight")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="invalidated-inflight")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = catalog_response(encoding="br")
    finish_response(owner)
    invalidation = responses_flow(real_flow, etag='"catalog-v2"')
    mitm_addon.responseheaders(invalidation)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "br"
    catalog_cache.handle_error(follower)


async def test_singleflight_waiter_bound_bypasses_excess_requests(real_flow):
    owner = catalog_flow(real_flow, version="waiter-capacity")
    await prepare_miss(owner)
    waiters = [
        asyncio.create_task(
            catalog_cache.prepare_request(
                catalog_flow(real_flow, version="waiter-capacity"),
                request_end_stream=True,
            )
        )
        for _ in range(catalog_cache.MAX_WAITERS_PER_KEY)
    ]
    await asyncio.sleep(0)
    assert all(not waiter.done() for waiter in waiters)

    overflow = catalog_flow(real_flow, version="waiter-capacity")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    for waiter in waiters:
        waiter.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    catalog_cache.handle_error(owner)


async def test_singleflight_total_waiter_bound_spans_catalog_keys(real_flow):
    owner_count = (
        catalog_cache.MAX_TOTAL_WAITERS + catalog_cache.MAX_WAITERS_PER_KEY - 1
    ) // catalog_cache.MAX_WAITERS_PER_KEY
    owners = [
        catalog_flow(real_flow, version=f"total-waiter-capacity-{index}")
        for index in range(owner_count)
    ]
    for owner in owners:
        await prepare_miss(owner)

    waiters = [
        asyncio.create_task(
            catalog_cache.prepare_request(
                catalog_flow(
                    real_flow,
                    version=f"total-waiter-capacity-{index // catalog_cache.MAX_WAITERS_PER_KEY}",
                ),
                request_end_stream=True,
            )
        )
        for index in range(catalog_cache.MAX_TOTAL_WAITERS)
    ]
    await asyncio.sleep(0)
    assert all(not waiter.done() for waiter in waiters)

    overflow = catalog_flow(real_flow, version="total-waiter-capacity-0")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    for waiter in waiters:
        waiter.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    for owner in owners:
        catalog_cache.handle_error(owner)


async def test_in_flight_capacity_bypasses_without_changing_request_encoding(real_flow):
    active_flows = [
        catalog_flow(real_flow, version=f"active-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS)
    ]
    for flow in active_flows:
        await prepare_miss(flow)

    overflow = catalog_flow(real_flow, version="overflow")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }
    assert overflow.request.headers["Accept-Encoding"] == "identity"

    catalog_cache.handle_error(active_flows.pop())
    admitted = catalog_flow(real_flow, version="admitted")
    telemetry = await install_catalog(admitted)
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"

    for flow in active_flows:
        catalog_cache.handle_error(flow)
