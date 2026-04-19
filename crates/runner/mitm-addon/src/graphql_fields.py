"""Extract field selection paths from GraphQL query strings.

Two-layer design referencing graphql-core:
  1. **Lexer** — tokenizes the raw string into a stream of typed tokens,
     handling strings, block strings, comments, and whitespace in one place.
  2. **Parser** — recursive-descent over the token stream using ``peek()``
     and ``advance()``, never touching raw characters.

Only implements what firewall field matching needs: operation header
skipping and selection-set field path extraction with nesting.

Example::

    query {
      repository(owner: "x", name: "y") {
        issues(first: 10) { nodes { title } }
      }
    }

Extracts::

    ["repository", "repository.issues", "repository.issues.nodes",
     "repository.issues.nodes.title"]
"""

from __future__ import annotations

from enum import Enum, auto

# ═══════════════════════════════════════════════════════════════════════════
# Token types
# ═══════════════════════════════════════════════════════════════════════════


class T(Enum):
    """Token kinds (subset of GraphQL tokens needed for field extraction)."""

    NAME = auto()
    BRACE_L = auto()  # {
    BRACE_R = auto()  # }
    PAREN_L = auto()  # (
    COLON = auto()  # :
    SPREAD = auto()  # ...
    AT = auto()  # @
    EOF = auto()


class Token:
    """A single lexed token."""

    __slots__ = ("kind", "value")

    def __init__(self, kind: T, value: str = "") -> None:
        self.kind = kind
        self.value = value

    def __repr__(self) -> str:
        if self.value:
            return f"Token({self.kind.name}, {self.value!r})"
        return f"Token({self.kind.name})"


_EOF_TOKEN = Token(T.EOF)


# ═══════════════════════════════════════════════════════════════════════════
# Lexer
# ═══════════════════════════════════════════════════════════════════════════


class Lexer:
    """Tokenize a GraphQL source string.

    Produces tokens consumed by the parser.  Strings, block strings,
    comments, whitespace, and commas are handled here so the parser
    never sees raw characters.
    """

    __slots__ = ("length", "pos", "src")

    def __init__(self, source: str) -> None:
        self.src = source
        self.pos = 0
        self.length = len(source)

    # -- public interface --------------------------------------------------

    def next_token(self) -> Token:
        """Return the next meaningful token, or EOF."""
        while True:
            self._skip_ignored()

            if self.pos >= self.length:
                return _EOF_TOKEN

            c = self.src[self.pos]

            if c == "{":
                self.pos += 1
                return Token(T.BRACE_L)
            if c == "}":
                self.pos += 1
                return Token(T.BRACE_R)
            if c == "(":
                self.pos += 1
                return Token(T.PAREN_L)
            if c == ":":
                self.pos += 1
                return Token(T.COLON)
            if c == "@":
                self.pos += 1
                return Token(T.AT)
            if (
                c == "."
                and self.pos + 2 < self.length
                and self.src[self.pos + 1] == "."
                and self.src[self.pos + 2] == "."
            ):
                self.pos += 3
                return Token(T.SPREAD)
            if c == "_" or c.isalpha():
                return self._read_name()

            # Unexpected character — skip and loop (not recurse,
            # to avoid stack overflow on long runs of unknown characters).
            self.pos += 1

    # -- private helpers ---------------------------------------------------

    def _skip_ignored(self) -> None:
        """Skip whitespace, commas, and comments (insignificant tokens)."""
        src = self.src
        pos = self.pos
        length = self.length
        while pos < length:
            c = src[pos]
            # Whitespace, comma, BOM
            if c in (" ", "\t", "\n", "\r", ",", "\ufeff"):
                pos += 1
            # Comment
            elif c == "#":
                pos += 1
                while pos < length and src[pos] != "\n":
                    pos += 1
            else:
                break
        self.pos = pos

    def _read_name(self) -> Token:
        src = self.src
        start = self.pos
        pos = start + 1
        length = self.length
        while pos < length:
            c = src[pos]
            if c == "_" or c.isalnum():
                pos += 1
            else:
                break
        self.pos = pos
        return Token(T.NAME, src[start:pos])

    def skip_balanced_parens(self) -> None:
        """Advance past the rest of a ``(...)`` block.

        Must be called when lexer.pos is right after the opening ``(``
        (i.e., the ``(`` character has been consumed by ``next_token``
        producing a PAREN_L, but ``_advance`` has NOT been called yet).
        """
        depth = 1
        src = self.src
        pos = self.pos
        length = self.length
        while pos < length and depth > 0:
            c = src[pos]
            if c == "(":
                depth += 1
                pos += 1
            elif c == ")":
                depth -= 1
                pos += 1
            elif c == '"':
                pos = self._skip_string_from(pos)
            elif c == "#":
                pos += 1
                while pos < length and src[pos] != "\n":
                    pos += 1
            else:
                pos += 1
        self.pos = pos

    def _skip_string_from(self, pos: int) -> int:
        """Skip a string literal starting at *pos*."""
        src = self.src
        length = self.length
        # Block string: the only escape sequence is \""" → literal """
        if pos + 2 < length and src[pos + 1] == '"' and src[pos + 2] == '"':
            pos += 3
            while pos < length:
                if (
                    src[pos] == "\\"
                    and pos + 3 < length
                    and src[pos + 1] == '"'
                    and src[pos + 2] == '"'
                    and src[pos + 3] == '"'
                ):
                    pos += 4  # skip \"""
                elif (
                    pos + 2 < length
                    and src[pos] == '"'
                    and src[pos + 1] == '"'
                    and src[pos + 2] == '"'
                ):
                    return pos + 3
                else:
                    pos += 1
            return pos
        # Regular string
        pos += 1
        while pos < length:
            c = src[pos]
            if c == "\\":
                pos += 2
            elif c == '"':
                return pos + 1
            else:
                pos += 1
        return pos


