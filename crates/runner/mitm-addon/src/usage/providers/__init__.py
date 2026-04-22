"""Per-provider usage reporting modules.

Model-provider responses route through :mod:`.model_provider` (a single
entry point because all model providers share the Anthropic Messages
API shape).  Connector billing routes through the per-connector modules
under :mod:`.connectors` — one file per billable connector so that each
connector's domain quirks stay isolated.
"""
