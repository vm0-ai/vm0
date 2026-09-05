# Pi memory recall and ad-hoc note provenance

The progressive-disclosure prose in `memory-recall.ts` is adapted from
OpenAI Codex `codex-rs/ext/memories/templates/memories/read_path.md` at commit
`5adb68a49933ae446bf11935662c83dba55a0804`, shipped in `@openai/codex`
0.152.1.

Portions copyright OpenAI. The upstream source is licensed under the Apache
License, Version 2.0: <https://www.apache.org/licenses/LICENSE-2.0>.

`memory-recall.test.ts` pins both the adapted rendered prompt and the exact
`o200k_base` truncation boundary. Update those fixtures intentionally whenever
the compatibility target changes.

The `add_ad_hoc_note` schema, filename validation, explicit-user-request
boundary, verbatim Markdown handling, fixed `extensions/ad_hoc/notes` layout,
and create-new semantics in `memory-tools-node.ts` are adapted from these files
at the same pinned commit:

- `codex-rs/ext/memories/src/tools/ad_hoc_note.rs`
- `codex-rs/ext/memories/src/local/ad_hoc_note.rs`

The Pi port additionally applies the existing descriptor-based memory path and
race validation, a 64 KiB note limit, and a sandbox-staging result contract.
