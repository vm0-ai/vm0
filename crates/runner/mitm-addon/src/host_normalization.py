"""Shared hostname normalization helpers."""

from unicodedata import bidirectional, category, normalize

_ASCII_MAX = 0x7F
_IPV4_MAX_OCTET = 255
_IPV4_HEX_PREFIX_LENGTH = 2
_IPV4_MIN_PARTS = 1
_IPV4_PART_COUNT = 4
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
_UNICODE_MARK_CATEGORY_PREFIX = "M"
_BIDI_ARABIC_NUMBER = "AN"
_BIDI_EUROPEAN_NUMBER = "EN"
_BIDI_LEFT_TO_RIGHT = "L"
_BIDI_NONSPACING_MARK = "NSM"
_BIDI_RTL_CLASSES = frozenset(("R", "AL"))
_BIDI_RTL_ALLOWED_CLASSES = frozenset(
    (
        "R",
        "AL",
        _BIDI_ARABIC_NUMBER,
        _BIDI_EUROPEAN_NUMBER,
        "ES",
        "CS",
        "ET",
        "ON",
        "BN",
        _BIDI_NONSPACING_MARK,
    )
)
_BIDI_RTL_END_CLASSES = _BIDI_RTL_CLASSES | frozenset((_BIDI_ARABIC_NUMBER, _BIDI_EUROPEAN_NUMBER))
_BIDI_ARABIC_NUMBER_END_CLASSES = _BIDI_RTL_CLASSES | frozenset((_BIDI_ARABIC_NUMBER,))
_FORBIDDEN_NORMALIZED_LABEL_CHARS = frozenset("#%,/:<>?@[\\]^|[]")
_FORBIDDEN_NORMALIZED_LABEL_DOTS = frozenset(".\u3002\uff0e\uff61")
_GREEK_CAPITAL_SIGMA = "\u03a3"
_GREEK_COMBINING_YPOGEGRAMMENI = "\u0345"
_GREEK_SMALL_IOTA = "\u03b9"
_GREEK_SMALL_SIGMA = "\u03c3"
_GREEK_MATHEMATICAL_FINAL_SIGMA_TRANSLATION = str.maketrans(
    {
        "\U0001d6d3": _GREEK_SMALL_SIGMA,
        "\U0001d70d": _GREEK_SMALL_SIGMA,
        "\U0001d747": _GREEK_SMALL_SIGMA,
        "\U0001d781": _GREEK_SMALL_SIGMA,
        "\U0001d7bb": _GREEK_SMALL_SIGMA,
    }
)
_GREEK_PRECOMPOSED_IOTA_SUBSCRIPT_TRANSLATION = str.maketrans(
    {
        char: normalize("NFKD", char).replace(_GREEK_COMBINING_YPOGEGRAMMENI, _GREEK_SMALL_IOTA)
        for char in (chr(codepoint) for codepoint in (0x037A, *range(0x1F00, 0x2000)))
        if _GREEK_COMBINING_YPOGEGRAMMENI in normalize("NFKD", char)
    }
)
_CHEROKEE_UPPER_START = 0x13A0
_CHEROKEE_UPPER_END = 0x13FF
_CHEROKEE_SMALL_START = 0xAB70
_CHEROKEE_SMALL_END = 0xABBF
_CYRILLIC_EXTENDED_C_START = 0x1C80
_CYRILLIC_EXTENDED_C_END = 0x1C88
_UNSAFE_UTS46_COLLISION_CHARS = frozenset(
    (
        "\u03f2",  # Greek lunate sigma symbol maps like sigma under UTS46.
        "\u04c0",  # Uppercase palochka lowercases to a distinct valid label.
        "\u1e9e",  # Latin capital sharp S maps to "ss" under UTS46.
        "\u1806",  # Rejected by WHATWG; punycode would otherwise be stable.
        "\u2132",  # Lowercases to U+214E, which WHATWG treats as distinct.
        "\u2183",  # Lowercases to U+2184, which WHATWG treats as distinct.
        "\u3164",  # Rejected Hangul filler that aliases other filler labels.
        "\uffa0",  # Rejected halfwidth Hangul filler alias.
        "\ufffc",  # Object replacement character is not a valid domain label.
        "\ufffd",  # Replacement character is not a valid domain label.
        "\U0002f868",  # Rejected CJK compatibility ideograph alias.
        "\U0002f874",  # Rejected CJK compatibility ideograph alias.
        "\U0002f91f",  # Rejected CJK compatibility ideograph alias.
        "\U0002f95f",  # Rejected CJK compatibility ideograph alias.
        "\U0002f9bf",  # Rejected CJK compatibility ideograph alias.
    )
)
_UNSAFE_UTS46_COLLISION_RANGES = (
    (0x10A0, 0x10C5),  # Georgian capitals are rejected; lowercase aliases are valid.
    (0x115F, 0x1160),  # Hangul fillers rejected by WHATWG.
    (0x17B4, 0x17B5),  # Khmer inherent vowels are invalid IDNA label characters.
    (0x2FF0, 0x2FFB),  # Ideographic description chars rejected by WHATWG.
)
_UNSAFE_UTS46_IGNORABLE_RANGES = (
    (0x034F, 0x034F),
    (0x180B, 0x180D),
    (0x180F, 0x180F),
    (0xFE00, 0xFE0F),
    (0xE0100, 0xE01EF),
)


