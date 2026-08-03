"""Simple connector-template reference syntax shared by runner consumers."""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Final, Literal

TemplateReferenceNamespace = Literal["secrets", "vars"]

# Keep this character class aligned with JavaScript regular-expression ``\s``
# in the TypeScript connector contract. Python ``\s`` has different semantics.
_ECMASCRIPT_WHITESPACE: Final = (
    r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a"
    r"\u2028\u2029\u202f\u205f\u3000\ufeff]"
)
_SIMPLE_REFERENCE_PATTERN: Final = re.compile(
    r"\$\{\{"
    rf"{_ECMASCRIPT_WHITESPACE}*"
    r"(?P<namespace>secrets|vars)\."
    r"(?P<name>[a-zA-Z_][a-zA-Z0-9_]*)"
    rf"{_ECMASCRIPT_WHITESPACE}*"
    r"\}\}"
)


@dataclass(frozen=True, slots=True)
class SimpleTemplateReference:
    namespace: TemplateReferenceNamespace
    name: str
    start: int
    end: int


def iter_simple_references(value: str) -> Iterator[SimpleTemplateReference]:
    """Yield simple secret and variable references in source order."""
    for match in _SIMPLE_REFERENCE_PATTERN.finditer(value):
        raw_namespace = match.group("namespace")
        namespace: TemplateReferenceNamespace = "secrets" if raw_namespace == "secrets" else "vars"
        yield SimpleTemplateReference(
            namespace=namespace,
            name=match.group("name"),
            start=match.start(),
            end=match.end(),
        )
