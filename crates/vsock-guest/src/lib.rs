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
mod exec;
mod handlers;
mod log;
mod monitor;
mod process;
mod shutdown;
mod wait;

pub use connection::{connect_unix, connect_vsock, handle_connection, run};
pub use log::log;
