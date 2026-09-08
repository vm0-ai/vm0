# mitmproxy Addon Runtime Contracts

These contracts cover addon logging, WebSocket framing and inspection, and path
normalization. Read the relevant section before changing the addon or its pinned
mitmproxy/wsproto dependencies. See the [testing guide](testing/mitm-addon-testing.md)
for environment setup, commands, and executable coverage.

## Logging Boundaries

The addon and Runner keep traffic records, run-local diagnostics, and process
diagnostics on separate paths:

| Source                         | Sink                                                | Ownership and delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proxied traffic                | `network-{run_id}.jsonl`                            | Per-run network records. Runner flushes, reads, and uploads this file through the network-log pipeline.                                                                                                                                                                                                                                                                                                                                                                  |
| Addon run diagnostics          | `proxy-{run_id}.jsonl`                              | Per-run structured diagnostics. This file is local and best effort; its row level does not automatically send a record to Axiom.                                                                                                                                                                                                                                                                                                                                         |
| Important addon process events | Exact `VM0_ADDON_EVENT` envelope on mitmdump stderr | Process-global failures and explicit dual-sink alerts. The versioned envelope carries one bounded addon-owned JSON log record: `level`, `message`, and any additional fields supplied by the addon logger. Runner does not maintain an event-family schema; it forwards the complete record so the additional fields remain top-level Axiom fields. Underbilling owns its canonical fields and also retains its structured proxy JSONL row when a run path is available. |
| Mitmproxy-native output        | Mitmdump stdout or unmatched stderr                 | Runner-owned process logging. Stdout remains local at info because its text stream does not preserve severity; unmatched stderr keeps the existing warning path. Neither enters proxy JSONL.                                                                                                                                                                                                                                                                             |

Addon code must not use `ctx.log` for active logging: mitmproxy's terminal
handler does not preserve the addon/native ownership boundary at the Runner
pipe. Use `log_proxy_entry` for ordinary attributable diagnostics and
`emit_addon_process_event` only for the explicit process-integrity or alert
events that need the independent Runner path. The emitter owns `level` and
`message`; callers may add other JSON-serializable fields directly without a
nested fields map. Runner-owned Axiom metadata (`_time`, `context`, `service`,
`runner_hostname`, and `runner_version`) remains authoritative. Callers remain
responsible for redaction and bounded values.

## WebSocket Framing Contract

[`websocket_framing.py`](../crates/runner/mitm-addon/src/websocket_framing.py)
is a version-pinned private replacement for mitmproxy's WebSocket connection
class. It bounds decoded data before a complete message reaches mitmproxy's
WebSocket addon hooks. The [real-layer integration
tests](../crates/runner/mitm-addon/tests/test_mitmproxy_websocket_framing.py)
are the executable contract for the behavior described here.

### Limits and allocation boundary

The limits apply to decoded logical messages, not to raw network reads:

| Constant                      | Value   | Scope                                                    |
| ----------------------------- | ------- | -------------------------------------------------------- |
| `MAX_DECODED_MESSAGE_BYTES`   | 256 MiB | One logical message in one WebSocket direction           |
| `MAX_MESSAGE_DATA_FRAMES`     | 8,192   | Data frames in one logical message in one direction      |
| `MAX_AGGREGATE_DECODED_BYTES` | 1 GiB   | All active WebSocket directions in one mitmproxy process |

Each bounded connection has a message budget for one direction. Decoded bytes
are charged as payload data is processed, and the process-wide aggregate budget
reserves the same bytes across all active directions. The limit extension is
appended after negotiated inbound extensions, so permessage-deflate output is
bounded before wsproto delivers decoded content to mitmproxy. A message that
exceeds a byte or frame limit emits no message hook or forwarded data and closes
with WebSocket code 1009 (`MESSAGE_TOO_BIG`).

### Frames, reads, and fragmentation

One network read can contain part of a frame, multiple frames, or a partial
message. The data-frame counter increments once when the first payload for each
data frame arrives, including continuation frames, rather than once per read.
Control frames are passed through and do not consume the data-frame budget. The
decoded-byte and data-frame counters reset only after a complete logical message
has been dispatched, or immediately when the connection closes. Partial frame
state is kept in a mutable `frame_buf` so repeated reads do not repeatedly copy
an immutable prefix.

### Bounded permessage-deflate

When permessage-deflate is negotiated, the framing adapter replaces the
mitmproxy extension while preserving its negotiated takeover and window
parameters. It asks zlib for at most one byte beyond the remaining message and
aggregate budgets. Extra output or a non-empty zlib unconsumed tail is treated as
an overflow lower bound, clears the decompressor and message budget, and closes
the flow with code 1009. A zlib decoding error clears the same state and closes
with `INVALID_FRAME_PAYLOAD_DATA` (1007).

RFC 7692 messages omit the final deflate block on the wire. The adapter restores
the empty-deflate trailer (`00 00 ff ff`) at the end of a compressed message and
runs that output through the same bound before dispatch. Uncompressed messages
after a compressed message, context takeover, and negotiated no-context-takeover
are connection-local states covered by the real-layer tests. Any rejected or
terminally closed compressed flow clears its decompressor and partial framing
state before the flow can release its connection resources.

### Aggregate ownership and terminal cleanup

