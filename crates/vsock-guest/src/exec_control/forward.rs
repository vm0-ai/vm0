use std::io;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use process_control_ipc::{ControlRequest, ControlResponseStatus};
use vsock_proto::{ExecControlNonce, ExecControlStatus, MSG_EXEC_CONTROL_RESULT};

use crate::error::to_io_error;
use crate::log::log;
use crate::writer::GuestWriter;

use super::sink::{ControlSinkState, PendingControlSlot};
use super::{
    CONTROL_SINK_IO_TIMEOUT, EXEC_CONTROL_LOG_NAME, EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX,
    EXEC_CONTROL_WORKER_START_ERROR_PREFIX, EXEC_OPERATION_INACTIVE_MESSAGE,
    EXEC_REQUEST_TIMEOUT_DIAGNOSTIC, THREAD_EXEC_CONTROL_FORWARD, duration_until, is_timeout,
    request_timeout_error,
};

pub(super) struct OwnedExecControlRequest {
    pub(super) response_seq: u32,
    pub(super) target_seq: u32,
    pub(super) deadline: Instant,
    pub(super) control_nonce: ExecControlNonce,
    pub(super) message_id: String,
    pub(super) payload: Vec<u8>,
}

struct ControlForwardOutcome {
    status: ExecControlStatus,
    diagnostic: String,
    sink_disposition: ControlSinkDisposition,
}

enum ControlSinkDisposition {
    Keep,
    Fail,
}

pub(super) fn try_forward(
    sink: Arc<ControlSinkState>,
    request: OwnedExecControlRequest,
    writer: GuestWriter,
) -> Option<(ExecControlStatus, String)> {
    let pending_slot = match sink.reserve_pending_slot() {
        Ok(pending_slot) => pending_slot,
        Err(error) => return Some(error),
    };

    match thread::Builder::new()
        .name(THREAD_EXEC_CONTROL_FORWARD.to_owned())
        .spawn(move || forward_control_request(sink, pending_slot, request, writer))
    {
        Ok(_) => None,
        Err(error) => Some((
            ExecControlStatus::SinkError,
            format!("{}: {error}", EXEC_CONTROL_WORKER_START_ERROR_PREFIX),
        )),
    }
}

