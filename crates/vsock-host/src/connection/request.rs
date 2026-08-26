use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio::time::{self, Instant};
use vsock_proto::{
    MSG_ERROR, MSG_MEMORY_SNAPSHOT, MSG_MEMORY_SNAPSHOT_RESULT, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED, MSG_QUIESCE_OPERATIONS, MSG_RESUME_OPERATIONS, MSG_SHUTDOWN,
    MSG_SHUTDOWN_ACK, MemorySnapshot, RawMessage,
};

use crate::operation_tracker::{
    NormalOperationRejection, NormalOperationToken, NormalOperationTransitionError,
    NormalOperationTransitionHandle,
};
use crate::{FrameWriteObserver, RequestTimeoutError, RequestTimeoutStage, VsockHost};

use super::{ConnectionState, PendingNormalOperation, PendingResponse, RouteId, Shared};

struct PendingRequestGuard {
    shared: Arc<Shared>,
    route_id: RouteId,
}

pub(crate) struct RequestWriteGuard {
    shared: Arc<Shared>,
    write_started: bool,
    write_returned: bool,
}

#[derive(Debug, Default)]
struct RequestWriteProgress {
    stage: AtomicU8,
}

impl RequestWriteProgress {
    const BEFORE_FRAME_WRITE: u8 = 0;
    const FRAME_WRITE: u8 = 1;
    const AWAITING_TERMINAL_RESPONSE: u8 = 2;

    fn mark_frame_write(&self) {
        self.stage.store(Self::FRAME_WRITE, Ordering::Release);
    }

    fn mark_awaiting_terminal_response(&self) {
        self.stage
            .store(Self::AWAITING_TERMINAL_RESPONSE, Ordering::Release);
    }

    fn timeout_stage(&self) -> RequestTimeoutStage {
        match self.stage.load(Ordering::Acquire) {
            Self::BEFORE_FRAME_WRITE => RequestTimeoutStage::BeforeFrameWrite,
            Self::FRAME_WRITE => RequestTimeoutStage::FrameWrite,
            _ => RequestTimeoutStage::AwaitingTerminalResponse,
        }
    }
}

impl PendingRequestGuard {
    fn new(shared: Arc<Shared>, route_id: RouteId) -> Self {
        Self { shared, route_id }
    }
}

impl Drop for PendingRequestGuard {
    fn drop(&mut self) {
        self.shared.remove_pending(self.route_id);
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
        return Err(request_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            timeout,
        ));
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    request_raw_on_shared(shared, msg_type, payload, deadline, timeout).await
}

async fn write_request_frame(
    shared: &Arc<Shared>,
    data: &[u8],
    before_write: impl FnOnce() -> io::Result<()>,
    progress: &RequestWriteProgress,
) -> io::Result<()> {
    let mut write_guard = RequestWriteGuard::new(Arc::clone(shared));
    let mut writer = shared.writer.lock().await;
    before_write()?;
    progress.mark_frame_write();
    write_guard.mark_started();
    if let Err(error) = writer.write_all(data).await {
        write_guard.mark_returned();
        shared.poison_connection();
        return Err(error);
    }
    progress.mark_awaiting_terminal_response();
    write_guard.mark_returned();
    Ok(())
}

#[cfg(test)]
pub(crate) async fn write_request_frame_with_builder(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    before_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let progress = RequestWriteProgress::default();
    write_request_frame_with_builder_and_progress(shared, seq, build_frame, before_write, &progress)
        .await
}

async fn write_request_frame_with_builder_and_progress(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    before_write: impl FnOnce() -> io::Result<()>,
    progress: &RequestWriteProgress,
) -> io::Result<()> {
    let mut write_guard = RequestWriteGuard::new(Arc::clone(shared));
    let frame_builder_guard = shared.frame_builder.lock().await;
    let mut frame = Vec::new();
    build_frame(seq, &mut frame)?;
    let mut writer = shared.writer.lock().await;
    before_write()?;
    progress.mark_frame_write();
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
    progress.mark_awaiting_terminal_response();
    write_guard.mark_returned();
    Ok(())
}

fn encode_request_frame(msg_type: u8, seq: u32, payload: &[u8]) -> io::Result<Vec<u8>> {
    vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))
}

fn register_pending_response(
    shared: &Arc<Shared>,
    build_pending: impl FnOnce(RouteId, oneshot::Sender<RawMessage>) -> io::Result<PendingResponse>,
) -> io::Result<(RouteId, oneshot::Receiver<RawMessage>)> {
    // Register under the state lock: `Closed` short-circuits to an
    // immediate error, and insertion into `pending` is serialised with
    // the `Connected -> Closed` transition in `close()`. There is no
    // post-write `is_closed` check because close is observed via the
    // oneshot receiver becoming `Closed` when `close()` drops the map.
    let (tx, rx) = oneshot::channel();
    let (route_id, ()) = shared.register_route(|route_id, state| {
        let ConnectionState::Connected { pending, .. } = state else {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ));
        };
        let pending_response = build_pending(route_id, tx)?;
        assert!(
            pending
                .insert(route_id.wire_seq(), pending_response)
                .is_none(),
            "pending response route must be vacant"
        );
        Ok(())
    })?;
    Ok((route_id, rx))
}

