"""Shared hostname normalization helpers."""

from unicodedata import category, normalize

_ASCII_MAX = 0x7F
_DNS_LABEL_MAX_LENGTH = 63
_IDNA_DOT_TRANSLATION = str.maketrans(
    {
        "\u3002": ".",
        "\uff0e": ".",
        "\uff61": ".",
    }
)
_PUNYCODE_PREFIX = "xn--"
_UNICODE_CONTROL_CATEGORY_PREFIX = "C"
_FORBIDDEN_NORMALIZED_LABEL_CHARS = frozenset("#%,/:<>?@[\\]^|[]")


def _is_ascii(value: str) -> bool:
    return all(ord(char) <= _ASCII_MAX for char in value)


def _has_unicode_control_chars(value: str) -> bool:
    return any(category(char).startswith(_UNICODE_CONTROL_CATEGORY_PREFIX) for char in value)


def _validate_normalized_label_text(normalized_label: str) -> None:
    if not normalized_label or "." in normalized_label:
        raise UnicodeError("invalid IDNA label")
    if any(char in _FORBIDDEN_NORMALIZED_LABEL_CHARS for char in normalized_label):
        raise UnicodeError("invalid IDNA label")
    if _has_unicode_control_chars(normalized_label):
        raise UnicodeError("invalid IDNA label")


def _canonical_punycode_label(label: str) -> str:
    normalized_label = normalize("NFKC", label).lower()
    _validate_normalized_label_text(normalized_label)

    try:
        payload = normalized_label.encode("punycode").decode("ascii").lower()
    except UnicodeError as exc:
        raise UnicodeError("invalid IDNA label") from exc
    if not payload:
        raise UnicodeError("invalid IDNA label")
    return f"{_PUNYCODE_PREFIX}{payload}"


def _encode_unicode_label(label: str) -> str:
    normalized_label = normalize("NFKC", label).lower()
    if _is_ascii(normalized_label):
        raise UnicodeError("unsafe IDNA compatibility mapping")
    return _canonical_punycode_label(label)


def _is_valid_alabel(label: str) -> bool:
    if not label.startswith(_PUNYCODE_PREFIX):
        return True

    payload = label[len(_PUNYCODE_PREFIX) :]
    if not payload:
        return False

    try:
        decoded = payload.encode("ascii").decode("punycode")
    except UnicodeError:
        return False
    if not decoded:
        return False

    try:
        canonical_label = _canonical_punycode_label(decoded)
    except UnicodeError:
        return False
    return canonical_label == label


def _has_invalid_alabel(ascii_host: str) -> bool:
    return any(not _is_valid_alabel(label) for label in ascii_host.split("."))


def _normalize_label(label: str) -> str:
    if not label:
        raise UnicodeError("empty IDNA label")
    normalized_label = normalize("NFKC", label).lower()
    _validate_normalized_label_text(normalized_label)
    ascii_label = label.lower() if _is_ascii(label) else _encode_unicode_label(label)
    if len(ascii_label) > _DNS_LABEL_MAX_LENGTH:
        raise UnicodeError("IDNA label too long")
    if not _is_valid_alabel(ascii_label):
        raise UnicodeError("invalid IDNA A-label")
    return ascii_label


def normalize_idna_hostname(host: str) -> str:
    """Normalize hostnames without accepting ASCII-only compatibility aliases.

    Python's built-in codec is IDNA2003 and maps labels such as ``faß`` to
    ``fass``.  WHATWG URL parsing keeps those as A-labels instead, so encode
    non-ASCII labels directly and reject compatibility folds that collapse to a
    plain ASCII label such as fullwidth Latin text.
    """
    normalized = host.translate(_IDNA_DOT_TRANSLATION).rstrip(".")
    if not normalized:
        raise ValueError("empty hostname")

    return ".".join(_normalize_label(label) for label in normalized.split("."))
