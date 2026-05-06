"""Per-provider usage reporting modules.

Model-provider responses route through :mod:`.model_provider` after a
provider-specific extractor normalizes API usage fields into shared
``usage_event`` categories.  Connector billing routes through the
per-connector modules under :mod:`.connectors` — one file per billable
connector so that each connector's domain quirks stay isolated.
"""
