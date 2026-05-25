"""Shared usage assertion helpers for mitm-addon tests."""

import json


def request_bodies_from_calls(call_args_list):
    return [json.loads(call[0][0].data) for call in call_args_list]


def usage_event_events_from_calls(call_args_list):
    return [event for body in request_bodies_from_calls(call_args_list) for event in body["events"]]
