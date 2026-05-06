"""Bounded selective JSON extraction.

This module intentionally does not wrap vendored ijson: its pure-Python
lexer materializes full string lexemes before emitting events.  The scanner
below keeps only selected scalars and object keys needed to resolve selected
paths, while skipping unselected values by JSON syntax.
"""

import json
from dataclasses import dataclass, field
from typing import Literal

Path = tuple[str, ...]
WildcardPath = tuple[str, ...]
ScalarKind = Literal["string", "int"]
_UNKNOWN_KEY = "\0__vm0_json_unknown_key__"
_ARRAY_ELEMENT = "\0__vm0_json_array_element__"
_INTERNAL_PATH_MARKERS = frozenset((_UNKNOWN_KEY, _ARRAY_ELEMENT))
_JSON_CONTROL_CHAR_MAX = 0x20
_UTF8_ONE_BYTE_MAX = 0x80
_UTF8_CONT_MIN = 0x80
_UTF8_CONT_MAX = 0xBF
_UTF8_TWO_BYTE_MIN = 0xC2
_UTF8_TWO_BYTE_MAX = 0xDF
_UTF8_THREE_BYTE_MIN = 0xE0
_UTF8_THREE_BYTE_MAX = 0xEF
_UTF8_FOUR_BYTE_MIN = 0xF0
_UTF8_FOUR_BYTE_MAX = 0xF4
_UTF8_MIN_TWO_BYTE_CODEPOINT = 0x80
_UTF8_MIN_THREE_BYTE_CODEPOINT = 0x800
_UTF8_MIN_FOUR_BYTE_CODEPOINT = 0x10000
_UTF8_MAX_CODEPOINT = 0x10FFFF
_UTF8_SURROGATE_MIN = 0xD800
_UTF8_SURROGATE_MAX = 0xDFFF


@dataclass(frozen=True)
class ScalarField:
    kind: ScalarKind
    max_bytes: int = 4096


@dataclass
class JsonExtractionResult:
    complete: bool
    values: dict[Path, object] = field(default_factory=dict)
    array_counts: dict[Path, int] = field(default_factory=dict)
    wildcard_array_counts: dict[WildcardPath, dict[str, int]] = field(default_factory=dict)
    object_present: set[Path] = field(default_factory=set)
    error: str | None = None


@dataclass
class _Frame:
    kind: Literal["object", "array"]
    path: Path
    state: str
    pending_key: str | None = None
    count_path: Path | None = None
    wildcard_counts: list[tuple[WildcardPath, str]] = field(default_factory=list)


@dataclass
class _StringState:
    role: Literal["key", "selected", "skip"]
    path: Path | None
    max_bytes: int
    raw: bytearray | None
    escape: bool = False
    unicode_remaining: int = 0
    utf8_remaining: int = 0
    utf8_codepoint: int = 0
    utf8_min_codepoint: int = 0


@dataclass
class _NumberState:
    path: Path
    selected: bool
    raw: bytearray | None
    max_bytes: int
    phase: str = "start"


@dataclass
class _LiteralState:
    literal: bytes
    offset: int = 0


