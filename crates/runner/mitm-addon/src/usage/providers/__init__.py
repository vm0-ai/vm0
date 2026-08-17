"""Per-provider usage reporting modules.

Model-provider responses route through :mod:`.model_provider` after a
provider-specific extractor normalizes API usage fields into shared
``usage_event`` categories. Connector billing routes through per-connector
registrations under :mod:`.connectors`. Each registration combines a reporter
with optional focused response-inspection behavior; those capabilities may be
implemented in separate modules.
"""
