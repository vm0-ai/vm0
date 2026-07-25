use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio::time::{self, Instant};
use vsock_proto::{
    MSG_ERROR, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_QUIESCE_OPERATIONS,
    MSG_RESUME_OPERATIONS, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, RawMessage,
};

use crate::operation_tracker::{
    NormalOperationRejection, NormalOperationToken, NormalOperationTransitionError,
    NormalOperationTransitionHandle,
};
use crate::{FrameWriteObserver, VsockHost};

use super::{ConnectionState, PendingNormalOperation, PendingResponse, Shared};

struct PendingRequestGuard {
    shared: Arc<Shared>,
    seq: u32,
}

pub(crate) struct RequestWriteGuard {
    shared: Arc<Shared>,
    write_started: bool,
    write_returned: bool,
}

impl PendingRequestGuard {
    fn new(shared: Arc<Shared>, seq: u32) -> Self {
        Self { shared, seq }
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        self.shared.remove_pending(self.seq);
    }
}

impl RequestWriteGuard {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self {
            shared,
            write_started: false,
            write_returned: false,
        }
    }

    pub(crate) fn mark_started(&mut self) {
        self.write_started = true;
    }

    fn mark_returned(&mut self) {
        self.write_returned = true;
    }
}

impl Drop for RequestWriteGuard {
    fn drop(&mut self) {
        if self.write_started && !self.write_returned {
            self.shared.poison_connection();
        }
    }
}

pub(crate) struct CompositeNormalOperation {
    normal_operation: Option<NormalOperationToken>,
}

impl CompositeNormalOperation {
    pub(crate) fn from_token(normal_operation: NormalOperationToken) -> Self {
        Self {
            normal_operation: Some(normal_operation),
        }
    }

    pub(crate) fn reserve(shared: &Arc<Shared>) -> io::Result<Self> {
        Ok(Self::from_token(shared.reserve_normal_operation()?))
    }

    pub(crate) fn transition_handle(&self) -> io::Result<NormalOperationTransitionHandle> {
        self.normal_operation
            .as_ref()
            .map(NormalOperationToken::transition_handle)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "composite normal operation already completed",
                )
            })
    }

    pub(crate) fn complete(mut self) -> io::Result<()> {
        let normal_operation = self.normal_operation.take().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "composite normal operation already completed",
            )
        })?;
        // Terminal proof can race with connection close, which clears tracker
        // operations. Completion is idempotent for the composite owner.
        match normal_operation.complete() {
            Ok(()) | Err(NormalOperationTransitionError::UnknownOperation { .. }) => Ok(()),
            Err(error) => Err(normal_operation_transition_error(error)),
        }
    }
}

/// Send a request and wait for a response with matching sequence number.
async fn request_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    timeout: Duration,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error());
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let seq = shared.next_seq();
    request_raw_on_shared(shared, msg_type, seq, payload, deadline).await
}

async fn write_request_frame(
    shared: &Arc<Shared>,
    data: &[u8],
    before_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let mut write_guard = RequestWriteGuard::new(Arc::clone(shared));
    let mut writer = shared.writer.lock().await;
    before_write()?;
    write_guard.mark_started();
    if let Err(error) = writer.write_all(data).await {
        write_guard.mark_returned();
        shared.poison_connection();
        return Err(error);
    }
    write_guard.mark_returned();
    Ok(())
}

pub(crate) async fn write_request_frame_with_builder(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    before_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let mut write_guard = RequestWriteGuard::new(Arc::clone(shared));
    let frame_builder_guard = shared.frame_builder.lock().await;
    let mut frame = Vec::new();
    build_frame(seq, &mut frame)?;
    let mut writer = shared.writer.lock().await;
    before_write()?;
    write_guard.mark_started();
    let result = writer.write_all(&frame).await;
    if let Err(error) = result {
        write_guard.mark_returned();
        shared.poison_connection();
        drop(writer);
        drop(frame);
        drop(frame_builder_guard);
        return Err(error);
    }
    drop(writer);
    drop(frame);
    drop(frame_builder_guard);
    write_guard.mark_returned();
    Ok(())
}

fn encode_request_frame(msg_type: u8, seq: u32, payload: &[u8]) -> io::Result<Vec<u8>> {
    vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))
}

fn register_pending_response(
    shared: &Arc<Shared>,
    seq: u32,
    build_pending: impl FnOnce(oneshot::Sender<RawMessage>) -> io::Result<PendingResponse>,
) -> io::Result<oneshot::Receiver<RawMessage>> {
    // Register under the state lock: `Closed` short-circuits to an
    // immediate error, and insertion into `pending` is serialised with
    // the `Connected -> Closed` transition in `close()`. There is no
    // post-write `is_closed` check because close is observed via the
    // oneshot receiver becoming `Closed` when `close()` drops the map.
    let (tx, rx) = oneshot::channel();
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { pending, .. } = &mut *guard {
        let pending_response = build_pending(tx)?;
        pending.insert(seq, pending_response);
        Ok(rx)
    } else {
        Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        ))
    }
}

