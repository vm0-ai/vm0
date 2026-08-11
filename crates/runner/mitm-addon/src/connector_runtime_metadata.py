"""Private connector-candidate metadata shared by registry resolution and matching."""

from typing import Literal

type ConnectorRuntimeKind = Literal["builtin", "custom"]

CONNECTOR_RUNTIME_KIND_MARKER = "_vm0ConnectorRuntimeKind"


def connector_runtime_kind(firewall: dict) -> ConnectorRuntimeKind | None:
    """Return a trusted internal candidate kind, if registry resolution assigned one."""
    value = firewall.get(CONNECTOR_RUNTIME_KIND_MARKER)
    return value if value in ("builtin", "custom") else None


def clear_connector_runtime_kind(firewall: dict) -> None:
    """Remove untrusted source metadata before registry-owned classification."""
    firewall.pop(CONNECTOR_RUNTIME_KIND_MARKER, None)


def mark_connector_runtime_kind(firewall: dict, kind: ConnectorRuntimeKind) -> None:
    """Mark a resolved firewall as a registered connector runtime candidate."""
    firewall[CONNECTOR_RUNTIME_KIND_MARKER] = kind
