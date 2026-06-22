use std::io;

use vsock_host::{ExecOperationResult, ExecOwnedCapturedOutput};

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

pub(crate) fn exec_termination_from_vsock_termination(
    termination: vsock_proto::ExecTermination,
) -> sandbox::ExecTermination {
    match termination {
        vsock_proto::ExecTermination::Exited { exit_code } => {
            sandbox::ExecTermination::Exited { exit_code }
        }
        vsock_proto::ExecTermination::TimedOut => sandbox::ExecTermination::TimedOut,
        vsock_proto::ExecTermination::Cancelled => sandbox::ExecTermination::Cancelled,
        vsock_proto::ExecTermination::StartFailed => sandbox::ExecTermination::StartFailed,
        vsock_proto::ExecTermination::WaitFailed => sandbox::ExecTermination::WaitFailed,
    }
}