async fn write_registered_request_and_wait(
    shared: &Arc<Shared>,
    seq: u32,
    data: &[u8],
    deadline: Instant,
    before_write: impl FnOnce() -> io::Result<()>,
    rx: oneshot::Receiver<RawMessage>,
) -> io::Result<RawMessage> {
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    // The pending guard removes the pending entry on write failure, timeout,
    // or cancellation before reader_loop dispatches a response. The write
    // helper separately poisons the connection if cancellation interrupts an
    // in-progress frame write.
    time::timeout_at(deadline, write_request_frame(shared, data, before_write))
        .await
        .map_err(|_| request_timeout_error())??;

    await_pending_response(rx, deadline).await
}

async fn write_registered_request_and_wait_with_frame_builder(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    deadline: Instant,
    before_write: impl FnOnce() -> io::Result<()>,
    rx: oneshot::Receiver<RawMessage>,
) -> io::Result<RawMessage> {
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), seq);

    time::timeout_at(
        deadline,
        write_request_frame_with_builder(shared, seq, build_frame, before_write),
    )
    .await
    .map_err(|_| request_timeout_error())??;

    await_pending_response(rx, deadline).await
}

async fn await_pending_response(
    rx: oneshot::Receiver<RawMessage>,
    deadline: Instant,
) -> io::Result<RawMessage> {
    // `rx` returns `Ok(msg)` when the reader dispatches a response and
    // `Err(RecvError)` when `close()` drops the `Connected` variant. The
    // timeout arm is the only other way out.
    tokio::select! {
        biased;
        result = rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))
        }
        _ = time::sleep_until(deadline) => {
            Err(request_timeout_error())
        }
    }
}

fn request_timeout_error() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "request timeout")
}

/// Send a request with a pre-allocated sequence number.
async fn request_raw_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    deadline: Instant,
) -> io::Result<RawMessage> {
    let data = encode_request_frame(msg_type, seq, payload)?;
    let rx = register_pending_response(shared, seq, |tx| {
        Ok(PendingResponse {
            response_tx: tx,
            normal_operation: None,
            normal_terminal_msg_types: &[],
        })
    })?;

    write_registered_request_and_wait(shared, seq, &data, deadline, || Ok(()), rx).await
}

pub(crate) async fn normal_request_on_shared_with_write_observer_frame_builder(
    shared: &Arc<Shared>,
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error());
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let seq = shared.next_seq();
    let normal_operation = shared.reserve_normal_operation()?;
    let rx = register_pending_response(shared, seq, |tx| {
        Ok(PendingResponse {
            response_tx: tx,
            normal_operation: Some(PendingNormalOperation::Owned(normal_operation)),
            normal_terminal_msg_types: terminal_msg_types,
        })
    })?;

    write_registered_request_and_wait_with_frame_builder(
        shared,
        seq,
        build_frame,
        deadline,
        || {
            mark_pending_normal_operation_possible_guest_write(shared, seq, |_| Ok(()))?;
            write_observer.record_write_start()
        },
        rx,
    )
    .await
}

pub(crate) async fn request_on_shared_with_composite_operation_and_observer_frame_builder(
    shared: &Arc<Shared>,
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    normal_operation: &mut CompositeNormalOperation,
    write_observer: FrameWriteObserver,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error());
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let seq = shared.next_seq();
    let rx = register_pending_response(shared, seq, |tx| {
        Ok(PendingResponse {
            response_tx: tx,
            normal_operation: Some(PendingNormalOperation::Composite(
                normal_operation.transition_handle()?,
            )),
            normal_terminal_msg_types: terminal_msg_types,
        })
    })?;

    write_registered_request_and_wait_with_frame_builder(
        shared,
        seq,
        build_frame,
        deadline,
        || {
            mark_pending_normal_operation_possible_guest_write(shared, seq, |_| Ok(()))?;
            write_observer.record_write_start()
        },
        rx,
    )
    .await
}

fn mark_pending_normal_operation_possible_guest_write(
    shared: &Arc<Shared>,
    seq: u32,
    pre_write: impl FnOnce(&mut ConnectionState) -> io::Result<()>,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    pre_write(&mut guard)?;
    match &mut *guard {
        ConnectionState::Connected { pending, .. } => {
            let Some(pending_response) = pending.get_mut(&seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "normal request closed before frame write",
                ));
            };
            let Some(normal_operation) = pending_response.normal_operation.as_mut() else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "normal request missing operation token",
                ));
            };
            mark_pending_normal_operation_possible_guest_write_started(normal_operation)
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

