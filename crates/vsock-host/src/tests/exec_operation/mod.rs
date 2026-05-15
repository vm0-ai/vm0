use vsock_proto::ExecOutputPolicy;

use crate::{ExecOperationHandle, ExecOperationRequest};

async fn start_capture_operation(host: &crate::VsockHost, command: &str) -> ExecOperationHandle {
    host.start_exec_operation(ExecOperationRequest {
        timeout_ms: 5000,
        command,
        env: &[],
        sudo: false,
        label: "test-command",
        stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: &[],
        stream_queue_capacity: None,
    })
    .await
    .unwrap()
}

mod cancel;
mod capture;
mod exec;
mod lifecycle;
mod malformed;
mod stream;
