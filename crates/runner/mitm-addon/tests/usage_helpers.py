"""Shared usage assertion helpers for mitm-addon tests."""

import json
import uuid

from usage.namespaces import USAGE_EVENT_NAMESPACE_MODEL


def request_bodies_from_calls(call_args_list):
    return [json.loads(call[0][0].data) for call in call_args_list]


def usage_event_events_from_calls(call_args_list):
    return [event for body in request_bodies_from_calls(call_args_list) for event in body["events"]]


def model_usage_idempotency_key(run_id: str, message_id: str, category: str) -> str:
    encoded = "\0".join(
        f"{len(part.encode('utf-8'))}:{part}" for part in (run_id, message_id, category)
    )
    return str(uuid.uuid5(USAGE_EVENT_NAMESPACE_MODEL, encoded))