async fn write_registered_request_and_wait(
    shared: &Arc<Shared>,
    data: &[u8],
    deadline: Instant,
    timeout: Duration,
    before_write: impl FnOnce() -> io::Result<()>,
    rx: oneshot::Receiver<RawMessage>,
) -> io::Result<RawMessage> {
    // The pending guard removes the pending entry on write failure, timeout,
    // or cancellation before reader_loop dispatches a response. The write
    // helper separately poisons the connection if cancellation interrupts an
    // in-progress frame write.
    let progress = RequestWriteProgress::default();
    time::timeout_at(
        deadline,
        write_request_frame(shared, data, before_write, &progress),
    )
    .await
    .map_err(|_| request_timeout_error(progress.timeout_stage(), timeout))??;

    await_pending_response(rx, deadline, timeout).await
}

async fn write_registered_request_and_wait_with_frame_builder(
    shared: &Arc<Shared>,
    seq: u32,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
    deadline: Instant,
    timeout: Duration,
    before_write: impl FnOnce() -> io::Result<()>,
    rx: oneshot::Receiver<RawMessage>,
) -> io::Result<RawMessage> {
    let progress = RequestWriteProgress::default();
    time::timeout_at(
        deadline,
        write_request_frame_with_builder_and_progress(
            shared,
            seq,
            build_frame,
            before_write,
            &progress,
        ),
    )
    .await
    .map_err(|_| request_timeout_error(progress.timeout_stage(), timeout))??;

    await_pending_response(rx, deadline, timeout).await
}

async fn await_pending_response(
    rx: oneshot::Receiver<RawMessage>,
    deadline: Instant,
    timeout: Duration,
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
            Err(request_timeout_error(
                RequestTimeoutStage::AwaitingTerminalResponse,
                timeout,
            ))
        }
    }
}

fn request_timeout_error(stage: RequestTimeoutStage, timeout: Duration) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        RequestTimeoutError::new(stage, timeout),
    )
}

async fn request_raw_on_shared(
    shared: &Arc<Shared>,
    msg_type: u8,
    payload: &[u8],
    deadline: Instant,
    timeout: Duration,
) -> io::Result<RawMessage> {
    let (route_id, rx) = register_pending_response(shared, |route_id, tx| {
        Ok(PendingResponse {
            route_id,
            response_tx: tx,
            normal_operation: None,
            normal_terminal_msg_types: &[],
        })
    })?;
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), route_id);
    let seq = route_id.wire_seq();
    let data = encode_request_frame(msg_type, seq, payload)?;

    write_registered_request_and_wait(shared, &data, deadline, timeout, || Ok(()), rx).await
}

pub(crate) async fn normal_request_on_shared_with_write_observer_frame_builder(
    shared: &Arc<Shared>,
    terminal_msg_types: &'static [u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
    build_frame: impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()>,
) -> io::Result<RawMessage> {
    if timeout.is_zero() {
        return Err(request_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            timeout,
        ));
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let normal_operation = shared.reserve_normal_operation()?;
    let (route_id, rx) = register_pending_response(shared, |route_id, tx| {
        Ok(PendingResponse {
            route_id,
            response_tx: tx,
            normal_operation: Some(PendingNormalOperation::Owned(normal_operation)),
            normal_terminal_msg_types: terminal_msg_types,
        })
    })?;
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), route_id);
    let seq = route_id.wire_seq();

    write_registered_request_and_wait_with_frame_builder(
        shared,
        seq,
        build_frame,
        deadline,
        timeout,
        || {
            mark_pending_normal_operation_possible_guest_write(shared, route_id, |_| Ok(()))?;
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
        return Err(request_timeout_error(
            RequestTimeoutStage::BeforeFrameWrite,
            timeout,
        ));
    }
    let deadline = deadline_after(timeout, "request timeout overflowed")?;
    let (route_id, rx) = register_pending_response(shared, |route_id, tx| {
        Ok(PendingResponse {
            route_id,
            response_tx: tx,
            normal_operation: Some(PendingNormalOperation::Composite(
                normal_operation.transition_handle()?,
            )),
            normal_terminal_msg_types: terminal_msg_types,
        })
    })?;
    let _pending_guard = PendingRequestGuard::new(Arc::clone(shared), route_id);
    let seq = route_id.wire_seq();

    write_registered_request_and_wait_with_frame_builder(
        shared,
        seq,
        build_frame,
        deadline,
        timeout,
        || {
            mark_pending_normal_operation_possible_guest_write(shared, route_id, |_| Ok(()))?;
            write_observer.record_write_start()
        },
        rx,
    )
    .await
}

