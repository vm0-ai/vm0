#![deny(missing_docs)]

//! Shared contracts between the runner and guest binaries.
//!
//! Keep guest-only runtime helpers in `guest-common`. This crate is for names,
//! values, and filesystem layout helpers both sides must keep in lockstep.

pub mod active_input;
pub mod active_input_receipts;
pub mod cli_agent_session_id;
pub mod codex_session_cleanup;
pub mod codex_session_path;
pub mod codex_thread_id;
pub mod connector_account_context;
pub mod diagnostics;
pub mod env;
pub mod epoch_milliseconds;
pub mod exec_limits;
pub mod exec_terminal;
pub mod file_write;
pub mod managed_command;
pub mod process_containment;
pub mod reuse_preparation;
pub mod runtime_paths;
pub mod session_history;
pub mod session_history_identity;
pub mod stdout_framing;
pub mod storage_manifest;
pub mod workspace_mount;
