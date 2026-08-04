//! Control socket protocol for local sandbox control.
//!
//! Provides a Unix domain socket server that runs alongside each sandbox,
//! allowing external processes to execute commands inside the VM or request
//! host-side sandbox termination via IPC.
//!
//! ## Wire format
//!
//! Length-prefixed frames: `[4-byte big-endian length][payload]`. Requests and
//! legacy responses use JSON. Negotiated exec responses use a versioned binary
//! payload so captured stdout and stderr can be transferred without base64.
//! One request per connection, one response per connection.
//!
//! Exec request payloads are [`ExecRequest`]. Termination request payloads are
//! [`TerminateRequest`]. Public legacy responses are serialized as untagged
//! JSON objects.
//!
//! Termination clients send `{"action":"terminate"}`. A status response is
//! shaped like `{"status":"accepted"}`; an error response is shaped like
//! `{"error":"..."}`.

mod client;
mod exec_response;
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
