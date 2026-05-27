//! Vsock Guest library for Firecracker VM host-guest communication.
//!
//! This library provides the core functionality for host-guest IPC via vsock
//! or Unix sockets. It can be used standalone or embedded in other binaries
//! like guest-init.
//!
//! Protocol encoding/decoding is handled by the `vsock-proto` crate.

mod connection;
mod drain;
mod error;
mod exec_control;
mod exec_operation;
mod handlers;
mod log;
mod process;
mod quiesce;
mod shell_command;
mod shutdown;
mod threading;
mod user;
mod wait;
mod writer;

pub use connection::{connect_unix, connect_vsock, handle_connection, run};
pub use log::log;

#[cfg(any(debug_assertions, feature = "test-support"))]
#[doc(hidden)]
pub fn set_debug_guest_write_file_path_for_tests(path: std::path::PathBuf) {
    handlers::set_debug_guest_write_file_path(path);
}
