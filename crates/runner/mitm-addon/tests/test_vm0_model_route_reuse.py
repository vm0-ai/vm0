"""VM0 model route reuse across requests in one runner-managed run."""

import base64
import hashlib
import hmac
import json
import time
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

import mitm_addon
from tests.flow_helpers import header_map
from tests.request_handler_helpers import _single_firewall_vm, _write_registry


def _write_vm0_model_registry(tmp_path: Path, run_id: str) -> Path:
    return _write_registry(
        tmp_path,
        vm_info=_single_firewall_vm(
            tmp_path,
            run_id=run_id,
            firewall_name="model-provider:vm0-model",
            api_entry={
                "base": "https://model.vm0.ai/api/internal/vm0-model/v1/responses",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.OPENAI_API_KEY }}",
                        "X-VM0-Upstream-Authorization": (
                            "Bearer ${{ secrets.VM0_MODEL_UPSTREAM_API_KEY }}"
                        ),
                    }
                },
                "permissions": [],
            },
            network_policy=None,
        ),
    )


def _model_flow(real_flow, headers) -> http.HTTPFlow:
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="model.vm0.ai",
        path="/api/internal/vm0-model/v1/responses",
        method="POST",
        request_body=b"{}",
        request_headers=headers(
            ("Host", "model.vm0.ai"),
            ("Content-Type", "application/json"),
            ("Content-Length", "2"),
        ),
    )


def _signed_route_headers(run_id: str, difficulty: str = "hard") -> dict[str, str]:
    receipt = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "version": 1,
                    "runId": run_id,
                    "difficulty": difficulty,
                    "issuedAt": int(time.time()),
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = (
        base64.urlsafe_b64encode(
            hmac.new(
                b"proxy-secret",
                b"vm0-model-route-receipt-v1\0" + receipt.encode(),
                hashlib.sha256,
            ).digest()
        )
        .decode()
        .rstrip("=")
    )
    return {
        "content-type": "application/json",
        "x-vm0-route-receipt": receipt,
        "x-vm0-route-signature": signature,
    }


async def test_reuses_signed_route_only_within_the_same_run(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    registry_path = _write_vm0_model_registry(tmp_path, "run-first")
    resolved_headers = {
        "Authorization": "Bearer proxy-secret",
        "X-VM0-Upstream-Authorization": "Bearer upstream-secret",
    }

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        first = _model_flow(real_flow, headers)
        first.request.headers["X-VM0-Route-Receipt"] = "sandbox-value"
        first.request.headers["X-VM0-Route-Signature"] = "sandbox-signature"
        await mitm_addon.request(first)

        assert first.request.headers["X-VM0-Run-ID"] == "run-first"
        assert "X-VM0-Route-Receipt" not in first.request.headers
        assert "X-VM0-Route-Signature" not in first.request.headers

        route_headers = _signed_route_headers("run-first")
        first.response = tutils.tresp(status_code=200, headers=header_map(route_headers))
        mitm_addon.responseheaders(first)

        assert "X-VM0-Route-Receipt" not in first.response.headers
        assert "X-VM0-Route-Signature" not in first.response.headers

        second = _model_flow(real_flow, headers)
        await mitm_addon.request(second)

        assert second.request.headers["X-VM0-Run-ID"] == "run-first"
        assert second.request.headers["X-VM0-Route-Receipt"] == route_headers["x-vm0-route-receipt"]
        assert (
            second.request.headers["X-VM0-Route-Signature"]
            == route_headers["x-vm0-route-signature"]
        )

        _write_vm0_model_registry(tmp_path, "run-next")
        next_run = _model_flow(real_flow, headers)
        await mitm_addon.request(next_run)

        assert next_run.request.headers["X-VM0-Run-ID"] == "run-next"
        assert "X-VM0-Route-Receipt" not in next_run.request.headers
        assert "X-VM0-Route-Signature" not in next_run.request.headers


async def test_does_not_cache_an_invalid_route_receipt(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
):
    registry_path = _write_vm0_model_registry(tmp_path, "run-invalid")
    resolved_headers = {
        "Authorization": "Bearer proxy-secret",
        "X-VM0-Upstream-Authorization": "Bearer upstream-secret",
    }

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.vm0.ai"),
        fake_firewall_headers(headers=resolved_headers),
    ):
        first = _model_flow(real_flow, headers)
        await mitm_addon.request(first)
        invalid_headers = _signed_route_headers("run-invalid")
        invalid_headers["x-vm0-route-signature"] = "invalid"
        first.response = tutils.tresp(status_code=200, headers=header_map(invalid_headers))
        mitm_addon.responseheaders(first)

        second = _model_flow(real_flow, headers)
        await mitm_addon.request(second)

        assert "X-VM0-Route-Receipt" not in second.request.headers
        assert "X-VM0-Route-Signature" not in second.request.headers
