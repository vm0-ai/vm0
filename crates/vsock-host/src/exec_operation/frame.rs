use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use tokio::io::AsyncWriteExt;
use tokio::time::Instant;
use vsock_proto::{ExecControlStatus, MSG_EXEC_CANCEL, MSG_EXEC_START};

use crate::{ConnectionState, FrameWriteObserver, Shared, normal_operation_transition_error};

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

pub(in crate::exec_operation) fn exec_cancel_write_observer(
    shared: &Arc<Shared>,
    seq: u32,
) -> FrameWriteObserver {
    let shared = Arc::clone(shared);
    FrameWriteObserver::new(move || {
        mark_exec_operation_host_cancel_requested(&shared, seq);
        Ok(())
    })
}

fn mark_exec_operation_host_cancel_requested(shared: &Arc<Shared>, seq: u32) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard {
        operations.mark_host_cancel_requested(seq);
    }
}

pub(in crate::exec_operation) async fn send_supervised_exec_cancel_frame(
    shared: &Arc<Shared>,
    seq: u32,
    diagnostic: &ExecOperationDiagnostic,
) -> io::Result<()> {
    let payload = vsock_proto::encode_exec_cancel();
    write_frame(
        shared,
        MSG_EXEC_CANCEL,
        seq,
        &payload,
        Some(diagnostic.frame("cancel")),
        None,
        exec_cancel_write_observer(shared, seq),
    )
    .await?;
    tracing::info!(
        seq = seq,
        label = %diagnostic.label_log,
        elapsed_ms = diagnostic.elapsed_ms(),
        "supervised exec operation cancel sent"
    );
    Ok(())
}

fn mark_exec_operation_possible_guest_write(shared: &Arc<Shared>, seq: u32) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            let Some(operation) = operations.get_mut(seq) else {
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
    seq: u32,
) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard
        && let Some(operation) = operations.get_mut(seq)
    {
        operation.stream_tx = None;
    }
}

pub(in crate::exec_operation) fn remove_pending_exec_control(
    shared: &Arc<Shared>,
    request_seq: u32,
) {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if let ConnectionState::Connected { operations, .. } = &mut *guard {
        operations.remove_pending_control(request_seq);
    }
}

pub(in crate::exec_operation) fn mark_pending_exec_control_possible_guest_write(
    shared: &Arc<Shared>,
    target_seq: u32,
    request_seq: u32,
) -> io::Result<()> {
    let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match &mut *guard {
        ConnectionState::Connected { operations, .. } => {
            let Some(operation) = operations.get_mut(target_seq) else {
                return Err(exec_control_status_error(
                    ExecControlStatus::Inactive,
                    "exec operation is not active",
                ));
            };
            let Some(pending) = operation.pending_controls.get_mut(&request_seq) else {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "exec control request closed before frame write",
                ));
            };
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
    normal_operation_seq: Option<u32>,
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    write_frame_with_pre_write(shared, msg_type, seq, payload, diagnostic, || {
        if let Some(normal_operation_seq) = normal_operation_seq {
            mark_exec_operation_possible_guest_write(shared, normal_operation_seq)?;
        }
        write_observer.record_write_start()
    })
    .await
}

pub(in crate::exec_operation) async fn write_exec_start_frame(
    shared: &Arc<Shared>,
    seq: u32,
    payload: &[u8],
    diagnostic: &ExecOperationDiagnostic,
    tracks_normal_operation: bool,
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    write_frame(
        shared,
        MSG_EXEC_START,
        seq,
        payload,
        Some(diagnostic.frame("start")),
        tracks_normal_operation.then_some(seq),
        write_observer,
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
    let data = vsock_proto::encode(msg_type, seq, payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let state = Arc::new(AtomicU8::new(EXEC_OPERATION_FRAME_WRITE_NOT_STARTED));
    let guard = ExecOperationFrameWriteGuard::new(Arc::clone(shared), Arc::clone(&state));

    let wait_started_at = Instant::now();
    let mut writer = shared.writer.lock().await;
    let wait_elapsed_ms = wait_started_at.elapsed().as_millis();
    pre_write()?;
    state.store(EXEC_OPERATION_FRAME_WRITE_STARTED, Ordering::Release);
    let write_started_at = Instant::now();
    let result = writer.write_all(&data).await;
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
                write_elapsed_ms,
                error = %e,
                "exec operation frame write failed"
            );
        }
        return Err(e);
    }

    drop(guard);

    Ok(())
}
