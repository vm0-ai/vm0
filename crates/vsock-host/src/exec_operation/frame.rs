use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio::time::Instant;
use vsock_proto::{ExecControlStatus, MSG_EXEC_CANCEL, MSG_EXEC_START};

use crate::{
    ConnectionState, FrameWriteObserver, RouteId, RouteReservation, Shared,
    normal_operation_transition_error,
};

use super::diagnostics::{ExecOperationDiagnostic, ExecOperationFrameDiagnostic};
use super::types::exec_control_status_error;
use super::{
    EXEC_OPERATION_FRAME_WRITE_COMPLETED, EXEC_OPERATION_FRAME_WRITE_NOT_STARTED,
    EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD, EXEC_OPERATION_FRAME_WRITE_STARTED,
};

pub(in crate::exec_operation) struct ExecOperationFrameWriteGuard {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) state: Arc<AtomicU8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecCancelFrameWriteOutcome {
    Sent,
    AlreadyTerminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameWriteDecision {
    Write,
    Skip,
}

impl ExecOperationFrameWriteGuard {
    pub(in crate::exec_operation) fn new(shared: Arc<Shared>, state: Arc<AtomicU8>) -> Self {
        Self { shared, state }
    }
}

impl Drop for ExecOperationFrameWriteGuard {
    fn drop(&mut self) {
        if self.state.load(Ordering::Acquire) == EXEC_OPERATION_FRAME_WRITE_STARTED {
            self.shared.poison_connection();
        }
    }
}

pub(in crate::exec_operation) fn admit_exec_cancel_frame(
    shared: &Arc<Shared>,
    route_id: RouteId,
) -> io::Result<Option<RouteReservation>> {
    shared.reserve_exec_route_for_frame(route_id)
}

pub(in crate::exec_operation) fn exec_cancel_write_observer(
    shared: &Arc<Shared>,
    route_id: RouteId,
) -> FrameWriteObserver {
    let shared = Arc::clone(shared);
    FrameWriteObserver::new(move || mark_exec_operation_host_cancel_requested(&shared, route_id))
}

fn mark_exec_operation_host_cancel_requested(
    shared: &Arc<Shared>,
    route_id: RouteId,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            operations.mark_host_cancel_requested(route_id);
            Ok(())
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

fn mark_exec_operation_host_cancel_requested_for_wait(
    shared: &Arc<Shared>,
    route_id: RouteId,
) -> io::Result<ExecCancelFrameWriteOutcome> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            if operations.mark_host_cancel_requested(route_id) {
                Ok(ExecCancelFrameWriteOutcome::Sent)
            } else {
                Ok(ExecCancelFrameWriteOutcome::AlreadyTerminal)
            }
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

pub(in crate::exec_operation) async fn send_exec_cancel_frame_for_wait_with_write_start(
    shared: &Arc<Shared>,
    route_id: RouteId,
    diagnostic: &ExecOperationDiagnostic,
    write_started_tx: Option<oneshot::Sender<()>>,
) -> io::Result<ExecCancelFrameWriteOutcome> {
    let Some(_reservation) = shared.reserve_exec_route_for_frame(route_id)? else {
        return Ok(ExecCancelFrameWriteOutcome::AlreadyTerminal);
    };
    let payload = vsock_proto::encode_exec_cancel();
    let mut write_started_tx = write_started_tx;
    let seq = route_id.wire_seq();
    let decision = write_frame_with_pre_write_decision(
        shared,
        MSG_EXEC_CANCEL,
        seq,
        &payload,
        Some(diagnostic.frame("cancel")),
        || match mark_exec_operation_host_cancel_requested_for_wait(shared, route_id)? {
            ExecCancelFrameWriteOutcome::Sent => {
                if let Some(write_started_tx) = write_started_tx.take() {
                    let _ = write_started_tx.send(());
                }
                Ok(FrameWriteDecision::Write)
            }
            ExecCancelFrameWriteOutcome::AlreadyTerminal => Ok(FrameWriteDecision::Skip),
        },
    )
    .await?;

    Ok(match decision {
        FrameWriteDecision::Write => ExecCancelFrameWriteOutcome::Sent,
        FrameWriteDecision::Skip => ExecCancelFrameWriteOutcome::AlreadyTerminal,
    })
}

fn mark_exec_operation_possible_guest_write(
    shared: &Arc<Shared>,
    route_id: RouteId,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            let Some(operation) = operations.get_mut(route_id) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "exec operation closed before frame write",
                ));
            };
            if let Some(normal_operation) = operation.normal_operation.as_mut() {
                normal_operation.mark_possible_guest_write_started()
            } else {
                Ok(())
            }
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

pub(in crate::exec_operation) fn clear_exec_operation_stream_sender(
    shared: &Arc<Shared>,
    route_id: RouteId,
) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard
        && let Some(operation) = operations.get_mut(route_id)
    {
        operation.stream_tx = None;
    }
}

pub(in crate::exec_operation) fn remove_pending_exec_control(
    shared: &Arc<Shared>,
    request_route_id: RouteId,
) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard {
        operations.remove_pending_control(request_route_id);
    }
}