fn mark_pending_normal_operation_possible_guest_write_started(
    normal_operation: &mut PendingNormalOperation,
) -> io::Result<()> {
    match normal_operation {
        PendingNormalOperation::Owned(normal_operation) => normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error),
        PendingNormalOperation::Composite(normal_operation) => normal_operation
            .mark_possible_guest_write_started()
            .map_err(normal_operation_transition_error),
    }
}

pub(super) fn complete_pending_normal_operation(
    normal_operation: PendingNormalOperation,
) -> io::Result<()> {
    match normal_operation {
        PendingNormalOperation::Owned(normal_operation) => normal_operation
            .complete()
            .map_err(normal_operation_transition_error),
        PendingNormalOperation::Composite(normal_operation) => normal_operation
            .mark_possible_guest_write_completed()
            .map_err(normal_operation_transition_error),
    }
}

pub(super) fn normal_operation_rejection_error(error: NormalOperationRejection) -> io::Error {
    match error {
        NormalOperationRejection::Fenced => io::Error::new(
            io::ErrorKind::WouldBlock,
            "normal operations are currently fenced",
        ),
        NormalOperationRejection::NotParkable => io::Error::new(
            io::ErrorKind::ConnectionReset,
            "normal operations are not available on this connection",
        ),
        NormalOperationRejection::Closed => {
            io::Error::new(io::ErrorKind::ConnectionReset, "connection closed")
        }
    }
}

pub(crate) fn normal_operation_transition_error(
    error: NormalOperationTransitionError,
) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("normal operation transition failed: {error:?}"),
    )
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

fn lifecycle_error_from_response(response: &RawMessage) -> io::Error {
    match vsock_proto::decode_error(&response.payload) {
        Ok(message) => io::Error::other(message.to_owned()),
        Err(error) => protocol_invalid_data(error),
    }
}

fn validate_empty_lifecycle_response(
    response: &RawMessage,
    payload_name: &'static str,
) -> io::Result<()> {
    vsock_proto::decode_empty_payload(payload_name, &response.payload)
        .map_err(protocol_invalid_data)
}

pub(super) fn deadline_after(
    timeout: Duration,
    overflow_message: &'static str,
) -> io::Result<Instant> {
    Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, overflow_message))
}

impl VsockHost {
    /// Send a request and wait for a response with matching sequence number.
    async fn request(
        &self,
        msg_type: u8,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<RawMessage> {
        request_on_shared(&self.shared, msg_type, payload, timeout).await
    }

    async fn lifecycle_request(
        &self,
        request_type: u8,
        expected_response_type: u8,
        response_payload_name: &'static str,
        timeout: Duration,
    ) -> io::Result<()> {
        let response = self.request(request_type, &[], timeout).await?;
        if response.msg_type == MSG_ERROR {
            return Err(lifecycle_error_from_response(&response));
        }
        if response.msg_type != expected_response_type {
            return Err(protocol_invalid_data(format!(
                "unexpected lifecycle response type: expected 0x{expected_response_type:02X}, got 0x{:02X}",
                response.msg_type,
            )));
        }
        validate_empty_lifecycle_response(&response, response_payload_name)
    }

    /// Ask the guest to quiesce its own operation dispatcher.
    ///
    /// This does not fence host-side normal operations. Callers that need a
    /// no-new-normal-operation boundary must hold a
    /// [`crate::NormalOperationFence`] before sending this lifecycle request.
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the response.
    pub async fn quiesce_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_QUIESCE_OPERATIONS,
            MSG_OPERATIONS_QUIESCED,
            "operations_quiesced payload must be empty",
            timeout,
        )
        .await
    }

    /// Resume guest operations after a failed or aborted quiesce attempt.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the response.
    pub async fn resume_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_RESUME_OPERATIONS,
            MSG_OPERATIONS_RESUMED,
            "operations_resumed payload must be empty",
            timeout,
        )
        .await
    }

    /// Request graceful shutdown from guest.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the acknowledgement.
    ///
    /// # Errors
    ///
    /// Returns the request error if the guest cannot be reached or does not
    /// acknowledge before the deadline. An unexpected response type or a
    /// non-empty acknowledgement returns [`io::ErrorKind::InvalidData`].
    pub async fn shutdown(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_SHUTDOWN,
            MSG_SHUTDOWN_ACK,
            "shutdown_ack payload must be empty",
            timeout,
        )
        .await
    }
}
