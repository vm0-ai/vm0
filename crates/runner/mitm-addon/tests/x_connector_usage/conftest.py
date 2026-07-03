"""Pytest fixtures for direct X connector usage reporting tests."""

import pytest

from tests.x_connector_usage.helpers import UsageWebhookApi, XUsageHarness


@pytest.fixture
def x_usage(sync_usage_executor, usage_webhook_api: UsageWebhookApi) -> XUsageHarness:
    return XUsageHarness(usage_webhook_api)