def _is_ascii(value: str) -> bool:
    return all(ord(char) <= _ASCII_MAX for char in value)


def _is_ipv4_number_component(value: str) -> bool:
    if not value:
        return False
    if value.lower().startswith("0x"):
        return len(value) > _IPV4_HEX_PREFIX_LENGTH and all(
            char in "0123456789abcdefABCDEF" for char in value[_IPV4_HEX_PREFIX_LENGTH:]
        )
    return all("0" <= char <= "9" for char in value)


def _is_ipv4_literal_like(value: str) -> bool:
    parts = value.split(".")
    return _IPV4_MIN_PARTS <= len(parts) <= _IPV4_PART_COUNT and all(
        _is_ipv4_number_component(part) for part in parts
    )


def _is_canonical_ipv4_address(value: str) -> bool:
    parts = value.split(".")
    if len(parts) != _IPV4_PART_COUNT:
        return False
    for part in parts:
        if not part.isdigit():
            return False
        if len(part) > 1 and part.startswith("0"):
            return False
        if int(part) > _IPV4_MAX_OCTET:
            return False
    return True


def _strip_optional_ascii_trailing_dot(value: str) -> str:
    return value[:-1] if value.endswith(".") else value


def _has_unicode_control_chars(value: str) -> bool:
    return any(category(char).startswith(_UNICODE_CONTROL_CATEGORY_PREFIX) for char in value)


def _normalize_hostname_dots(host: str) -> str:
    normalized = host.translate(_IDNA_DOT_TRANSLATION)
    if normalized.endswith("."):
        normalized = normalized[:-1]
        if not normalized or normalized.endswith("."):
            raise UnicodeError("empty IDNA label")
    return normalized


def _effective_bidi_class_at_label_end(value: str) -> str:
    for char in reversed(value):
        char_bidi = bidirectional(char)
        if char_bidi != _BIDI_NONSPACING_MARK:
            return char_bidi
    return bidirectional(value[-1])


def _first_effective_bidi_class(value: tuple[str, ...]) -> str | None:
    for char_bidi in value:
        if char_bidi != _BIDI_NONSPACING_MARK:
            return char_bidi
    return None


def _has_unsafe_uts46_mapping_chars(value: str) -> bool:
    for char in value:
        if char in _UNSAFE_UTS46_COLLISION_CHARS:
            return True
        codepoint = ord(char)
        for start, end in _UNSAFE_UTS46_COLLISION_RANGES:
            if start <= codepoint <= end:
                return True
        for start, end in _UNSAFE_UTS46_IGNORABLE_RANGES:
            if start <= codepoint <= end:
                return True
    return False


def _normalize_label_text(label: str) -> str:
    remapped = label.translate(_GREEK_MATHEMATICAL_FINAL_SIGMA_TRANSLATION).translate(
        _GREEK_PRECOMPOSED_IOTA_SUBSCRIPT_TRANSLATION
    )
    normalized = normalize(
        "NFKD",
        remapped.replace(
            _GREEK_COMBINING_YPOGEGRAMMENI,
            _GREEK_SMALL_IOTA,
        ),
    )
    normalized = normalize("NFC", normalized)
    chars: list[str] = []
    for char in normalized:
        codepoint = ord(char)
        if (
            _CHEROKEE_UPPER_START <= codepoint <= _CHEROKEE_UPPER_END
            or _CHEROKEE_SMALL_START <= codepoint <= _CHEROKEE_SMALL_END
        ):
            chars.append(char.upper())
        elif _CYRILLIC_EXTENDED_C_START <= codepoint <= _CYRILLIC_EXTENDED_C_END:
            chars.append(char.casefold())
        elif char == _GREEK_CAPITAL_SIGMA:
            chars.append(_GREEK_SMALL_SIGMA)
        else:
            chars.append(char.lower())
    return "".join(chars)


