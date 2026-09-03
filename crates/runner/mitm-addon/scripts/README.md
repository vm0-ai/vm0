# X TLD snapshot updates

The X billing URL detector uses the checked-in IANA top-level-domain snapshot at
`src/usage/providers/connectors/x_tlds.py`. Update it when the IANA source changes:

```bash
cd crates/runner/mitm-addon
scripts/update-x-tlds.py
```

The updater rewrites the generated module, but the snapshot integrity test keeps
reviewable pins in `tests/test_update_x_tlds.py`. After running the updater, update
these three constants from the generated module:

- `_EXPECTED_IANA_TLD_VERSION` must match `IANA_TLD_VERSION`.
- `_EXPECTED_IANA_TLD_COUNT` must match `len(IANA_TLDS)`.
- `_EXPECTED_IANA_TLD_SHA256` must match the SHA-256 digest of the ASCII bytes of
  `"\n".join(sorted(IANA_TLDS))`. The digest input has no trailing newline.

The update can produce either of two changes:

- **Version-only drift:** IANA changed its snapshot version but the sorted TLD set
  is unchanged. Update only `_EXPECTED_IANA_TLD_VERSION`.
- **TLD-set drift:** one or more TLDs were added or removed. Update the generated
  module and all three integrity pins (version, count, and digest).

Review the generated module and test-pin diff together. Then run the focused tests:

```bash
uv run --no-sync python -m pytest tests/test_update_x_tlds.py
```

For a local or reproducible source file, pass `--source-file` to the updater instead
of fetching IANA. The same generated-module and integrity-pin review applies.

# Flow metadata key linter

The flow metadata key linter checks shared `flow.metadata` keys for duplicate
registry values and repository key-use diagnostics. Run it from the addon root:

```bash
cd crates/runner/mitm-addon
./scripts/check-flow-metadata-keys.py
```

A clean run exits 0 without output. An exit code of 1 prints the diagnostics
that need correction. The linter recursively scans Python files under `src/`
and `tests/`, excludes the canonical [`src/flow_metadata_keys.py`](../src/flow_metadata_keys.py)
registry, and does not inspect `scripts/`.

When adding or renaming a shared metadata key, update the registry and use its
`metadata_keys` constants instead of literal shared keys, then run this check
before committing the related addon changes.

# Chat Completions SSE fast-path benchmark

The [Chat Completions extractor benchmark](benchmark_openai_chat_completions_usage.py)
compares fresh and reused selective JSON extraction with the bounded canonical-delta classifier
and the complete SSE fast path. Run it from the repository root with the addon's locked uv
environment:

```bash
cd crates/runner/mitm-addon
PYTHONPATH=src uv run --no-sync python scripts/benchmark_openai_chat_completions_usage.py
```

The benchmark uses this representative usage-free Chat Completions delta payload:

```json
{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"}}]}
```

Each fresh cycle constructs an extractor, feeds the payload, and finishes the document. Each reused
cycle resets the existing extractor before feeding and finishing the same payload. The bounded
classification cycle validates and classifies the complete payload without selective extraction.
The complete fast-path cycle sends the corresponding `data:` event through a reused
`SseUsageScanner`, including SSE framing and provider-handler work, and verifies before timing that
the payload is eligible for the fast path.

The script runs 10,000 cycles per repeat for five repeats, reports the median duration for each
path, and reports construction-reuse, full-parse-to-classification, and
full-parse-to-complete-fast-path ratios. The bounded classifier retains at most 1,024 event bytes;
unknown, ambiguous, candidate-bearing, malformed, or larger events use the authoritative selective
extractor and are outside the optimized benchmark path.

The timings are informational and machine-dependent microbenchmark results, not an end-to-end
response latency measurement or a fixed CI pass/fail threshold. For before-and-after comparisons,
use the same Python and dependency environment, hardware, and similar system conditions where
possible.
