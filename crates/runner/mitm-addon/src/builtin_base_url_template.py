"""Analyze value-independent layout for built-in firewall base URL templates."""

from dataclasses import dataclass
from typing import Literal, NamedTuple

import connector_template_syntax

BaseUrlTemplateComponentKind = Literal[
    "whole-base",
    "whole-authority",
    "authority-fragment",
    "port",
    "path",
]
AuthorityFragmentShape = Literal["hostname", "ip-literal"]


class BaseUrlTemplateLayoutError(ValueError):
    """A base URL template reference has invalid syntax or placement."""


@dataclass(frozen=True, slots=True)
class BaseUrlTemplateVariable:
    reference: connector_template_syntax.SimpleTemplateReference
    kind: BaseUrlTemplateComponentKind
    authority_fragment_shape: AuthorityFragmentShape | None


class _BaseUrlComponentBoundaries(NamedTuple):
    authority_start: int | None
    authority_end: int | None
    path_start: int | None
    query_or_fragment_start: int | None
    userinfo_end: int | None
    ip_literal_start: int | None
    ip_literal_end: int | None
    port_delimiter: int | None


def analyze_base_url_template(base: str) -> tuple[BaseUrlTemplateVariable, ...]:
    """Return simple ``vars`` references with their canonical URL component kinds."""
    references_by_start = {
        reference.start: reference
        for reference in connector_template_syntax.iter_simple_references(base)
    }
    boundaries = _component_boundaries(base)
    variables: list[BaseUrlTemplateVariable] = []
    search_start = 0
    while True:
        start = base.find("${{", search_start)
        if start == -1:
            return tuple(variables)

        content_start = start + len("${{")
        end = base.find("}}", content_start)
        if end == -1:
            raise BaseUrlTemplateLayoutError("base template is unterminated")
        template_end = end + len("}}")
        reference = references_by_start.get(start)
        if reference is None or reference.end != template_end:
            raise BaseUrlTemplateLayoutError("base template variable is invalid")
        if reference.namespace != "vars":
            raise BaseUrlTemplateLayoutError("base template must use vars")

        kind = _component_kind(base, reference, boundaries)
        authority_fragment_shape: AuthorityFragmentShape | None = None
        if kind == "authority-fragment":
            authority_fragment_shape = (
                "ip-literal"
                if _reference_is_inside_ip_literal(reference, boundaries)
                else "hostname"
            )
        variables.append(
            BaseUrlTemplateVariable(
                reference=reference,
                kind=kind,
                authority_fragment_shape=authority_fragment_shape,
            )
        )
        search_start = template_end


def _component_boundaries(base: str) -> _BaseUrlComponentBoundaries:
    scheme_delimiter = base.find("://")
    if scheme_delimiter == -1:
        return _BaseUrlComponentBoundaries(None, None, None, None, None, None, None, None)

    authority_start = scheme_delimiter + len("://")
    path_start = base.find("/", authority_start)
    query_start = base.find("?", authority_start)
    fragment_start = base.find("#", authority_start)
    query_or_fragment_start = min(
        (index for index in (query_start, fragment_start) if index != -1),
        default=None,
    )
    normalized_path_start = None if path_start == -1 else path_start
    authority_end = min(
        (
            boundary
            for boundary in (normalized_path_start, query_or_fragment_start)
            if boundary is not None
        ),
        default=len(base),
    )
    raw_userinfo_end = base.rfind("@", authority_start, authority_end)
    userinfo_end = None if raw_userinfo_end == -1 else raw_userinfo_end
    host_start = authority_start if userinfo_end is None else userinfo_end + 1
    raw_ip_literal_start = base.find("[", host_start, authority_end)
    ip_literal_start = None if raw_ip_literal_start == -1 else raw_ip_literal_start
    raw_ip_literal_end = (
        -1 if ip_literal_start is None else base.find("]", ip_literal_start + 1, authority_end)
    )
    ip_literal_end = None if raw_ip_literal_end == -1 else raw_ip_literal_end
    if ip_literal_start is None:
        port_search_start = host_start
    elif ip_literal_end is None:
        port_search_start = authority_end
    else:
        port_search_start = ip_literal_end + 1
    raw_port_delimiter = base.find(":", port_search_start, authority_end)
    port_delimiter = None if raw_port_delimiter == -1 else raw_port_delimiter
    return _BaseUrlComponentBoundaries(
        authority_start=authority_start,
        authority_end=authority_end,
        path_start=normalized_path_start,
        query_or_fragment_start=query_or_fragment_start,
        userinfo_end=userinfo_end,
        ip_literal_start=ip_literal_start,
        ip_literal_end=ip_literal_end,
        port_delimiter=port_delimiter,
    )


def _component_kind(
    base: str,
    reference: connector_template_syntax.SimpleTemplateReference,
    boundaries: _BaseUrlComponentBoundaries,
) -> BaseUrlTemplateComponentKind:
    ends_base_or_starts_path = reference.end == len(base) or base.startswith("/", reference.end)

    if reference.start == 0 and ends_base_or_starts_path:
        return "whole-base"
    if base.endswith("://", 0, reference.start) and ends_base_or_starts_path:
        return "whole-authority"
    if _reference_is_inside_authority(reference, boundaries):
        if _reference_is_inside_userinfo(reference, boundaries):
            raise BaseUrlTemplateLayoutError(
                "base template variable is used in an unsupported position"
            )
        if _reference_is_inside_port(reference, boundaries):
            return "port"
        return "authority-fragment"
    if _reference_is_inside_path(reference, boundaries):
        return "path"
    raise BaseUrlTemplateLayoutError("base template variable is used in an unsupported position")


def _reference_is_inside_authority(
    reference: connector_template_syntax.SimpleTemplateReference,
    boundaries: _BaseUrlComponentBoundaries,
) -> bool:
    return (
        boundaries.authority_start is not None
        and boundaries.authority_end is not None
        and boundaries.authority_start <= reference.start < boundaries.authority_end
    )


def _reference_is_inside_userinfo(
    reference: connector_template_syntax.SimpleTemplateReference,
    boundaries: _BaseUrlComponentBoundaries,
) -> bool:
    return boundaries.userinfo_end is not None and reference.start < boundaries.userinfo_end


def _reference_is_inside_port(
    reference: connector_template_syntax.SimpleTemplateReference,
    boundaries: _BaseUrlComponentBoundaries,
) -> bool:
    return boundaries.port_delimiter is not None and boundaries.port_delimiter < reference.start


def _reference_is_inside_ip_literal(
    reference: connector_template_syntax.SimpleTemplateReference,
    boundaries: _BaseUrlComponentBoundaries,
) -> bool:
    return (
        boundaries.ip_literal_start is not None
        and boundaries.ip_literal_end is not None
        and boundaries.ip_literal_start < reference.start < boundaries.ip_literal_end
    )


def _reference_is_inside_path(
    reference: connector_template_syntax.SimpleTemplateReference,
    boundaries: _BaseUrlComponentBoundaries,
) -> bool:
    return (
        boundaries.path_start is not None
        and boundaries.path_start < reference.start
        and (
            boundaries.query_or_fragment_start is None
            or reference.start <= boundaries.query_or_fragment_start
        )
    )