class JsonSelectiveExtractor:
    def __init__(
        self,
        *,
        scalar_fields: dict[Path, ScalarField] | None = None,
        array_count_paths: set[Path] | None = None,
        wildcard_array_count_paths: set[WildcardPath] | None = None,
        object_presence_paths: set[Path] | None = None,
        max_depth: int = 256,
        max_key_bytes: int = 1024,
        max_number_bytes: int = 128,
        max_wildcard_keys: int = 256,
    ) -> None:
        self.scalar_fields = scalar_fields or {}
        self.array_count_paths = array_count_paths or set()
        self.wildcard_array_count_paths = wildcard_array_count_paths or set()
        for pattern in self.wildcard_array_count_paths:
            if pattern.count("*") != 1:
                raise ValueError("wildcard array count paths must contain exactly one '*'")
        self.object_presence_paths = object_presence_paths or set()
        self.max_depth = max_depth
        self.max_key_bytes = max_key_bytes
        self.max_number_bytes = max_number_bytes
        self.max_wildcard_keys = max_wildcard_keys
        self.key_collection_paths = _build_key_collection_paths(
            set(self.scalar_fields)
            | self.array_count_paths
            | self.wildcard_array_count_paths
            | self.object_presence_paths
        )

        self.values: dict[Path, object] = {}
        self.array_counts: dict[Path, int] = {}
        self.wildcard_array_counts: dict[WildcardPath, dict[str, int]] = {}
        self.object_present: set[Path] = set()

        self._stack: list[_Frame] = []
        self._root_done = False
        self._error: str | None = None
        self._string: _StringState | None = None
        self._number: _NumberState | None = None
        self._literal: _LiteralState | None = None

    def feed(self, chunk: bytes) -> None:
        if self._error:
            return
        i = 0
        while i < len(chunk) and not self._error:
            if self._string is not None:
                i = self._consume_string(chunk, i)
            elif self._number is not None:
                i = self._consume_number(chunk, i)
            elif self._literal is not None:
                i = self._consume_literal(chunk, i)
            else:
                i = self._consume_main(chunk, i)

    def finish(self) -> JsonExtractionResult:
        if not self._error and self._number is not None:
            self._finish_number()

        if not self._error:
            if self._literal is not None:
                self._error = "incomplete literal"
            elif self._string is not None:
                self._error = "incomplete string"
            elif self._stack or not self._root_done:
                self._error = "incomplete json"

        complete = self._error is None and self._root_done and not self._stack
        return JsonExtractionResult(
            complete=complete,
            values=dict(self.values) if complete else {},
            array_counts=dict(self.array_counts) if complete else {},
            wildcard_array_counts={
                pattern: dict(counts) for pattern, counts in self.wildcard_array_counts.items()
            }
            if complete
            else {},
            object_present=set(self.object_present) if complete else set(),
            error=self._error,
        )

    def _consume_main(self, chunk: bytes, i: int) -> int:
        b = chunk[i]
        if b in b" \t\r\n":
            return i + 1

        if self._root_done:
            self._error = "trailing data after root value"
            return i + 1

        if not self._stack:
            return self._start_value((), chunk, i)

        frame = self._stack[-1]
        if frame.kind == "object":
            return self._consume_object(frame, chunk, i)
        return self._consume_array(frame, chunk, i)

    def _consume_object(self, frame: _Frame, chunk: bytes, i: int) -> int:
        b = chunk[i]
        if frame.state == "key_or_end":
            if b == ord("}"):
                return self._end_container(i)
            if b != ord('"'):
                self._error = "expected object key or end"
                return i + 1
            collect_key = _matches_any_path_pattern(self.key_collection_paths, frame.path)
            self._string = _StringState(
                role="key",
                path=None,
                max_bytes=self.max_key_bytes,
                raw=bytearray() if collect_key else None,
            )
            return i + 1

        if frame.state == "colon":
            if b != ord(":"):
                self._error = "expected colon"
            else:
                frame.state = "value"
            return i + 1

        if frame.state == "value":
            if frame.pending_key is None:
                self._error = "missing object key"
                return i + 1
            value_path = (*frame.path, frame.pending_key)
            self._clear_observations_for_path(value_path)
            return self._start_value(value_path, chunk, i)

        if frame.state == "comma_or_end":
            if b == ord(","):
                frame.pending_key = None
                frame.state = "key_or_end"
            elif b == ord("}"):
                return self._end_container(i)
            else:
                self._error = "expected object comma or end"
            return i + 1

        self._error = "invalid object parser state"
        return i + 1

    def _consume_array(self, frame: _Frame, chunk: bytes, i: int) -> int:
        b = chunk[i]
        if frame.state == "value_or_end":
            if b == ord("]"):
                return self._end_container(i)
            self._count_array_element(frame)
            return self._start_value((*frame.path, _ARRAY_ELEMENT), chunk, i, from_array=True)

        if frame.state == "comma_or_end":
            if b == ord(","):
                frame.state = "value_or_end"
            elif b == ord("]"):
                return self._end_container(i)
            else:
                self._error = "expected array comma or end"
            return i + 1

        self._error = "invalid array parser state"
        return i + 1

    def _start_value(self, path: Path, chunk: bytes, i: int, *, from_array: bool = False) -> int:
        b = chunk[i]
        if b == ord("{"):
            self._start_object(path, from_array=from_array)
            return i + 1
        if b == ord("["):
            self._start_array(path)
            return i + 1
        if b == ord('"'):
            field = self.scalar_fields.get(path)
            if field and field.kind == "string":
                self._string = _StringState(
                    role="selected",
                    path=path,
                    max_bytes=field.max_bytes,
                    raw=bytearray(),
                )
            else:
                self._string = _StringState(
                    role="skip",
                    path=path,
                    max_bytes=0,
                    raw=None,
                )
            return i + 1
        if b == ord("-") or ord("0") <= b <= ord("9"):
            field = self.scalar_fields.get(path, None)
            selected = bool(field and field.kind == "int")
            self._number = _NumberState(
                path=path,
                selected=selected,
                raw=bytearray() if selected else None,
                max_bytes=min(self.max_number_bytes, field.max_bytes)
                if selected and field
                else self.max_number_bytes,
            )
            return self._consume_number(chunk, i)
        if b == ord("t"):
            self._literal = _LiteralState(b"true")
            return self._consume_literal(chunk, i)
        if b == ord("f"):
            self._literal = _LiteralState(b"false")
            return self._consume_literal(chunk, i)
        if b == ord("n"):
            self._literal = _LiteralState(b"null")
            return self._consume_literal(chunk, i)
        self._error = "expected json value"
        return i + 1

    def _start_object(self, path: Path, *, from_array: bool = False) -> None:
        if len(self._stack) >= self.max_depth:
            self._error = "max depth exceeded"
            return
        if not from_array and path in self.object_presence_paths:
            self.object_present.add(path)
        self._stack.append(_Frame(kind="object", path=path, state="key_or_end"))

    def _start_array(self, path: Path) -> None:
        if len(self._stack) >= self.max_depth:
            self._error = "max depth exceeded"
            return

        count_path = path if path in self.array_count_paths else None
        if count_path is not None:
            self.array_counts[count_path] = 0
        wildcard_counts = self._wildcard_matches(path)
        if self._error:
            return
        self._stack.append(
            _Frame(
                kind="array",
                path=path,
                state="value_or_end",
                count_path=count_path,
                wildcard_counts=wildcard_counts,
            )
        )

    def _wildcard_matches(self, path: Path) -> list[tuple[WildcardPath, str]]:
        matches = []
        for pattern in self.wildcard_array_count_paths:
            if not _path_matches_pattern(pattern, path):
                continue
            wildcard_index = pattern.index("*")
            key = path[wildcard_index]
            counts = self.wildcard_array_counts.setdefault(pattern, {})
            if key not in counts and len(counts) >= self.max_wildcard_keys:
                self._error = "max wildcard keys exceeded"
                return matches
            counts[key] = 0
            matches.append((pattern, key))
        return matches

    def _clear_observations_for_path(self, path: Path) -> None:
        self.values = {
            observed_path: value
            for observed_path, value in self.values.items()
            if not _is_path_prefix(path, observed_path)
        }
        self.array_counts = {
            observed_path: count
            for observed_path, count in self.array_counts.items()
            if not _is_path_prefix(path, observed_path)
        }
        self.object_present = {
            observed_path
            for observed_path in self.object_present
            if not _is_path_prefix(path, observed_path)
        }
        for pattern, counts in list(self.wildcard_array_counts.items()):
            self._clear_wildcard_observations_for_path(pattern, counts, path)
            if not counts:
                self.wildcard_array_counts.pop(pattern, None)

    def _clear_wildcard_observations_for_path(
        self, pattern: WildcardPath, counts: dict[str, int], path: Path
    ) -> None:
        if len(path) > len(pattern):
            return
        try:
            wildcard_index = pattern.index("*")
        except ValueError:
            counts.clear()
            return

        if not _path_prefix_matches_pattern(pattern, path):
            return

        if len(path) <= wildcard_index:
            counts.clear()
            return
        counts.pop(path[wildcard_index], None)

    def _count_array_element(self, frame: _Frame) -> None:
        if frame.count_path is not None:
            self.array_counts[frame.count_path] = self.array_counts.get(frame.count_path, 0) + 1
        for pattern, key in frame.wildcard_counts:
            counts = self.wildcard_array_counts.setdefault(pattern, {})
            counts[key] = counts.get(key, 0) + 1

    def _end_container(self, i: int) -> int:
        if not self._stack:
            self._error = "unexpected container end"
            return i + 1
        self._stack.pop()
        self._value_complete()
        return i + 1

    def _value_complete(self) -> None:
        if not self._stack:
            self._root_done = True
            return
        parent = self._stack[-1]
        if (parent.kind == "object" and parent.state == "value") or (
            parent.kind == "array" and parent.state == "value_or_end"
        ):
            parent.state = "comma_or_end"
        else:
            self._error = "value completed in invalid parser state"

    def _consume_string(self, chunk: bytes, i: int) -> int:
        state = self._string
        if state is None:
            self._error = "missing string parser state"
            return i
        while i < len(chunk):
            b = chunk[i]
            i += 1

            if state.unicode_remaining:
                if not _is_hex_byte(b):
                    self._error = "invalid unicode escape"
                    return i
                self._append_string_byte(state, b)
                if self._error:
                    return i
                state.unicode_remaining -= 1
                continue

            if state.escape:
                if b not in b'"\\/bfnrtu':
                    self._error = "invalid string escape"
                    return i
                self._append_string_byte(state, b)
                if self._error:
                    return i
                state.escape = False
                if b == ord("u"):
                    state.unicode_remaining = 4
                continue

            if b == ord("\\"):
                self._accept_string_byte(state, b)
                if self._error:
                    return i
                state.escape = True
                continue

            if b == ord('"'):
                self._finish_string(state)
                self._string = None
                return i

            if b < _JSON_CONTROL_CHAR_MAX:
                self._error = "control character in string"
                return i
            self._accept_string_byte(state, b)
            if self._error:
                return i

        return i

    def _accept_string_byte(self, state: _StringState, b: int) -> None:
        self._validate_string_byte(state, b)
        if not self._error:
            self._append_string_byte(state, b)

    def _validate_string_byte(self, state: _StringState, b: int) -> None:
        if state.utf8_remaining:
            if not _is_utf8_continuation(b):
                self._error = "invalid string"
                return
            state.utf8_codepoint = (state.utf8_codepoint << 6) | (b & 0x3F)
            state.utf8_remaining -= 1
            if state.utf8_remaining == 0 and not _is_valid_utf8_codepoint(
                state.utf8_codepoint, state.utf8_min_codepoint
            ):
                self._error = "invalid string"
            return

        if b < _UTF8_ONE_BYTE_MAX:
            return
        if _UTF8_TWO_BYTE_MIN <= b <= _UTF8_TWO_BYTE_MAX:
            state.utf8_remaining = 1
            state.utf8_codepoint = b & 0x1F
            state.utf8_min_codepoint = _UTF8_MIN_TWO_BYTE_CODEPOINT
            return
        if _UTF8_THREE_BYTE_MIN <= b <= _UTF8_THREE_BYTE_MAX:
            state.utf8_remaining = 2
            state.utf8_codepoint = b & 0x0F
            state.utf8_min_codepoint = _UTF8_MIN_THREE_BYTE_CODEPOINT
            return
        if _UTF8_FOUR_BYTE_MIN <= b <= _UTF8_FOUR_BYTE_MAX:
            state.utf8_remaining = 3
            state.utf8_codepoint = b & 0x07
            state.utf8_min_codepoint = _UTF8_MIN_FOUR_BYTE_CODEPOINT
            return
        self._error = "invalid string"

    def _append_string_byte(self, state: _StringState, b: int) -> None:
        if state.raw is None:
            return
        state.raw.append(b)
        if len(state.raw) > state.max_bytes:
            if state.role == "key":
                state.raw = None
                return
            self._error = "string limit exceeded"

    def _finish_string(self, state: _StringState) -> None:
        if state.utf8_remaining:
            self._error = "invalid string"
            return
        try:
            value = (
                _UNKNOWN_KEY if state.raw is None else json.loads(b'"' + bytes(state.raw) + b'"')
            )
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._error = "invalid string"
            return
        if state.role == "key":
            if _contains_surrogate(value):
                value = _UNKNOWN_KEY
            if not self._stack or self._stack[-1].kind != "object":
                self._error = "object key outside object"
                return
            frame = self._stack[-1]
            frame.pending_key = value
            frame.state = "colon"
            return
        if state.path is None:
            self._error = "missing selected string path"
            return
        if state.raw is None:
            self._value_complete()
            return
        if _contains_surrogate(value):
            self._value_complete()
            return
        self.values[state.path] = value
        self._value_complete()

    def _consume_number(self, chunk: bytes, i: int) -> int:
        state = self._number
        if state is None:
            self._error = "missing number parser state"
            return i
        while i < len(chunk):
            b = chunk[i]
            if b in b" \t\r\n,]}":
                self._finish_number()
                return i
            self._accept_number_byte(state, b)
            if self._error:
                return i + 1
            i += 1
        return i

    def _accept_number_byte(self, state: _NumberState, b: int) -> None:
        phase = state.phase
        if phase == "start":
            if b == ord("-"):
                state.phase = "after_minus"
            elif b == ord("0"):
                state.phase = "zero"
            elif ord("1") <= b <= ord("9"):
                state.phase = "int"
            else:
                self._error = "invalid number"
                return
        elif phase == "after_minus":
            if b == ord("0"):
                state.phase = "zero"
            elif ord("1") <= b <= ord("9"):
                state.phase = "int"
            else:
                self._error = "invalid number"
                return
        elif phase == "zero":
            if b == ord("."):
                state.phase = "dot"
            elif b in b"eE":
                state.phase = "exp"
            else:
                self._error = "invalid number"
                return
        elif phase == "int":
            if ord("0") <= b <= ord("9"):
                pass
            elif b == ord("."):
                state.phase = "dot"
            elif b in b"eE":
                state.phase = "exp"
            else:
                self._error = "invalid number"
                return
        elif phase == "dot":
            if ord("0") <= b <= ord("9"):
                state.phase = "frac"
            else:
                self._error = "invalid number"
                return
        elif phase == "frac":
            if ord("0") <= b <= ord("9"):
                pass
            elif b in b"eE":
                state.phase = "exp"
            else:
                self._error = "invalid number"
                return
        elif phase == "exp":
            if b in b"+-":
                state.phase = "exp_sign"
            elif ord("0") <= b <= ord("9"):
                state.phase = "exp_digits"
            else:
                self._error = "invalid number"
                return
        elif phase == "exp_sign":
            if ord("0") <= b <= ord("9"):
                state.phase = "exp_digits"
            else:
                self._error = "invalid number"
                return
        elif phase == "exp_digits":
            if not ord("0") <= b <= ord("9"):
                self._error = "invalid number"
                return
        else:
            self._error = "invalid number"
            return

        if state.raw is not None:
            state.raw.append(b)
            if len(state.raw) > state.max_bytes:
                self._error = "number limit exceeded"

    def _finish_number(self) -> None:
        state = self._number
        if state is None:
            return
        self._number = None
        if state.phase not in ("zero", "int", "frac", "exp_digits"):
            self._error = "invalid number"
            return
        if not state.selected:
            self._value_complete()
            return
        try:
            token = bytes(state.raw or b"").decode("ascii")
            value = json.loads(token)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error = "invalid number"
            return
        if state.selected and isinstance(value, int) and not isinstance(value, bool):
            self.values[state.path] = value
        self._value_complete()

    def _consume_literal(self, chunk: bytes, i: int) -> int:
        state = self._literal
        if state is None:
            self._error = "missing literal parser state"
            return i
        while i < len(chunk) and state.offset < len(state.literal):
            if chunk[i] != state.literal[state.offset]:
                self._error = "invalid literal"
                return i + 1
            i += 1
            state.offset += 1
        if state.offset == len(state.literal):
            self._literal = None
            self._value_complete()
        return i


