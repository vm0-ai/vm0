"""Shared hostname identity policy tests."""

from unittest.mock import patch

import pytest

import host_normalization
from host_normalization import normalize_idna_hostname, normalize_idna_label


def test_ascii_hostname_bypasses_unicode_pipeline():
    with (
        patch.object(
            host_normalization,
            "normalize",
            wraps=host_normalization.normalize,
        ) as unicode_normalize,
        patch.object(
            host_normalization,
            "category",
            wraps=host_normalization.category,
        ) as unicode_category,
        patch.object(
            host_normalization,
            "bidirectional",
            wraps=host_normalization.bidirectional,
        ) as unicode_bidirectional,
    ):
        normalized = normalize_idna_hostname("API.GITHUB.COM")

    assert normalized == "api.github.com"
    unicode_normalize.assert_not_called()
    unicode_category.assert_not_called()
    unicode_bidirectional.assert_not_called()


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        pytest.param("API", "api", id="mixed-case"),
        pytest.param("A" * 63, "a" * 63, id="maximum-length"),
        pytest.param(
            "!\"$&'()*+-;=_`{}~",
            "!\"$&'()*+-;=_`{}~",
            id="permissive-punctuation",
        ),
        pytest.param("XN--BCHER-KVA", "xn--bcher-kva", id="canonical-alabel"),
    ],
)
def test_ascii_label_contract(label, expected):
    assert normalize_idna_label(label) == expected


@pytest.mark.parametrize(
    ("label", "expected_message"),
    [
        pytest.param("", "empty IDNA label", id="empty"),
        pytest.param(".", "invalid IDNA label", id="dot"),
        pytest.param("a#b", "invalid IDNA label", id="forbidden-punctuation"),
        pytest.param("a b", "invalid IDNA label", id="space"),
        pytest.param("a\tb", "invalid IDNA label", id="whitespace"),
        pytest.param("a\x00b", "invalid IDNA label", id="control"),
        pytest.param("a\x7fb", "invalid IDNA label", id="delete"),
        pytest.param("A" * 64, "IDNA label too long", id="over-maximum-length"),
        pytest.param("xn--a", "invalid IDNA A-label", id="invalid-alabel"),
        pytest.param("#" * 64, "invalid IDNA label", id="validation-precedes-length"),
    ],
)
def test_rejects_invalid_ascii_label(label, expected_message):
    with pytest.raises(UnicodeError) as exc_info:
        normalize_idna_label(label)

    assert type(exc_info.value) is UnicodeError
    assert str(exc_info.value) == expected_message
