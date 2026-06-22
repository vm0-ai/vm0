//! Shared contracts between the runner and guest binaries.
//!
//! Keep guest-only runtime helpers in `guest-common`. This crate is for names,
//! values, and filesystem layout helpers both sides must keep in lockstep.

pub mod codex_thread_id;
pub mod env;
pub mod runtime_paths;