def _validate_normalized_label_bidi(normalized_label: str) -> None:
    label_bidi_classes = tuple(bidirectional(char) for char in normalized_label)

    first_label_bidi = _first_effective_bidi_class(label_bidi_classes)
    if first_label_bidi == _BIDI_ARABIC_NUMBER:
        if _BIDI_LEFT_TO_RIGHT in label_bidi_classes:
            raise UnicodeError("invalid IDNA label")
        if _BIDI_EUROPEAN_NUMBER in label_bidi_classes:
            raise UnicodeError("invalid IDNA label")
        if (
            _effective_bidi_class_at_label_end(normalized_label)
            not in _BIDI_ARABIC_NUMBER_END_CLASSES
        ):
            raise UnicodeError("invalid IDNA label")

    first_rtl_index = next(
        (
            index
            for index, char_bidi in enumerate(label_bidi_classes)
            if char_bidi in _BIDI_RTL_CLASSES
        ),
        None,
    )
    if first_rtl_index is None:
        if _BIDI_ARABIC_NUMBER in label_bidi_classes:
            if _BIDI_LEFT_TO_RIGHT not in label_bidi_classes:
                if _BIDI_EUROPEAN_NUMBER in label_bidi_classes:
                    raise UnicodeError("invalid IDNA label")
                if _effective_bidi_class_at_label_end(normalized_label) != _BIDI_ARABIC_NUMBER:
                    raise UnicodeError("invalid IDNA label")
                return

            if first_label_bidi != _BIDI_LEFT_TO_RIGHT:
                raise UnicodeError("invalid IDNA label")
            arabic_number_indexes = tuple(
                index
                for index, char_bidi in enumerate(label_bidi_classes)
                if char_bidi == _BIDI_ARABIC_NUMBER
            )
            if len(arabic_number_indexes) != 1:
                raise UnicodeError("invalid IDNA label")
            if any(
                char_bidi != _BIDI_NONSPACING_MARK
                for char_bidi in label_bidi_classes[arabic_number_indexes[0] + 1 :]
            ):
                raise UnicodeError("invalid IDNA label")
        return

    if _BIDI_ARABIC_NUMBER in label_bidi_classes and _BIDI_EUROPEAN_NUMBER in label_bidi_classes:
        raise UnicodeError("invalid IDNA label")

    if first_rtl_index > 0:
        prefix_bidi_classes = label_bidi_classes[:first_rtl_index]
        suffix_bidi_classes = label_bidi_classes[first_rtl_index + 1 :]
        first_prefix_bidi = _first_effective_bidi_class(prefix_bidi_classes)
        if _BIDI_LEFT_TO_RIGHT in prefix_bidi_classes:
            if _BIDI_ARABIC_NUMBER in prefix_bidi_classes:
                raise UnicodeError("invalid IDNA label")
            if first_prefix_bidi != _BIDI_LEFT_TO_RIGHT:
                raise UnicodeError("invalid IDNA label")
            if any(char_bidi != _BIDI_NONSPACING_MARK for char_bidi in suffix_bidi_classes):
                raise UnicodeError("invalid IDNA label")
            return

        if _BIDI_LEFT_TO_RIGHT in suffix_bidi_classes:
            raise UnicodeError("invalid IDNA label")
        if set(label_bidi_classes) <= _BIDI_RTL_ALLOWED_CLASSES and (
            _effective_bidi_class_at_label_end(normalized_label) in _BIDI_RTL_END_CLASSES
        ):
            return
        raise UnicodeError("invalid IDNA label")

    bidi_classes = set(label_bidi_classes)
    if not bidi_classes <= _BIDI_RTL_ALLOWED_CLASSES:
        raise UnicodeError("invalid IDNA label")
    if _effective_bidi_class_at_label_end(normalized_label) not in _BIDI_RTL_END_CLASSES:
        raise UnicodeError("invalid IDNA label")


def _validate_normalized_label_text(normalized_label: str) -> None:
    if not normalized_label or any(
        char in _FORBIDDEN_NORMALIZED_LABEL_DOTS for char in normalized_label
    ):
        raise UnicodeError("invalid IDNA label")
    if category(normalized_label[0]).startswith(_UNICODE_MARK_CATEGORY_PREFIX):
        raise UnicodeError("invalid IDNA label")
    if any(char.isspace() for char in normalized_label):
        raise UnicodeError("invalid IDNA label")
    if any(char in _FORBIDDEN_NORMALIZED_LABEL_CHARS for char in normalized_label):
        raise UnicodeError("invalid IDNA label")
    if _has_unicode_control_chars(normalized_label):
        raise UnicodeError("invalid IDNA label")
    _validate_normalized_label_bidi(normalized_label)


def _canonical_punycode_label(label: str) -> str:
    if _has_unsafe_uts46_mapping_chars(label):
        raise UnicodeError("unsafe IDNA compatibility mapping")
    normalized_label = _normalize_label_text(label)
    _validate_normalized_label_text(normalized_label)

    try:
        payload = normalized_label.encode("punycode").decode("ascii").lower()
    except UnicodeError as exc:
        raise UnicodeError("invalid IDNA label") from exc
    if not payload:
        raise UnicodeError("invalid IDNA label")
    return f"{_PUNYCODE_PREFIX}{payload}"


def _encode_unicode_label(label: str) -> str:
    normalized_label = _normalize_label_text(label)
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
    normalized_label = _normalize_label_text(label)
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
    normalized = _normalize_hostname_dots(host)
    if not normalized:
        raise ValueError("empty hostname")
    if _is_ipv4_literal_like(normalized):
        if _strip_optional_ascii_trailing_dot(host) != normalized or not _is_canonical_ipv4_address(
            normalized
        ):
            raise UnicodeError("non-canonical IPv4 address")
        return normalized

    return ".".join(_normalize_label(label) for label in normalized.split("."))
