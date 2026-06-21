use std::io;

use sandbox::SandboxExecTermination;
use vsock_host::{ExecOperationResult, ExecOwnedCapturedOutput};
use vsock_proto::ExecTermination;

pub(crate) fn validate_exec_capture_timeout(timeout_ms: u32) -> io::Result<()> {
    if timeout_ms == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "exec requires a positive timeout; use supervised exec for unbounded commands",
        ));
    }

    Ok(())
}

pub(crate) fn reject_stream_overflow(result: &ExecOperationResult) -> io::Result<()> {
    if result.stream_overflowed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "exec capture unexpectedly overflowed a stream queue",
        ));
    }

    Ok(())
}

pub(crate) fn captured_exec_output_bytes(
    name: &str,
    output: ExecOwnedCapturedOutput,
) -> io::Result<(Vec<u8>, bool)> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("exec result discarded {name} for capture request"),
        )),
    }
}

pub(crate) fn sandbox_exec_termination(termination: ExecTermination) -> SandboxExecTermination {
    match termination {
        ExecTermination::Exited { exit_code } => SandboxExecTermination::Exited { exit_code },
        ExecTermination::TimedOut => SandboxExecTermination::TimedOut,
        ExecTermination::Cancelled => SandboxExecTermination::Cancelled,
        ExecTermination::StartFailed => SandboxExecTermination::StartFailed,
        ExecTermination::WaitFailed => SandboxExecTermination::WaitFailed,
    }
}
