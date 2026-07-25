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
