"""Namespace UUIDs for deriving `usage_event.idempotency_key` via UUIDv5.

Each writer source has its own namespace so that identical input strings
never collide across sources.  These constants MUST match the values used
on the platform side — the server validates incoming keys against a
UNIQUE index, not the namespace itself, so drift here silently breaks
dedup rather than surfacing an error.
"""

import uuid

# Connector-kind usage events (mitmproxy-reported per-API-call records).
USAGE_EVENT_NAMESPACE_CONNECTOR = uuid.UUID("2f8e4a91-6d3c-4b5a-8e7f-9c1d2e3f4a5b")

# Model-kind usage events (mitmproxy-reported model provider token records).
USAGE_EVENT_NAMESPACE_MODEL = uuid.UUID("18a22204-d25e-4170-8973-86477f864bfb")