pub(super) fn forward_control_request(
    sink: Arc<ControlSinkState>,
    _pending_slot: PendingControlSlot,
    request: OwnedExecControlRequest,
    writer: GuestWriter,
) {
    let OwnedExecControlRequest {
        response_seq,
        target_seq,
        deadline,
        control_nonce,
        message_id,
        payload,
    } = request;
    let outcome = {
        match sink.wait_for_stream(deadline) {
            Ok(stream) => match stream.lock_until(deadline, &sink.active) {
                Ok(mut stream) => {
                    if !sink.active.load(Ordering::Acquire) {
                        ControlForwardOutcome {
                            status: ExecControlStatus::Inactive,
                            diagnostic: EXEC_OPERATION_INACTIVE_MESSAGE.to_owned(),
                            sink_disposition: ControlSinkDisposition::Keep,
                        }
                    } else if request_expired(deadline) {
                        ControlForwardOutcome {
                            status: ExecControlStatus::SinkTimeout,
                            diagnostic: EXEC_REQUEST_TIMEOUT_DIAGNOSTIC.to_owned(),
                            sink_disposition: ControlSinkDisposition::Keep,
                        }
                    } else {
                        forward_to_connected_sink(&mut stream, &message_id, payload, deadline)
                    }
                }
                Err(error) if is_timeout(&error) => ControlForwardOutcome {
                    status: ExecControlStatus::SinkTimeout,
                    diagnostic: error.to_string(),
                    sink_disposition: ControlSinkDisposition::Keep,
                },
                Err(error) => ControlForwardOutcome {
                    status: ExecControlStatus::SinkError,
                    diagnostic: error.to_string(),
                    sink_disposition: ControlSinkDisposition::Keep,
                },
            },
            Err((status, diagnostic)) => ControlForwardOutcome {
                status,
                diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
        }
    };

    let ControlForwardOutcome {
        status,
        diagnostic,
        sink_disposition,
    } = outcome;

    match sink_disposition {
        ControlSinkDisposition::Keep => {}
        ControlSinkDisposition::Fail => sink.fail(diagnostic.clone()),
    }

    let result = writer.write_generated_frame_after_lock(|| {
        let (status, diagnostic) = if sink.active.load(Ordering::Acquire) {
            (status, diagnostic.as_str())
        } else {
            (ExecControlStatus::Inactive, EXEC_OPERATION_INACTIVE_MESSAGE)
        };
        let result_payload =
            encode_control_result(target_seq, control_nonce, &message_id, status, diagnostic)
                .map_err(to_io_error)?;
        vsock_proto::encode(MSG_EXEC_CONTROL_RESULT, response_seq, &result_payload)
            .map_err(to_io_error)
    });
    if let Err(error) = result {
        log(
            "WARN",
            &format!("{EXEC_CONTROL_LOG_NAME}: failed to send control result: {error}"),
        );
    }
}

fn forward_to_connected_sink(
    stream: &mut UnixStream,
    message_id: &str,
    payload: Vec<u8>,
    deadline: Instant,
) -> ControlForwardOutcome {
    let request_frame = ControlRequest {
        message_id: message_id.to_owned(),
        payload,
    };
    let write_timeout = match control_sink_io_timeout(deadline) {
        Ok(timeout) => timeout,
        Err(error) if is_timeout(&error) => {
            return control_forward_io_error(
                ExecControlStatus::SinkTimeout,
                error,
                ControlSinkDisposition::Keep,
            );
        }
        Err(error) => {
            return control_forward_io_error(
                ExecControlStatus::SinkError,
                error,
                ControlSinkDisposition::Keep,
            );
        }
    };
    if let Err(error) = write_control_request(stream, &request_frame, write_timeout) {
        return if is_timeout(&error) {
            control_forward_io_error(
                ExecControlStatus::SinkTimeout,
                error,
                ControlSinkDisposition::Fail,
            )
        } else {
            control_forward_io_error(
                ExecControlStatus::SinkError,
                error,
                ControlSinkDisposition::Fail,
            )
        };
    }

    let read_timeout = match control_sink_io_timeout(deadline) {
        Ok(timeout) => timeout,
        Err(error) if is_timeout(&error) => {
            return control_forward_io_error(
                ExecControlStatus::SinkTimeout,
                error,
                ControlSinkDisposition::Fail,
            );
        }
        Err(error) => {
            return control_forward_io_error(
                ExecControlStatus::SinkError,
                error,
                ControlSinkDisposition::Fail,
            );
        }
    };
    match read_control_response(stream, read_timeout) {
        Ok(response) if response.message_id != message_id => ControlForwardOutcome {
            status: ExecControlStatus::SinkError,
            diagnostic: format!(
                "{}: expected {}, got {}",
                EXEC_CONTROL_MESSAGE_ID_MISMATCH_PREFIX, message_id, response.message_id
            ),
            sink_disposition: ControlSinkDisposition::Fail,
        },
        Ok(response) => match response.status {
            ControlResponseStatus::Accepted => ControlForwardOutcome {
                status: ExecControlStatus::Delivered,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
            ControlResponseStatus::Rejected => ControlForwardOutcome {
                status: ExecControlStatus::Rejected,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
            ControlResponseStatus::Error => ControlForwardOutcome {
                status: ExecControlStatus::SinkError,
                diagnostic: response.diagnostic,
                sink_disposition: ControlSinkDisposition::Keep,
            },
        },
        Err(error) if is_timeout(&error) => control_forward_io_error(
            ExecControlStatus::SinkTimeout,
            error,
            ControlSinkDisposition::Fail,
        ),
        Err(error) => control_forward_io_error(
            ExecControlStatus::SinkError,
            error,
            ControlSinkDisposition::Fail,
        ),
    }
}

fn control_forward_io_error(
    status: ExecControlStatus,
    error: io::Error,
    sink_disposition: ControlSinkDisposition,
) -> ControlForwardOutcome {
    ControlForwardOutcome {
        status,
        diagnostic: error.to_string(),
        sink_disposition,
    }
}

fn request_expired(deadline: Instant) -> bool {
    duration_until(deadline).is_none()
}

fn control_sink_io_timeout(deadline: Instant) -> io::Result<Duration> {
    duration_until(deadline)
        .map(|remaining| remaining.min(CONTROL_SINK_IO_TIMEOUT))
        .filter(|timeout| !timeout.is_zero())
        .ok_or_else(request_timeout_error)
}

fn write_control_request(
    stream: &mut UnixStream,
    request: &ControlRequest,
    timeout: Duration,
) -> io::Result<()> {
    stream.set_write_timeout(Some(timeout))?;
    process_control_ipc::write_request(stream, request)
}

fn read_control_response(
    stream: &mut UnixStream,
    timeout: Duration,
) -> io::Result<process_control_ipc::ControlResponse> {
    stream.set_read_timeout(Some(timeout))?;
    process_control_ipc::read_response(stream)
}

pub(super) fn encode_control_result(
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    status: ExecControlStatus,
    diagnostic: &str,
) -> Result<Vec<u8>, vsock_proto::ProtocolError> {
    vsock_proto::encode_exec_control_result(
        target_seq,
        control_nonce,
        message_id,
        status,
        diagnostic,
    )
}
