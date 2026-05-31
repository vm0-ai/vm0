//! Control socket protocol for `runner exec`.
//!
//! Provides a Unix domain socket server that runs alongside each sandbox,
//! allowing external processes to execute commands inside the VM via IPC.
//!
//! ## Wire format
//!
//! Length-prefixed JSON frames: `[4-byte big-endian length][JSON payload]`.
//! One request per connection, one response per connection.
//!
//! The request payload is [`ExecRequest`]. The response payload is
//! [`ExecResponse`], serialized as an untagged JSON object: command-result
//! responses contain command result fields, and error responses contain an
//! `error` field.

mod client;
mod protocol;
mod provider;
mod resolver;
mod server;

pub use client::send_exec;
pub use protocol::{ExecRequest, ExecResponse};
pub use provider::FirecrackerControl;
pub(crate) use server::{ControlServerHandle, bind_server};
