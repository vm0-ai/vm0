"""Usage-event idempotency key protocol helpers.

Each writer source has its own UUIDv5 namespace so identical input strings
never collide across sources. These constants and the UUIDv5 name encoding
MUST stay byte-stable: the platform deduplicates by the submitted
`usage_event.idempotency_key` unique index rather than recalculating inputs.
"""

import uuid

# Connector-kind usage events (mitmproxy-reported per-API-call records).
USAGE_EVENT_NAMESPACE_CONNECTOR = uuid.UUID("2f8e4a91-6d3c-4b5a-8e7f-9c1d2e3f4a5b")

# Model-kind usage events (mitmproxy-reported model provider token records).
USAGE_EVENT_NAMESPACE_MODEL = uuid.UUID("18a22204-d25e-4170-8973-86477f864bfb")

# Aggregate flush-batch usage events (mitmproxy-reported buffered records).
USAGE_EVENT_NAMESPACE_AGGREGATE = uuid.UUID("4c4ee19a-b1b4-47e6-aef4-642d972cf4f5")


def encode_uuid_name(parts: tuple[str, ...]) -> str:
    return "\0".join(f"{len(part.encode('utf-8'))}:{part}" for part in parts)
