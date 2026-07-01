"""Shared destination and context helpers for usage webhook reporting."""

from mitmproxy import http

import flow_metadata_keys as metadata_keys
from platform_api import get_api_url

USAGE_EVENT_WEBHOOK_PATH = "/api/webhooks/agent/usage-event"
MODEL_USAGE_OBSERVATION_WEBHOOK_PATH = "/api/webhooks/agent/model-usage-observation"


class UsageReportingContext:
    """Flow-local platform reporting context for usage webhook uploads."""

    __slots__ = ("api_url", "proxy_log_path", "sandbox_token")

    def __init__(self, *, sandbox_token: str, api_url: str, proxy_log_path: str) -> None:
        self.sandbox_token = sandbox_token
        self.api_url = api_url
        self.proxy_log_path = proxy_log_path

    def __repr__(self) -> str:
        return (
            "UsageReportingContext("
            f"sandbox_token={'<present>' if self.sandbox_token else '<missing>'}, "
            f"api_url={self.api_url!r}, "
            f"proxy_log_path={self.proxy_log_path!r})"
        )

    @property
    def missing_sandbox_token(self) -> bool:
        return not bool(self.sandbox_token)

    @property
    def missing_api_url(self) -> bool:
        return not bool(self.api_url)

    @property
    def is_complete(self) -> bool:
        return not self.missing_sandbox_token and not self.missing_api_url

    def _url_for(self, path: str) -> str:
        return f"{self.api_url}{path}"

    def usage_event_url(self) -> str:
        return self._url_for(USAGE_EVENT_WEBHOOK_PATH)

    def model_usage_observation_url(self) -> str:
        return self._url_for(MODEL_USAGE_OBSERVATION_WEBHOOK_PATH)


def usage_reporting_context(flow: http.HTTPFlow) -> UsageReportingContext:
    return UsageReportingContext(
        sandbox_token=_metadata_string(flow, metadata_keys.VM_SANDBOX_AUTH_KEY),
        api_url=get_api_url(),
        proxy_log_path=_metadata_string(flow, metadata_keys.VM_PROXY_LOG_PATH),
    )


def _metadata_string(flow: http.HTTPFlow, key: str) -> str:
    value = flow.metadata.get(key, "")
    return value if isinstance(value, str) else ""