# ═══════════════════════════════════════════════════════════════════════════
# Parser
# ═══════════════════════════════════════════════════════════════════════════


class Parser:
    """Recursive-descent parser that extracts field selection paths.

    Operates on a token stream from :class:`Lexer`, never on raw characters.
    """

    def __init__(self, lexer: Lexer) -> None:
        self._lexer = lexer
        self._token = lexer.next_token()
        self.paths: list[str] = []

    # -- token helpers -----------------------------------------------------

    def _peek(self) -> T:
        return self._token.kind

    def _advance(self) -> Token:
        """Consume and return the current token, then read the next one."""
        tok = self._token
        self._token = self._lexer.next_token()
        return tok

    def _expect(self, kind: T) -> Token:
        """Consume the current token if it matches *kind*, else skip."""
        if self._token.kind == kind:
            return self._advance()
        # Recovery: return a synthetic token so the caller can continue.
        return Token(kind)

    # -- grammar -----------------------------------------------------------

    def parse(self) -> list[str]:
        """Entry point: skip operation header, parse selection set."""
        self._skip_operation_header()
        if self._peek() == T.BRACE_L:
            self._parse_selection_set("")
        return self.paths

    def _skip_operation_header(self) -> None:
        """Skip ``query/mutation/subscription [Name] [(vars)] [@directives]``."""
        if self._peek() == T.BRACE_L:
            return  # shorthand query
        if self._peek() != T.NAME:
            return

        keyword = self._token.value
        if keyword not in ("query", "mutation", "subscription"):
            return
        self._advance()  # consume keyword

        # Optional operation name
        if self._peek() == T.NAME:
            self._advance()

        # Optional variable definitions
        if self._peek() == T.PAREN_L:
            self._lexer.skip_balanced_parens()
            self._token = self._lexer.next_token()

        # Optional directives
        self._skip_directives()

    def _skip_directives(self) -> None:
        """Skip ``@name [(args)]`` sequences."""
        while self._peek() == T.AT:
            self._advance()  # @
            if self._peek() == T.NAME:
                self._advance()  # directive name
            if self._peek() == T.PAREN_L:
                self._lexer.skip_balanced_parens()
                self._token = self._lexer.next_token()

    def _skip_arguments(self) -> None:
        """Skip ``(args)`` if present."""
        if self._peek() == T.PAREN_L:
            self._lexer.skip_balanced_parens()
            self._token = self._lexer.next_token()

    def _parse_selection_set(self, prefix: str) -> None:
        """Parse ``{ selection+ }``."""
        self._expect(T.BRACE_L)

        while self._peek() not in (T.BRACE_R, T.EOF):
            if self._peek() == T.SPREAD:
                self._parse_fragment(prefix)
            elif self._peek() == T.NAME:
                self._parse_field(prefix)
            else:
                # Unexpected token — skip to avoid infinite loop.
                self._advance()

        self._expect(T.BRACE_R)

    def _parse_field(self, prefix: str) -> None:
        """Parse ``[alias :] name [(args)] [@directives] [{ sub }]``."""
        name_tok = self._expect(T.NAME)
        field_name = name_tok.value

        # Alias: "alias: fieldName"
        if self._peek() == T.COLON:
            self._advance()  # :
            actual = self._expect(T.NAME)
            field_name = actual.value if actual.value else field_name

        path = f"{prefix}.{field_name}" if prefix else field_name
        self.paths.append(path)

        self._skip_arguments()
        self._skip_directives()

        if self._peek() == T.BRACE_L:
            self._parse_selection_set(path)

    def _parse_fragment(self, prefix: str) -> None:
        """Parse ``... [on Type] [directives] { selections }`` or ``... Name [directives]``."""
        self._expect(T.SPREAD)

        # Inline fragment without type condition: ... [@directives] { ... }
        if self._peek() != T.NAME:
            self._skip_directives()
            if self._peek() == T.BRACE_L:
                self._parse_selection_set(prefix)
            return

        name = self._token.value

        if name == "on":
            # Inline fragment: ... on TypeName [@directives] { selections }
            self._advance()  # "on"
            if self._peek() == T.NAME:
                self._advance()  # type name
            self._skip_directives()
            if self._peek() == T.BRACE_L:
                self._parse_selection_set(prefix)
        else:
            # Named fragment spread: ...FragmentName [@directives]
            self._advance()  # fragment name
            self._skip_directives()


# ═══════════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════════


def extract_field_paths(query_str: str) -> list[str]:
    """Extract all field selection paths from a GraphQL query string.

    Returns dot-separated paths for every field at every nesting depth.
    Handles aliases (returns actual field name, not alias), arguments,
    directives, string literals, block strings, comments, fragment spreads,
    and inline fragments.

    Never raises: returns ``[]`` on any error (fail-closed in the firewall
    security context — unparseable queries produce no field matches).
    """
    if not isinstance(query_str, str) or not query_str or query_str.isspace():
        return []
    try:
        lexer = Lexer(query_str)
        parser = Parser(lexer)
        return parser.parse()
    except Exception:
        # Fail-closed: unparseable query → no field matches → firewall blocks.
        # Catching `Exception` (not a narrower type) is deliberate — any
        # lexer/parser bug must not crash the addon on a malformed query.
        return []