pub(in crate::exec_operation) fn mark_pending_exec_control_possible_guest_write(
    shared: &Arc<Shared>,
    target_route_id: RouteId,
    request_route_id: RouteId,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            let Some(operation) = operations.get_mut(target_route_id) else {
                return Err(exec_control_status_error(
                    ExecControlStatus::Inactive,
                    "exec operation is not active",
                ));
            };
            let request_seq = request_route_id.wire_seq();
            let Some(pending) = operation.pending_controls.get_mut(&request_seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "exec control request closed before frame write",
                ));
            };
            if pending.route_id != request_route_id {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "exec control route was replaced before frame write",
                ));
            }
            pending
                .normal_operation
                .mark_possible_guest_write_started()
                .map_err(normal_operation_transition_error)
        }
        ConnectionState::Closed => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection closed",
        )),
    }
}

pub(in crate::exec_operation) async fn write_frame(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    normal_operation_route_id: Option<RouteId>,
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    write_frame_with_pre_write(shared, msg_type, seq, payload, diagnostic, || {
        if let Some(normal_operation_route_id) = normal_operation_route_id {
            mark_exec_operation_possible_guest_write(shared, normal_operation_route_id)?;
        }
        write_observer.record_write_start()
    })
    .await
}

pub(in crate::exec_operation) async fn write_exec_start_frame(
    shared: &Arc<Shared>,
    route_id: RouteId,
    payload: &[u8],
    diagnostic: &ExecOperationDiagnostic,
    tracks_normal_operation: bool,
    write_admission: FrameWriteObserver,
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    let seq = route_id.wire_seq();
    write_frame_with_pre_write(
        shared,
        MSG_EXEC_START,
        seq,
        payload,
        Some(diagnostic.frame("start")),
        || {
            write_admission.record_write_start()?;
            if tracks_normal_operation {
                mark_exec_operation_possible_guest_write(shared, route_id)?;
            }
            write_observer.record_write_start()
        },
    )
    .await
}

pub(in crate::exec_operation) async fn write_frame_with_pre_write(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    pre_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let _decision =
        write_frame_with_pre_write_decision(shared, msg_type, seq, payload, diagnostic, || {
            pre_write()?;
            Ok(FrameWriteDecision::Write)
        })
        .await?;
    Ok(())
}

pub(in crate::exec_operation) async fn write_encoded_frame_with_pre_write(
    shared: &Arc<Shared>,
    data: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    pre_write: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    let _decision = write_encoded_frame_with_pre_write_decision(shared, data, diagnostic, || {
        pre_write()?;
        Ok(FrameWriteDecision::Write)
    })
    .await?;
    Ok(())
}

async fn write_frame_with_pre_write_decision(
    shared: &Arc<Shared>,
    msg_type: u8,
    seq: u32,
    payload: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    pre_write: impl FnOnce() -> io::Result<FrameWriteDecision>,
) -> io::Result<FrameWriteDecision> {
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    write_encoded_frame_with_pre_write_decision(shared, &data, diagnostic, pre_write).await
}

async fn write_encoded_frame_with_pre_write_decision(
    shared: &Arc<Shared>,
    data: &[u8],
    diagnostic: Option<ExecOperationFrameDiagnostic>,
    pre_write: impl FnOnce() -> io::Result<FrameWriteDecision>,
) -> io::Result<FrameWriteDecision> {
    let state = Arc::new(AtomicU8::new(EXEC_OPERATION_FRAME_WRITE_NOT_STARTED));
    let guard = ExecOperationFrameWriteGuard::new(Arc::clone(shared), Arc::clone(&state));

    let wait_started_at = Instant::now();
    let mut writer = shared.writer.lock().await;
    let wait_elapsed_ms = wait_started_at.elapsed().as_millis();
    let decision = pre_write()?;
    if decision == FrameWriteDecision::Skip {
        return Ok(FrameWriteDecision::Skip);
    }
    state.store(EXEC_OPERATION_FRAME_WRITE_STARTED, Ordering::Release);
    let write_started_at = Instant::now();
    let result = writer.write_all(data).await;
    let write_elapsed_ms = write_started_at.elapsed().as_millis();
    if result.is_ok() {
        state.store(EXEC_OPERATION_FRAME_WRITE_COMPLETED, Ordering::Release);
    } else {
        shared.poison_connection();
    }
    drop(writer);

    if wait_elapsed_ms >= EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD.as_millis()
        && let Some(diagnostic) = &diagnostic
    {
        tracing::warn!(
            seq = diagnostic.seq,
            label = %diagnostic.label_log,
            frame = diagnostic.frame,
            process_class = diagnostic.process_class,
            operation_kind = diagnostic.operation_kind,
            wait_elapsed_ms,
            "slow exec operation frame writer lock wait"
        );
    }

    if write_elapsed_ms >= EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD.as_millis()
        && result.is_ok()
        && let Some(diagnostic) = &diagnostic
    {
        tracing::warn!(
            seq = diagnostic.seq,
            label = %diagnostic.label_log,
            frame = diagnostic.frame,
            process_class = diagnostic.process_class,
            operation_kind = diagnostic.operation_kind,
            write_elapsed_ms,
            "slow exec operation frame write"
        );
    }

    if let Err(e) = result {
        if let Some(diagnostic) = &diagnostic {
            tracing::warn!(
                seq = diagnostic.seq,
                label = %diagnostic.label_log,
                frame = diagnostic.frame,
                process_class = diagnostic.process_class,
                operation_kind = diagnostic.operation_kind,
                write_elapsed_ms,
                error = %e,
                "exec operation frame write failed"
            );
        }
        return Err(e);
    }

    drop(guard);

    Ok(FrameWriteDecision::Write)
}
