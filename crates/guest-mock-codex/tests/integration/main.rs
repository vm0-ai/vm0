//! Integration tests that spawn the real binary via Cargo's
//! `CARGO_BIN_EXE_guest-mock-codex` env var.
//!
//! Cover the contract guest-agent will rely on: exec stdout JSONL shape,
//! app-server stdio JSON-RPC shape, on-disk session file path / format, and
//! resume semantics.

mod support;

mod app_server;
mod cli;
mod session_filesystem;
mod session_resume;