The aggregate budget is process-global to the mitmproxy event-loop process. A
completed message keeps its decoded-byte reservation through addon hook
dispatch and forwarding: completion clears the per-message counters but defers
aggregate release until the next event-loop turn. This prevents another active
direction from using those bytes while the completed message is still held by
the hook. Rejection and either-direction connection close release the reservation
immediately. Partial frame, budget, and decompressor state are cleared for both
inbound and outbound close paths.

The first limit violation on each connection is stored as content-free
diagnostic state. At terminal flow cleanup,
`mitm_addon.py`'s
[`_release_terminal_flow_state()`](../crates/runner/mitm-addon/src/mitm_addon.py#L1658-L1684)
calls `log_limit_violation()` to consume that state and write a
`websocket_framing_limit` warning for each stored direction. Its structured
fields are `reason`,
`direction`, `limit_unit`, `limit_value`, `observed_value`,
`observed_is_lower_bound`, `close_code`, `run_id`, `flow_id`, and
`firewall_name`; payload contents are not logged. The separate
`release_flow_state()` entry point removes any remaining connection-scoped
diagnostic state without emitting a record.

### Installation and version re-audit

`install_websocket_framing()` is idempotent: it returns when the marked bounded
connection class is already installed, and rejects an unexpected unmarked
mitmproxy connection class. `mitm_addon.load()` installs the adaptation through
the [exact-version compatibility gate](../crates/runner/mitm-addon/src/mitmproxy_compat.py)
before registering addon options. The gate requires mitmproxy `12.2.3` and
wsproto `1.3.2`; the [runner dependency contract](../crates/runner/src/deps.rs)
and the addon `pyproject.toml`/`uv.lock` keep those pins aligned.

Before either dependency is upgraded, re-audit the private mitmproxy
connection, extension, frame-buffer, and generator behavior described above and
update the compatibility gate, runner artifact metadata, Python dependency
metadata, and this contract together. The
[`test_mitmproxy_websocket_framing.py`](../crates/runner/mitm-addon/tests/test_mitmproxy_websocket_framing.py)
suite must continue to pass as the executable framing contract.

## WebSocket handshake inspection boundary

Request classification and 101 response confirmation inspect `Headers.fields`
as raw bytes. They do not obtain full strings through `Headers.get_all()` before
checking the handshake budget. The caller owns one 8,192 limit and passes it to
response confirmation:

- Token lookup spends one unit per visited raw field, including unrelated
  fields, and one per inspected matching-value byte. A complete token at a comma
  or actual field end can return immediately; exhausting the budget is not a
  field ending. Later fields and an irrelevant suffix are not inspected.
- Singleton lookup separately allows at most 8,192 raw fields and an inclusive
  8,192 value bytes. It verifies cardinality and length before stripping SP/HTAB,
  so oversized or repeated key/version/accept fields cannot trigger full-value
  conversion or copying.
- Raw names are length-checked before ASCII case normalization. Key validation
  still requires 24 encoded bytes and 16 decoded bytes; version is `13`, and
  response confirmation requires an ASCII key and the matching 28-byte accept.

Over-budget or invalid handshakes fail closed to ordinary HTTP classification
and terminal usage handling. These are local addon inspection limits, separate
from mitmproxy's raw HTTP head buffering and other header consumers. Old runners
retain their previous inspection behavior until they are updated.

`test_http_header_syntax.py` uses guarded raw values and field sequences to prove
early termination and bounded access. `test_mitmproxy_websocket_header_budget.py`
feeds non-UTF-8 values through real HTTP/1 request hooks and guards the dependency
conversion boundary. `test_model_provider_websocket_lifecycle.py` verifies raw
response confirmation and tracked-flow retention/release. These regressions use
structural assertions, with no timing or allocation thresholds.

## Path normalization work boundary

Path safety validation accepts at most 65,536 input characters and five percent
decoding passes. Before whole-segment NFKC, each raw or decoded segment must have
at most 30 consecutive non-starters after compatibility decomposition (NFKD).
This is the [UAX #15 stream-safe input boundary](https://www.unicode.org/reports/tr15/#Stream_Safe_Text_Format):
the addon rejects unsupported paths; it does not insert characters or rewrite
the request path. Already ordered sequences above the limit are rejected too.

The guard decomposes one code point at a time and counts nonzero canonical
combining classes across decompositions. This catches characters with class zero
that decompose into marks, as well as multi-mark expansions. It never applies
NFKD to an unbounded segment. With bounded non-starter runs, the subsequent
whole-segment NFKC cannot perform unbounded canonical reordering per character.
The Unicode scan adds linear work; the plain-ASCII fast path is unchanged.

Long starter-separated Unicode paths remain supported within the total limit.
Existing dot/matrix syntax, malformed escapes, UTF-8, compatibility syntax, and
decode-depth checks remain in place. Matching rejects over-budget paths with the
existing `unsafe_path` decision before credentials are resolved. Shared base and
auth-rewrite URL validation uses the same boundary. During runner rollout, old
runners retain the previous pathological-input behavior until drained; no wire
format or persisted data changes.

`test_request_path_normalization_budget.py` exercises both real addon request
phases, observes the standard-library normalization boundary, and checks denial
before auth as well as successful unchanged Unicode paths. Correctness tests use
structural assertions rather than elapsed-time thresholds.