def _is_hex_byte(b: int) -> bool:
    return ord("0") <= b <= ord("9") or ord("a") <= b <= ord("f") or ord("A") <= b <= ord("F")


def _is_utf8_continuation(b: int) -> bool:
    return _UTF8_CONT_MIN <= b <= _UTF8_CONT_MAX


def _is_valid_utf8_codepoint(codepoint: int, min_codepoint: int) -> bool:
    return (
        min_codepoint <= codepoint <= _UTF8_MAX_CODEPOINT
        and not _UTF8_SURROGATE_MIN <= codepoint <= _UTF8_SURROGATE_MAX
    )


def _contains_surrogate(value: object) -> bool:
    return isinstance(value, str) and any(
        _UTF8_SURROGATE_MIN <= ord(ch) <= _UTF8_SURROGATE_MAX for ch in value
    )


def _matches_any_path_pattern(patterns: set[Path], path: Path) -> bool:
    return any(_path_matches_pattern(pattern, path) for pattern in patterns)


def _path_matches_pattern(pattern: Path, path: Path) -> bool:
    return len(pattern) == len(path) and _path_prefix_matches_pattern(pattern, path)


def _path_prefix_matches_pattern(pattern: Path, path: Path) -> bool:
    if len(path) > len(pattern):
        return False
    return all(
        (expected == "*" and actual not in _INTERNAL_PATH_MARKERS) or expected == actual
        for expected, actual in zip(pattern, path, strict=False)
    )


def _is_path_prefix(prefix: Path, path: Path) -> bool:
    return len(prefix) <= len(path) and path[: len(prefix)] == prefix


def _build_key_collection_paths(paths: set[Path]) -> set[Path]:
    return {path[:idx] for path in paths for idx in range(len(path))}
