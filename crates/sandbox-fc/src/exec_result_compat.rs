use std::io;

use vsock_host::{ExecOperationResult, ExecOwnedCapturedOutput};
use vsock_proto::ExecTermination;

/// Exit code historically used for timed-out guest exec operations.
pub(crate) const EXEC_TIMEOUT_EXIT_CODE: i32 = 124;

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

pub(crate) fn append_diagnostic(stderr: &mut Vec<u8>, diagnostic: &str) {
    if diagnostic.is_empty() {
        return;
    }
    if !stderr.is_empty() && !stderr.ends_with(b"\n") {
        stderr.push(b'\n');
    }
    stderr.extend_from_slice(diagnostic.as_bytes());
}

pub(crate) fn legacy_exit_code_for_exec_termination(
    termination: ExecTermination,
    stderr: &mut Vec<u8>,
    diagnostic: &str,
) -> i32 {
    match termination {
        ExecTermination::Exited { exit_code } => exit_code,
        ExecTermination::TimedOut => {
            if stderr.is_empty() {
                stderr.extend_from_slice(b"Timeout");
            }
            EXEC_TIMEOUT_EXIT_CODE
        }
        ExecTermination::Cancelled => {
            if stderr.is_empty() {
                stderr.extend_from_slice(b"Cancelled");
            }
            append_diagnostic(stderr, diagnostic);
            1
        }
        ExecTermination::StartFailed | ExecTermination::WaitFailed => {
            append_diagnostic(stderr, diagnostic);
            1
        }
    }
}
