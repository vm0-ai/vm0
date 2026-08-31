//! Frame writes are serialized through the shared writer so that operation state and frame bytes
//! cross their safety boundaries in a fixed order.
//!
//! ## Frame-write safety contract
//!
//! Each guarded frame write has three states:
//!
//! - `NOT_STARTED`: the writer lock is not held yet, or the pre-write decision is still running.
//!   Dropping the write in this state means no frame bytes could have been emitted.
//! - `STARTED`: the pre-write decision returned `Write` and the writer is about to, or is already,
//!   awaiting `write_all`. The write may be partial, so a dropped future or write error poisons
//!   the connection rather than allowing it to be reused.
//! - `COMPLETED`: `write_all` returned successfully. Dropping the guard after this state does not
//!   poison the connection.
//!
//! The pre-write callback runs after `Shared::writer` has been acquired and before the
//! `STARTED` transition. It is therefore the serialized admission point for route and operation
//! state changes, write observers, and cancellation decisions. A callback that returns `Skip`
//! exits while the writer is still serialized, without crossing `STARTED`, emitting frame bytes,
//! or publishing a write-start notification.
//!
//! `send_exec_cancel_frame_for_wait_with_write_start` uses that admission point to revalidate the
//! route immediately before cancellation can be written. When the route is still cancellable, it
//! marks the host cancellation and sends `write_started_tx` from the callback before returning
//! `Write`; the generic writer has not yet stored `STARTED` or called `write_all`. When the
//! operation is already terminal, the callback returns `AlreadyTerminal` as `Skip`, so the stale
//! cancel frame is not written. Moving either the route revalidation or this notification outside
//! the writer lock would break the ordering against a terminal result or a reused wire sequence.
//!
//! The cancellation and drop regression surface is covered by the named tests in
//! `crates/vsock-host/src/tests/exec_operation/cancel.rs`, including
//! `exec_cancel_writer_lock_timeout_before_write_does_not_poison_or_send_frame`,
//! `exec_cancel_terminal_result_wins_while_cancel_write_is_blocked`,
//! `exec_write_observer_fires_at_frame_write_boundary`, and
//! `exec_operation_frame_write_guard_started_drop_poisons_connection`. Supervised cancellation
//! and route-reuse cases are covered in
//! `crates/vsock-host/src/tests/exec_operation/supervised/cancel.rs`, including
//! `supervised_exec_cancel_and_wait_terminal_result_wins_while_cancel_write_is_blocked`,
//! `supervised_exec_cancel_and_wait_writer_lock_timeout_before_write_cleans_registration`, and
//! `stale_cancel_handle_does_not_cancel_reused_wire_sequence`.

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

/// Poisons the connection if a frame write is dropped after its write boundary.
///
/// The guard is created before waiting for the serialized writer lock. The guarded operation
/// stores `STARTED` immediately before `write_all` and `COMPLETED` only after a successful
/// `write_all`. Its `Drop` implementation consequently treats a dropped `STARTED` write as
/// potentially partial, while a write dropped before `STARTED` or after `COMPLETED` does not
/// poison the connection.
pub(in crate::exec_operation) struct ExecOperationFrameWriteGuard {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) state: Arc<AtomicU8>,
}

/// Admission result for a cancel frame.
///
/// `AlreadyTerminal` means that route admission or the serialized pre-write check observed that
/// the operation no longer accepts cancellation. It is a successful no-frame outcome, not proof
/// that a cancel frame was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::exec_operation) enum ExecCancelFrameWriteOutcome {
    Sent,
    AlreadyTerminal,
}

/// Decision returned by the serialized pre-write callback.
///
/// `Skip` must be decided while the shared writer lock is held. It returns before the write-start
/// state transition, so the frame-write guard can be dropped without poisoning and no bytes can be
/// emitted by this frame attempt.
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

/// Admit and write a cancel frame while preserving the cancel-and-wait race boundary.
///
/// The route reservation is followed by a serialized pre-write check. That check must remain
/// inside the shared writer lock so a terminal result cannot be separated from the decision to
/// write a cancel frame for the same route. `AlreadyTerminal` becomes `Skip`, which leaves the
/// frame-write state at `NOT_STARTED` and emits no cancel frame.
///
/// When cancellation is admitted, the callback marks the host cancellation and sends
/// `write_started_tx` before returning `Write`. The notification therefore occurs before the
/// generic writer stores `STARTED` and before `write_all` can emit bytes; it is not a completion
/// notification. The reservation, state transition, notification, and `Write` decision must keep
/// this ordering.
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

/// Write an exec-start frame through the serialized frame-write lifecycle.
///
/// Admission and write observers run in the pre-write callback while the writer lock is held and
/// before the guarded write crosses `STARTED`. They therefore describe the write boundary rather
/// than successful completion.
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

/// Run a pre-write callback and then write a typed frame while holding the writer serialization.
///
/// The callback runs after the writer lock is acquired and before the write-start state transition.
/// Callers use this point for state admission and observers that must be ordered before any frame
/// bytes are emitted.
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

/// Run a pre-write callback and then write already encoded frame data.
///
/// The callback has the same serialized pre-write contract as
/// `write_frame_with_pre_write`; the encoded-data form keeps the state transition and poisoning
/// behavior in the shared writer implementation below.
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

/// Perform the serialized frame write and enforce its cancellation safety boundaries.
///
/// The writer lock is acquired before `pre_write` is called. A `Skip` decision returns while that
/// lock is held and before `STARTED` is stored. For a `Write` decision, `STARTED` is stored
/// immediately before `write_all`; `COMPLETED` is stored only after `write_all` succeeds. Keep the
/// frame-write guard alive across the whole operation so dropping a future during the possible
/// partial-write window poisons the connection.
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
