# Rust Crates Code Review

Reviewed: 2026-03-23

## P1 — Stale lint suppressions

### 1. [FIXED] runner: stale #[allow(dead_code)] in types.rs

3 of 7 `#[allow(dead_code)]` on `ExecutionContext` fields were stale — the fields
are now actively used in executor.rs:
- `disallowed_tools` — used in executor.rs:752
- `tools` — used in executor.rs:759
- `settings` — used in executor.rs:766

4 remain legitimately dead (deserialized from API but not yet consumed by runner):
`vars`, `checkpoint_id`, `memory_name`, `experimental_profile`.
Updated their comments to explain why they exist.

### NOTE: guest-agent unwrap reports were false positives

Production code uses `.ok()`, `.map_err()`, `.unwrap_or()` throughout.
All `.unwrap()` calls are in `#[cfg(test)]` blocks only. Clippy passes clean.

## P2 — Code Quality

### 7. ably-subscriber: silent data loss on invalid UTF-8 (protocol.rs:157)

MessagePack string with invalid UTF-8 is silently replaced with empty string.
Caller cannot detect data truncation.

### 8. ably-subscriber: triple encoding conversion (protocol.rs)

msgpack → rmpv::Value → serde_json::Value → struct on every message.
Extra allocations; comment says it handles duplicate map keys.

### 9. guest-agent: event channel drops messages silently (cli.rs:47)

Channel capacity 1000; when full, `try_send` failure only increments counter.
No backpressure or caller notification.

### 10. guest-init: unsafe signal handler setup (pid1.rs)

- Line 47: `as *const () as libc::sighandler_t` cast — should use `sa_sigaction`
- Line 31: `sigaction` sa_mask not initialized — should call `sigemptyset()`

## Not Issues

- **`reqeast`** — internal wrapper crate around reqwest, not a typo
- **Guest crate "security issues"** (path traversal, command injection) — code runs inside sandboxed VM
- **sandbox-fc `expect_used`** — factory init phase, panic on failure is correct
