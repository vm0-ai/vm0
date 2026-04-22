"""Per-connector billing dispatcher + module registry.

One file per billable connector under this package owns the connector's
domain-specific request / response parsing.  :func:`report_connector_usage`
is the single entry point called by the addon response / error handlers;
it applies the universal gates (``run_id`` present, firewall flagged
billable by the web layer, firewall has a registered handler) and
delegates to the matching per-connector ``report_usage`` function.

Adding a new billable connector = add a new file here + register it in
:data:`_HANDLERS`.  The dispatcher already enforces the cross-connector
invariants.
"""

from collections.abc import Callable

from mitmproxy import http

from logging_utils import log_proxy_entry

from . import x

# Map firewall_name → per-connector report_usage handler.  A handler is only
# invoked when ``flow.metadata["firewall_billable"]`` is True, so the
# BILLABLE_CONNECTORS whitelist in ``@vm0/core`` and this table must stay
# in sync.  (The web layer controls who shows up as ``billable``; this
# table controls who we know how to parse.  Desync manifests as a
# dropped billing record plus a missing handler in test coverage.)
_HANDLERS: dict[str, Callable[[http.HTTPFlow, str], None]] = {
    "x": x.report_usage,
}

# One-shot guard: first time we see a billable firewall_name with no
# registered handler, warn once per name per addon process.  Catches the
# deployment-desync case where ``@vm0/core``'s ``BILLABLE_CONNECTORS`` has
# grown but the runner is on an older addon image — without this, billing
# records silently drop with no local signal.
_unregistered_handler_warned: set[str] = set()


def report_connector_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Dispatch a billable connector flow to its per-connector handler.

    Universal skip conditions applied here (once, instead of inside every
    connector module):

    - ``run_id`` is empty (no billing attribution).
    - ``flow.metadata["firewall_billable"]`` is False (web layer decided
      this firewall is not platform-billable for this run).
    - ``flow.metadata["firewall_name"]`` has no registered handler (covers
      both the model-provider path — routed through
      :func:`report_model_provider_usage` instead — and any firewall that
      ``@vm0/core``'s ``BILLABLE_CONNECTORS`` flags as billable but which
      this addon version does not yet know how to parse).
    """
    if not run_id:
        return
    if not flow.metadata.get("firewall_billable", False):
        return
    firewall_name = flow.metadata.get("firewall_name", "")
    handler = _HANDLERS.get(firewall_name)
    if handler is None:
        if firewall_name and firewall_name not in _unregistered_handler_warned:
            _unregistered_handler_warned.add(firewall_name)
            log_proxy_entry(
                flow.metadata.get("vm_proxy_log_path", ""),
                "warn",
                f"Billable firewall {firewall_name!r} has no registered handler — "
                "billing records for this firewall will be dropped.  Check that "
                "BILLABLE_CONNECTORS in @vm0/core and _HANDLERS here are in sync.",
                type="usage_event",
                firewall_name=firewall_name,
            )
        return
    handler(flow, run_id)
