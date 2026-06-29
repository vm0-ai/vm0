"""Tests for upstream destination binding in server_connect()."""

import asyncio
import socket
import threading
import uuid
from unittest.mock import patch

import mitm_addon
import upstream_destination_binding
from tests.request_handler_helpers import (
    _single_firewall_vm,
    _write_github_firewall_registry,
    _write_registry,
)

_API_ADDRINFO = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("198.18.20.34", 443))]


class _Server:
    def __init__(
        self,
        *,
        address: tuple[str, int] = ("203.0.113.10", 443),
        peername: tuple[str, int] | None = None,
        connected: bool = False,
        server_id: str | None = None,
    ) -> None:
        self.id = server_id or str(uuid.uuid4())
        self.address = address
        self.peername = peername
        self.connected = connected


class _Client:
    def __init__(
        self,
        *,
        client_ip: str = "10.200.0.5",
        sni: str = "api.github.com",
        sockname: tuple[str, int] = ("127.0.0.1", 8080),
    ) -> None:
        self.id = str(uuid.uuid4())
        self.peername = (client_ip, 12345)
        self.sockname = sockname
        self.sni = sni


class _ServerConnectData:
    def __init__(self, *, client: _Client, server: _Server) -> None:
        self.client = client
        self.server = server


def _data(
    *,
    client_ip: str = "10.200.0.5",
    sni: str = "api.github.com",
    address: tuple[str, int] = ("203.0.113.10", 443),
    server_peername: tuple[str, int] | None = None,
    server_connected: bool = False,
    client_sockname: tuple[str, int] = ("127.0.0.1", 8080),
) -> _ServerConnectData:
    return _ServerConnectData(
        client=_Client(client_ip=client_ip, sni=sni, sockname=client_sockname),
        server=_Server(address=address, peername=server_peername, connected=server_connected),
    )


async def test_server_connect_retargets_credentialed_connector_host(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("api.github.com", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.github.com"
    assert binding.port == 443
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


async def test_server_connect_uses_tls_clienthello_sni_when_client_sni_is_empty(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data(sni="")
    mitm_addon._record_tls_admission(
        data.client,
        mitm_addon._TlsAdmission(
            client_ip="10.200.0.5",
            kind=mitm_addon._TLS_ADMISSION_VALID_REGISTRY_VM,
            run_id="run-conn-1",
            sni="api.github.com",
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("api.github.com", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))


async def test_server_connect_retargets_api_allow_host(registry_file, mitm_ctx):
    data = _data(client_ip="10.200.0.1", sni="api.vm0.ai")

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("api.vm0.ai", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.kinds == frozenset(("api_allow",))


async def test_server_connect_does_not_prebind_platform_connector_auth(tmp_path, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.vm0.ai/api/test/oauth-provider",
                "auth": {"headers": {"Authorization": "Bearer x"}},
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy={"allow": ["echo"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )
    data = _data(sni="api.vm0.ai")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("api.vm0.ai", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.kinds == frozenset(("api_allow",))


async def test_server_connect_does_not_bind_connected_api_edge_from_sni_only(
    registry_file, mitm_ctx
):
    data = _data(
        client_ip="10.200.0.1",
        sni="pr-test-api.vm6.ai",
        address=("76.76.21.164", 443),
        server_peername=("76.76.21.164", 443),
        server_connected=True,
    )

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("66.33.60.34", 443))],
        ),
    ):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("76.76.21.164", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_does_not_bind_connected_connector_from_sni_only(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data(
        sni="api.github.com",
        address=("140.82.112.5", 443),
        server_peername=("140.82.112.5", 443),
        server_connected=True,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=AssertionError("connector binding must not use fresh DNS"),
        ),
    ):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("140.82.112.5", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_binds_api_host_from_original_address(registry_file, mitm_ctx):
    data = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon.socket, "getaddrinfo", return_value=_API_ADDRINFO),
    ):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("pr-test-api.vm6.ai", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "pr-test-api.vm6.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("198.18.20.34", 443)


async def test_server_connect_does_not_bind_connected_api_host_from_original_address(
    registry_file, mitm_ctx
):
    data = _data(
        client_ip="10.200.0.1",
        sni="",
        address=("198.18.20.34", 443),
        server_peername=("198.18.20.34", 443),
        server_connected=True,
    )

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon.socket, "getaddrinfo", return_value=_API_ADDRINFO),
    ):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("198.18.20.34", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_binds_api_host_from_transparent_sockname(registry_file, mitm_ctx):
    data = _data(
        client_ip="10.200.0.1",
        sni="",
        address=("127.0.0.1", 8080),
        client_sockname=("198.18.20.34", 443),
    )

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon.socket, "getaddrinfo", return_value=_API_ADDRINFO),
    ):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("pr-test-api.vm6.ai", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "pr-test-api.vm6.ai"
    assert binding.kinds == frozenset(("api_allow",))
    assert binding.original_address == ("198.18.20.34", 443)


async def test_server_connect_does_not_bind_api_host_when_original_address_misses_dns(
    registry_file, mitm_ctx
):
    data = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.35", 443))

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon.socket, "getaddrinfo", return_value=_API_ADDRINFO),
    ):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("198.18.20.35", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_does_not_retarget_auth_base_only_connector(tmp_path, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
            },
            network_policy={"allow": ["send"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )
    data = _data(sni="placeholder.example.com")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_ignores_unregistered_vm(registry_file, mitm_ctx):
    data = _data(client_ip="192.168.99.99")

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_ignores_invalid_sni(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data(sni="api.github.com..")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_disconnect_and_connect_error_clear_binding(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.id in upstream_destination_binding.binding_snapshot_for_tests()
    mitm_addon.server_disconnected(data)
    assert data.server.id not in upstream_destination_binding.binding_snapshot_for_tests()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.vm0.ai"):
        await mitm_addon.server_connect(data)

    assert data.server.id in upstream_destination_binding.binding_snapshot_for_tests()
    mitm_addon.server_connect_error(data)
    assert data.server.id not in upstream_destination_binding.binding_snapshot_for_tests()


async def test_server_connect_negative_caches_dns_errors(registry_file, mitm_ctx):
    first = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    second = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon, "_trusted_host_address_cache_time", return_value=10.0),
        patch.object(mitm_addon.socket, "getaddrinfo", side_effect=OSError("dns down")) as dns,
    ):
        await mitm_addon.server_connect(first)
        await mitm_addon.server_connect(second)

    assert dns.call_count == 1
    assert first.server.address == ("198.18.20.34", 443)
    assert second.server.address == ("198.18.20.34", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_negative_caches_empty_dns_results(registry_file, mitm_ctx):
    first = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    second = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon, "_trusted_host_address_cache_time", return_value=10.0),
        patch.object(mitm_addon.socket, "getaddrinfo", return_value=[]) as dns,
    ):
        await mitm_addon.server_connect(first)
        await mitm_addon.server_connect(second)

    assert dns.call_count == 1
    assert first.server.address == ("198.18.20.34", 443)
    assert second.server.address == ("198.18.20.34", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_retries_after_negative_dns_cache_expires(registry_file, mitm_ctx):
    failed = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    retried = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))

    monotonic_values = [10.0, 10.0, 20.0, 20.0]
    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(
            mitm_addon,
            "_trusted_host_address_cache_time",
            side_effect=monotonic_values,
        ),
        patch.object(
            mitm_addon.socket,
            "getaddrinfo",
            side_effect=[OSError("dns down"), _API_ADDRINFO],
        ) as dns,
    ):
        await mitm_addon.server_connect(failed)
        await mitm_addon.server_connect(retried)

    assert dns.call_count == 2
    assert failed.server.address == ("198.18.20.34", 443)
    assert retried.server.address == ("pr-test-api.vm6.ai", 443)
    assert retried.server.id in upstream_destination_binding.binding_snapshot_for_tests()


