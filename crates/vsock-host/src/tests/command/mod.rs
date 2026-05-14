use vsock_proto::CommandOutputPolicy;

use crate::{CommandOperationHandle, CommandOperationRequest};

async fn start_capture_operation(host: &crate::VsockHost, command: &str) -> CommandOperationHandle {
    host.start_command_operation(CommandOperationRequest {
        timeout_ms: 5000,
        command,
        env: &[],
        sudo: false,
        label: "test-command",
        stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
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
