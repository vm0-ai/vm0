//! Runner-side mitmproxy process and addon protocol.
//!
//! This module owns the Rust side of the runner's transparent proxy. It
//! extracts the embedded Python addon into the runner's `mitm-addon`
//! directory, starts `mitmdump` with runner-specific options, publishes VM
//! metadata through the proxy registry, and coordinates crash notification,
//! restart, usage drain, JSONL log flush, and graceful stop behavior.
//!
//! The Rust/Python boundary is intentionally file- and option-based:
//!
//! - `vm0_proxy_registry_path` points the addon at the registry JSON written
//!   by [`ProxyRegistryHandle`].
//! - `vm0_usage_state_id` identifies the currently running mitmdump/addon
//!   process. Restart rotates this value so stale addon state from an older
//!   child is rejected.
//! - `usage-flush-request` is written by Rust before shutdown drain. The addon
//!   acknowledges in `usage-pending` with the matching usage state, flush
//!   request id, and pending flow/buffer/report counters.
//! - `jsonl-flush-request` is written by Rust for one network log path before
//!   upload. The addon acknowledges in `jsonl-flush-state` after accepted
//!   writes for that path are visible.
//!
//! Registry writes are atomic so the addon never consumes partial JSON. Flush
//! acknowledgements must match the active usage state and request id; missing,
//! stale, invalid, or mismatched addon state is treated as "not ready" until
//! the bounded wait times out. Usage drain is a shutdown path for billing and
//! usage reports, while JSONL flush is a per-upload network-log path.
//!
//! `MitmProxy::new` prepares addon files, an empty registry, crash channel, and
//! initial usage state. `start` spawns `mitmdump` and monitor tasks. Unexpected
//! stdout close notifies the runner unless the child is stopping gracefully.
//! `begin_restart` kills the old child, permanently silences its monitor, and
//! returns fresh spawn parameters; `complete_restart` stores the new child.
//! Shutdown writes a usage flush request, signals the addon, waits boundedly
//! for `usage-pending`, then calls `stop`.
//!
//! Addon-side details live in `crates/runner/mitm-addon/src/mitm_addon.py`
//! (SIGUSR1 worker and request handling),
//! `crates/runner/mitm-addon/src/usage/counters.py` (`usage-pending`),
//! `crates/runner/mitm-addon/src/registry.py` (registry loading), and
//! `crates/runner/mitm-addon/src/jsonl_writer.py` (accepted-write flush
//! semantics).

mod flush;
mod process;
mod registry;
mod stderr;

pub use flush::{
    MitmJsonlFlushHandle, USAGE_FLUSH_TIMEOUT, wait_usage_flush_requesting,
    write_usage_flush_request,
};
pub use process::{MitmProxy, ProxyConfig};
pub use registry::{ProxyRegistryHandle, VmRegistration};
