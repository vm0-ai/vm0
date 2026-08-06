//! Integration tests that spawn the real binary via Cargo's
//! `CARGO_BIN_EXE_guest-mock-codex` env var.
//!
//! Cover the app-server stdio JSON-RPC shape and on-disk session artifacts.

mod support;

mod app_server;
mod session_filesystem;
