//! Control socket protocol for local sandbox control.
//!
//! Provides a Unix domain socket server that runs alongside each sandbox,
//! allowing external processes to execute commands inside the VM or request
//! host-side sandbox termination via IPC.
//!
//! ## Wire format
//!
//! Length-prefixed JSON frames: `[4-byte big-endian length][JSON payload]`.
//! One request per connection, one response per connection.
//!
//! Exec request payloads are [`ExecRequest`]. Termination request payloads are
//! [`TerminateRequest`]. Responses are serialized as untagged JSON objects.

mod client;
mod protocol;
mod provider;
mod resolver;
mod server;

const CONTROL_SOCKET_OVERHEAD_MS: u64 = 5000;

pub use client::{send_exec, send_terminate};
pub use protocol::{
    ExecRequest, ExecResponse, TerminateAction, TerminateRequest, TerminateResponse,
    TerminateStatus,
};
pub use provider::FirecrackerControl;
pub(crate) use server::{
    ControlServerHandle, ProcessTerminationHandle, ProcessTerminationRequest, bind_server,
};