async def test_server_connect_positive_caches_dns_results(registry_file, mitm_ctx):
    first = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    second = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon, "_trusted_host_address_cache_time", return_value=10.0),
        patch.object(mitm_addon.socket, "getaddrinfo", return_value=_API_ADDRINFO) as dns,
    ):
        await mitm_addon.server_connect(first)
        await mitm_addon.server_connect(second)

    assert dns.call_count == 1
    assert first.server.address == ("pr-test-api.vm6.ai", 443)
    assert second.server.address == ("pr-test-api.vm6.ai", 443)


async def test_server_connect_coalesces_concurrent_dns_resolution(registry_file, mitm_ctx):
    first = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    second = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    lookup_started = threading.Event()
    release_lookup = threading.Event()
    calls: list[tuple[str, int]] = []

    def getaddrinfo(host: str, port: int, *args, **kwargs):
        calls.append((host, port))
        lookup_started.set()
        release_lookup.wait()
        return _API_ADDRINFO

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon.socket, "getaddrinfo", side_effect=getaddrinfo),
    ):
        first_task = asyncio.create_task(mitm_addon.server_connect(first))
        assert await asyncio.to_thread(lookup_started.wait, 5)
        second_task = asyncio.create_task(mitm_addon.server_connect(second))
        await asyncio.sleep(0)
        release_lookup.set()
        await asyncio.gather(first_task, second_task)

    assert calls == [("pr-test-api.vm6.ai", 443)]
    assert first.server.address == ("pr-test-api.vm6.ai", 443)
    assert second.server.address == ("pr-test-api.vm6.ai", 443)


async def test_server_connect_cancelled_waiter_does_not_cancel_shared_dns_lookup(
    registry_file, mitm_ctx
):
    cancelled = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    completed = _data(client_ip="10.200.0.1", sni="", address=("198.18.20.34", 443))
    lookup_started = threading.Event()
    release_lookup = threading.Event()
    calls: list[tuple[str, int]] = []

    def getaddrinfo(host: str, port: int, *args, **kwargs):
        calls.append((host, port))
        lookup_started.set()
        release_lookup.wait()
        return _API_ADDRINFO

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"),
        patch.object(mitm_addon.socket, "getaddrinfo", side_effect=getaddrinfo),
    ):
        cancelled_task = asyncio.create_task(mitm_addon.server_connect(cancelled))
        assert await asyncio.to_thread(lookup_started.wait, 5)
        completed_task = asyncio.create_task(mitm_addon.server_connect(completed))
        await asyncio.sleep(0)
        cancelled_task.cancel()
        release_lookup.set()
        await asyncio.gather(cancelled_task, return_exceptions=True)
        await completed_task

    assert calls == [("pr-test-api.vm6.ai", 443)]
    assert cancelled.server.address == ("198.18.20.34", 443)
    assert completed.server.address == ("pr-test-api.vm6.ai", 443)
