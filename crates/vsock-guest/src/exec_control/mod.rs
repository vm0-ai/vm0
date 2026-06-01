use std::io;
use std::time::{Duration, Instant};

use vsock_proto::MSG_EXEC_CONTROL_RESULT;

use crate::error::to_io_error;
use crate::writer::GuestWriter;

mod accept;
mod forward;
mod registry;
mod sink;

#[cfg(test)]
mod tests;

pub(crate) use registry::{ExecControlGuard, ExecControlRegistry};

pub(crate) struct ExecControlRegistration {
    pub(crate) guard: ExecControlGuard,
    pub(crate) bootstrap_endpoint: Option<String>,
}

const CONTROL_ACCEPT_POLL_TIMEOUT: Duration = Duration::from_millis(100);
const CONTROL_SINK_IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_CONTROL_REQUESTS: usize = 8;
const EXEC_CONTROL_LOG_NAME: &str = "exec_control";
const EXEC_REQUEST_TIMEOUT_DIAGNOSTIC: &str = "exec control request timed out";
const EXEC_OPERATION_ALREADY_ACTIVE_MESSAGE: &str = "exec operation already active";
const EXEC_OPERATION_INACTIVE_MESSAGE: &str = "exec operation is not active";
const EXEC_OPERATION_NONCE_MISMATCH_MESSAGE: &str = "exec operation nonce mismatch";
const EXEC_CONTROL_SINK_NOT_CONFIGURED_MESSAGE: &str = "exec control sink is not configured";
const EXEC_CONTROL_QUEUE_FULL_MESSAGE: &str = "exec control queue is full";
const EXEC_CONTROL_CLONE_SINK_ERROR_PREFIX: &str = "failed to clone exec control sink";
const EXEC_CONTROL_WORKER_START_ERROR_PREFIX: &str = "failed to start exec control worker";
const EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX: &str = "exec control sink message id mismatch";

const THREAD_EXEC_CONTROL_ACCEPT: &str = "vsock-exec-control-accept";
const THREAD_EXEC_CONTROL_FORWARD: &str = "vsock-exec-control-forward";

fn request_deadline(request_timeout_ms: u32) -> Instant {
    Instant::now()
        .checked_add(Duration::from_millis(u64::from(request_timeout_ms)))
        .unwrap_or_else(Instant::now)
}

fn duration_until(deadline: Instant) -> Option<Duration> {
    let now = Instant::now();
    (now < deadline).then(|| deadline.duration_since(now))
}

fn request_timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, EXEC_REQUEST_TIMEOUT_DIAGNOSTIC)
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

#[cfg(test)]
pub(crate) fn handle_exec_control(
    seq: u32,
    payload: &[u8],
    registry: &ExecControlRegistry,
    writer: &GuestWriter,
) -> io::Result<()> {
    let request = vsock_proto::decode_exec_control(payload).map_err(to_io_error)?;
    handle_decoded_exec_control(seq, request, registry, writer)
}

pub(crate) fn handle_decoded_exec_control(
    seq: u32,
    request: vsock_proto::DecodedExecControl<'_>,
    registry: &ExecControlRegistry,
    writer: &GuestWriter,
) -> io::Result<()> {
    let owned = forward::OwnedExecControlRequest {
        response_seq: seq,
        target_seq: request.target_seq,
        deadline: request_deadline(request.request_timeout_ms),
        control_nonce: request.control_nonce,
        message_id: request.message_id.to_owned(),
        payload: request.payload.to_vec(),
    };

    let immediate = match registry.resolve(owned.target_seq, owned.control_nonce) {
        Ok(sink) => forward::try_forward(sink, owned, writer.clone()),
        Err((status, diagnostic)) => Some((status, diagnostic.to_owned())),
    };

    if let Some((status, diagnostic)) = immediate {
        writer.write_generated_frame_after_lock(|| {
            let result_payload = forward::encode_control_result(
                request.target_seq,
                request.control_nonce,
                request.message_id,
                status,
                &diagnostic,
            )
            .map_err(to_io_error)?;
            vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, seq, &result_payload).map_err(to_io_error)
        })?;
    }

    Ok(())
}
