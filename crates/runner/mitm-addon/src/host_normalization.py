"""Shared hostname normalization helpers."""

_ASCII_MAX = 0x7F
_IDNA_DOT_TRANSLATION = str.maketrans(
    {
        "\u3002": ".",
        "\uff0e": ".",
        "\uff61": ".",
    }
)
_PUNYCODE_PREFIX = "xn--"


def _label_contains_non_ascii(label: str) -> bool:
    return any(ord(char) > _ASCII_MAX for char in label)


def _has_unsafe_idna_compat_mapping(source_host: str, ascii_host: str) -> bool:
    source_labels = source_host.translate(_IDNA_DOT_TRANSLATION).split(".")
    ascii_labels = ascii_host.split(".")
    if len(source_labels) != len(ascii_labels):
        return True

    return any(
        _label_contains_non_ascii(source_label) and not ascii_label.startswith(_PUNYCODE_PREFIX)
        for source_label, ascii_label in zip(source_labels, ascii_labels, strict=True)
    )


def normalize_idna_hostname(host: str) -> str:
    """Normalize hostnames without accepting IDNA2003 ASCII aliases.

    Python's built-in codec maps some Unicode labels onto plain ASCII labels
    (for example ``faß`` -> ``fass``).  WHATWG URL parsing does not treat those
    labels as the same authority, so reject that compatibility fold instead of
    letting firewall/auth matching widen to a different host.
    """
    normalized = host.rstrip(".").lower()
    if not normalized:
        raise ValueError("empty hostname")

    try:
        ascii_host = normalized.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise UnicodeError("invalid IDNA hostname") from exc

    if _has_unsafe_idna_compat_mapping(normalized, ascii_host):
        raise UnicodeError("unsafe IDNA compatibility mapping")

    return ascii_host
