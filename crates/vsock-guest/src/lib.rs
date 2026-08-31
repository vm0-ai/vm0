//! Vsock Guest library for Firecracker VM host-guest communication.
//!
//! This library provides the core functionality for host-guest IPC via vsock
//! or Unix sockets. It can be used standalone or embedded in other binaries
//! like guest-init.
//!
//! Protocol encoding/decoding is handled by the `vsock-proto` crate.

mod agent_command;
mod connection;
mod drain;
mod error;
mod exec_control;
mod exec_operation;
mod file_write_worker;
mod guest_dns_readiness;
mod guest_state_restore;
mod guest_storage_manifest;
mod handlers;
mod log;
mod memory_snapshot;
mod process;
mod process_containment;
mod quiesce;
mod shell_command;
mod shutdown;
#[cfg(test)]
mod test_support;
mod threading;
mod user;
mod wait;
mod worker_ownership;
mod writer;

pub use connection::handle_connection_with_test_dns_readiness_program;
pub use connection::handle_connection_with_test_guest_agent_program;
pub use connection::handle_connection_with_test_guest_state_restore_program;
pub use connection::handle_connection_with_test_memory_snapshot_path;
pub use connection::handle_connection_with_test_storage_manifest_program;
pub use connection::{
    connect_unix, connect_vsock, handle_connection,
    handle_connection_with_test_process_containment,
    handle_connection_with_test_process_containment_and_exec_drain_deadline, run,
};
pub use log::log;

#[cfg(any(debug_assertions, feature = "test-support"))]
#[doc(hidden)]
pub fn set_debug_guest_write_file_path_for_tests(path: std::path::PathBuf) {
    handlers::set_debug_guest_write_file_path(path);
}