fn mark_pending_normal_operation_possible_guest_write(
    shared: &Arc<Shared>,
    route_id: RouteId,
    pre_write: impl FnOnce(&mut ConnectionState) -> io::Result<()>,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    pre_write(&mut guard)?;
    match &mut *guard {
        ConnectionState::Connected { pending, .. } => {
            let seq = route_id.wire_seq();
            let Some(pending_response) = pending.get_mut(&seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "normal request closed before frame write",
                ));
            };
            if pending_response.route_id != route_id {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "normal request route was replaced before frame write",
                ));
            }
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
    /// On receipt, the guest atomically fences new operations before checking
    /// its pending-operation count. If the guest reports that operations are
    /// still pending, this method returns an error but guest admission remains
    /// fenced. Those operations finish independently; the guest does not wait
    /// or send a later acknowledgement. The caller must either retry this
    /// method after they drain or call [`Self::resume_operations`] to abandon
    /// the attempt and reopen guest admission.
    ///
    /// This does not fence host-side normal operations. Callers that need a
    /// no-new-normal-operation boundary must hold a
    /// [`crate::NormalOperationFence`] before sending this lifecycle request.
    /// A transport error or timeout does not reveal whether the guest received
    /// the request. A caller that keeps using the guest after such an uncertain
    /// attempt must explicitly resume guest operations before releasing its
    /// host-side fence.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the response.
    ///
    /// # Errors
    ///
    /// Returns the request error if the guest cannot be reached, does not
    /// respond before the deadline, or reports pending operations or another
    /// lifecycle error. An unexpected response type or non-empty
    /// acknowledgement returns [`io::ErrorKind::InvalidData`].
    pub async fn quiesce_operations(&self, timeout: Duration) -> io::Result<()> {
        self.lifecycle_request(
            MSG_QUIESCE_OPERATIONS,
            MSG_OPERATIONS_QUIESCED,
            "operations_quiesced payload must be empty",
            timeout,
        )
        .await
    }

    /// Read aggregate guest memory counters after operations are fully quiesced.
    ///
    /// This is a lifecycle request, so it remains available while a
    /// [`NormalOperationFence`](crate::NormalOperationFence) is held. The
    /// guest rejects it unless operation admission is fenced and no operations
    /// remain pending.
    pub async fn memory_snapshot(&self, timeout: Duration) -> io::Result<MemorySnapshot> {
        let response = self.request(MSG_MEMORY_SNAPSHOT, &[], timeout).await?;
        if response.msg_type == MSG_ERROR {
            return Err(lifecycle_error_from_response(&response));
        }
        if response.msg_type != MSG_MEMORY_SNAPSHOT_RESULT {
            return Err(protocol_invalid_data(format!(
                "unexpected lifecycle response type: expected 0x{MSG_MEMORY_SNAPSHOT_RESULT:02X}, got 0x{:02X}",
                response.msg_type,
            )));
        }
        vsock_proto::decode_memory_snapshot(&response.payload).map_err(protocol_invalid_data)
    }

    /// Resume guest operations after a failed or aborted quiesce attempt.
    ///
    /// Resume reopens guest admission immediately without waiting for
    /// previously admitted operations to finish. The transition is idempotent,
    /// so callers may use it after a guest-reported busy result or a
    /// delivery-uncertain quiesce failure. This does not release a held
    /// [`crate::NormalOperationFence`]; the caller retains ownership of that
    /// host-side boundary.
    ///
    /// The timeout covers waiting for the shared writer, writing the request,
    /// and waiting for the response.
    ///
    /// # Errors
    ///
    /// Returns the request error if the guest cannot be reached, does not
    /// respond before the deadline, or reports a lifecycle error. An unexpected
    /// response type or non-empty acknowledgement returns
    /// [`io::ErrorKind::InvalidData`].
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
    /// Once the guest receives a valid shutdown request, its connection loop
    /// is terminal: after attempting to write `MSG_SHUTDOWN_ACK`, it stops
    /// dispatching later frames and waits for the host to disconnect. This
    /// remains true when the acknowledgement write fails and the host cannot
    /// observe it.
    ///
    /// A transport error, timeout, or cancellation after the request may have
    /// been written does not reveal whether the guest received it. This method
    /// does not expose which side of that boundary a failure or cancellation
    /// occurred on. Unless other synchronization proves that no frame started
    /// writing, treat the guest lifecycle state as uncertain and do not attempt
    /// later operations on this connection.
    ///
    /// `Ok(())` confirms that the host received a matching, valid
    /// `MSG_SHUTDOWN_ACK`. It does not wait for or prove guest connection-loop
    /// exit, guest-process termination, or VM termination.
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
