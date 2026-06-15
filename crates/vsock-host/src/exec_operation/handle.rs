use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use vsock_proto::{
    ExecControlNonce, ExecControlStatus, ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL,
};

use crate::{ConnectionState, FrameWriteObserver, Shared};

use super::EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT;
use super::diagnostics::ExecOperationDiagnostic;
use super::frame::{
    clear_exec_operation_stream_sender, exec_cancel_write_observer,
    mark_pending_exec_control_possible_guest_write, send_supervised_exec_cancel_frame, write_frame,
    write_frame_with_pre_write,
};
use super::state::{PendingExecControl, PendingExecControlGuard};
use super::types::{
    ExecControlAck, ExecControlOutcome, ExecOperationResult, ExecOutputEvent,
    exec_control_status_error,
};

/// Handle for a host-side exec operation.
///
/// Dropping the handle removes the host-side registration only. It never sends
/// `MSG_EXEC_CANCEL`; callers that need remote cancellation must call
/// [`ExecOperationHandle::cancel_and_wait`]. See the Exec Operation Lifecycle
/// section in the [`crate`] docs for the cross-handle ownership contract.
#[must_use = "dropping this handle does not cancel the guest; call wait or cancel_and_wait"]
pub struct ExecOperationHandle {
    pub(in crate::exec_operation) wait_core: ExecWaitCore,
    pub(in crate::exec_operation) stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
}

pub(in crate::exec_operation) struct ExecWaitCore {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) seq: Option<u32>,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
    pub(in crate::exec_operation) result_rx:
        Option<oneshot::Receiver<io::Result<ExecOperationResult>>>,
}

#[derive(Clone, Copy)]
pub(in crate::exec_operation) enum ExecWaitLifecycle {
    OneShot,
    Supervised,
}

pub(in crate::exec_operation) struct ExecCancelWaitResult {
    pub(in crate::exec_operation) result: ExecOperationResult,
    pub(in crate::exec_operation) cancel_seq: Option<u32>,
}

impl ExecWaitCore {
    fn operation_closed_message(lifecycle: ExecWaitLifecycle) -> &'static str {
        match lifecycle {
            ExecWaitLifecycle::OneShot => "exec operation closed",
            ExecWaitLifecycle::Supervised => "supervised exec operation closed",
        }
    }

    fn timeout_error_message(lifecycle: ExecWaitLifecycle) -> &'static str {
        match lifecycle {
            ExecWaitLifecycle::OneShot => "exec operation timeout",
            ExecWaitLifecycle::Supervised => "supervised exec operation timeout",
        }
    }

    fn log_timeout(&self, seq: u32, poison_on_timeout: bool, lifecycle: ExecWaitLifecycle) {
        match lifecycle {
            ExecWaitLifecycle::OneShot => {
                tracing::warn!(
                    seq = seq,
                    label = %self.diagnostic.label_log,
                    elapsed_ms = self.diagnostic.elapsed_ms(),
                    poison_connection = poison_on_timeout,
                    "exec operation wait timeout"
                );
            }
            ExecWaitLifecycle::Supervised => {
                tracing::warn!(
                    seq = seq,
                    label = %self.diagnostic.label_log,
                    elapsed_ms = self.diagnostic.elapsed_ms(),
                    poison_connection = poison_on_timeout,
                    "supervised exec operation wait timeout"
                );
            }
        }
    }

    pub(in crate::exec_operation) fn new(
        shared: Arc<Shared>,
        seq: u32,
        diagnostic: ExecOperationDiagnostic,
        result_rx: oneshot::Receiver<io::Result<ExecOperationResult>>,
    ) -> Self {
        Self {
            shared,
            seq: Some(seq),
            diagnostic,
            result_rx: Some(result_rx),
        }
    }

    pub(in crate::exec_operation) fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub(in crate::exec_operation) fn diagnostic(&self) -> &ExecOperationDiagnostic {
        &self.diagnostic
    }

    pub(in crate::exec_operation) fn active_seq(&self) -> Option<u32> {
        self.seq
    }

    pub(in crate::exec_operation) fn active_seq_or_closed(
        &self,
        message: &'static str,
    ) -> io::Result<u32> {
        self.seq
            .ok_or_else(|| io::Error::new(io::ErrorKind::ConnectionReset, message))
    }

    pub(in crate::exec_operation) fn remove_operation_if_active(&mut self) {
        if let Some(seq) = self.seq.take() {
            self.shared.remove_operation(seq);
        }
    }

    pub(in crate::exec_operation) fn try_take_ready_result(
        &mut self,
    ) -> io::Result<Option<ExecOperationResult>> {
        let Some(rx) = self.result_rx.as_mut() else {
            return Ok(None);
        };

        match rx.try_recv() {
            Ok(result) => {
                self.seq = None;
                self.result_rx = None;
                result.map(Some)
            }
            Err(oneshot::error::TryRecvError::Empty) => Ok(None),
            Err(oneshot::error::TryRecvError::Closed) => {
                self.seq = None;
                self.result_rx = None;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))
            }
        }
    }

    pub(in crate::exec_operation) async fn wait_with_timeout(
        &mut self,
        timeout: Duration,
        poison_on_timeout: bool,
        lifecycle: ExecWaitLifecycle,
    ) -> io::Result<ExecOperationResult> {
        let seq = self.active_seq_or_closed(Self::operation_closed_message(lifecycle))?;
        let rx = self.result_rx.as_mut().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::ConnectionReset,
                Self::operation_closed_message(lifecycle),
            )
        })?;

        tokio::select! {
            biased;
            result = rx => {
                self.seq = None;
                self.result_rx = None;
                result.map_err(|_| io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ))?
            }
            _ = tokio::time::sleep(timeout) => {
                self.shared.remove_operation(seq);
                self.seq = None;
                self.result_rx = None;
                self.log_timeout(seq, poison_on_timeout, lifecycle);
                if poison_on_timeout {
                    self.shared.poison_connection();
                }
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    Self::timeout_error_message(lifecycle),
                ))
            }
        }
    }
}

impl ExecOperationHandle {
    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<ExecOutputEvent>> {
        self.stream_rx.take()
    }

    /// Wait for the terminal exec result.
    ///
    /// On timeout, this removes the host-side operation registration but does
    /// not cancel the guest-side exec operation. If the request may have
    /// reached the guest, normal operations can become unavailable on this
    /// connection even though the connection itself may still be open.
    pub async fn wait(mut self, timeout: Duration) -> io::Result<ExecOperationResult> {
        self.wait_core
            .wait_with_timeout(timeout, false, ExecWaitLifecycle::OneShot)
            .await
    }

    /// Send an explicit cancel request and wait for a cancelled terminal result.
    ///
    /// If the terminal result is already available before cancel is sent, this
    /// returns that result without sending a duplicate cancel frame. If cancel
    /// is sent but the terminal result does not arrive before `timeout`, the
    /// connection is poisoned because guest process state is no longer known.
    pub async fn cancel_and_wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        let cancel_label_log = self.wait_core.diagnostic().label_log.clone();
        let registered_at = self.wait_core.diagnostic().registered_at;
        let wait_result = self.cancel_and_wait_for_terminal_status(timeout).await?;
        if wait_result.cancel_seq.is_none()
            || wait_result.result.termination == ExecTermination::Cancelled
        {
            if let Some(seq) = wait_result.cancel_seq {
                tracing::info!(
                    seq = seq,
                    label = %cancel_label_log,
                    elapsed_ms = registered_at.elapsed().as_millis(),
                    "exec operation cancel completed"
                );
            }
            return Ok(wait_result.result);
        }

        Err(io::Error::other(format!(
            "exec cancel returned terminal state: {:?}",
            wait_result.result.termination
        )))
    }

    pub(crate) async fn cancel_and_wait_for_terminal(
        self,
        timeout: Duration,
    ) -> io::Result<ExecOperationResult> {
        self.cancel_and_wait_for_terminal_status(timeout)
            .await
            .map(|wait_result| wait_result.result)
    }

    pub(in crate::exec_operation) async fn cancel_and_wait_for_terminal_status(
        mut self,
        timeout: Duration,
    ) -> io::Result<ExecCancelWaitResult> {
        if let Some(result) = self.wait_core.try_take_ready_result()? {
            return Ok(ExecCancelWaitResult {
                result,
                cancel_seq: None,
            });
        }

        let seq = self
            .wait_core
            .active_seq_or_closed(ExecWaitCore::operation_closed_message(
                ExecWaitLifecycle::OneShot,
            ))?;
        let payload = vsock_proto::encode_exec_cancel();
        write_frame(
            self.wait_core.shared(),
            MSG_EXEC_CANCEL,
            seq,
            &payload,
            Some(self.wait_core.diagnostic().frame("cancel")),
            None,
            exec_cancel_write_observer(self.wait_core.shared(), seq),
        )
        .await?;
        tracing::info!(
            seq = seq,
            label = %self.wait_core.diagnostic().label_log,
            elapsed_ms = self.wait_core.diagnostic().elapsed_ms(),
            "exec operation cancel sent"
        );

        let result = self
            .wait_core
            .wait_with_timeout(timeout, true, ExecWaitLifecycle::OneShot)
            .await?;
        Ok(ExecCancelWaitResult {
            result,
            cancel_seq: Some(seq),
        })
    }
}

impl Drop for ExecOperationHandle {
    fn drop(&mut self) {
        self.wait_core.remove_operation_if_active();
    }
}

/// Handle for a host-side supervised exec operation.
///
/// Dropping this handle never sends `MSG_EXEC_CANCEL` and does not remove the
/// operation lifecycle registration. The host keeps the registration until a
/// terminal exec result arrives, the connection closes, or a caller explicitly
/// waits with a timeout that abandons the operation. See the Exec Operation
/// Lifecycle section in the [`crate`] docs for how supervised handles share
/// cancellation and terminal result ownership.
#[must_use = "dropping this handle does not cancel the guest or remove lifecycle registration"]
pub struct SupervisedExecHandle {
    pub(in crate::exec_operation) wait_core: ExecWaitCore,
    pub(in crate::exec_operation) pid: u32,
    pub(in crate::exec_operation) cancel_handle_taken: bool,
    pub(in crate::exec_operation) stream_rx: Option<mpsc::Receiver<ExecOutputEvent>>,
    pub(in crate::exec_operation) control: Option<ExecControlHandle>,
}

/// One-shot handle that sends `MSG_EXEC_CANCEL` for a supervised exec operation.
///
/// Dropping this handle without calling [`SupervisedExecCancelHandle::cancel`]
/// does not send cancellation. The paired [`SupervisedExecHandle`] owns the
/// terminal result.
#[must_use = "dropping this cancel handle does not send MSG_EXEC_CANCEL"]
pub struct SupervisedExecCancelHandle {
    shared: Arc<Shared>,
    seq: u32,
    diagnostic: ExecOperationDiagnostic,
}

impl SupervisedExecCancelHandle {
    /// Send the cancel frame without consuming the terminal exec result.
    ///
    /// The paired [`SupervisedExecHandle`] still owns the result receiver and must
    /// be waited or abandoned by its caller. If this times out before the
    /// cancel frame write starts, the paired handle can still observe the
    /// terminal result.
    pub async fn cancel(self, timeout: Duration) -> io::Result<()> {
        tokio::time::timeout(
            timeout,
            send_supervised_exec_cancel_frame(&self.shared, self.seq, &self.diagnostic),
        )
        .await
        .unwrap_or_else(|_| {
            tracing::warn!(
                seq = self.seq,
                label = %self.diagnostic.label_log,
                elapsed_ms = self.diagnostic.elapsed_ms(),
                "supervised exec operation cancel write timed out"
            );
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "supervised exec cancel write timed out",
            ))
        })
    }
}

impl SupervisedExecHandle {
    /// Guest process id reported by the `exec_started` acknowledgement.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Return a cloneable exec-control handle when control was enabled.
    pub fn control_handle(&self) -> Option<ExecControlHandle> {
        self.control.clone()
    }

    /// Take a one-shot handle that can send `MSG_EXEC_CANCEL` without consuming
    /// this handle's terminal result receiver.
    pub fn take_cancel_handle(&mut self) -> Option<SupervisedExecCancelHandle> {
        if self.cancel_handle_taken {
            return None;
        }
        let seq = self.wait_core.active_seq()?;
        self.cancel_handle_taken = true;
        Some(SupervisedExecCancelHandle {
            shared: Arc::clone(self.wait_core.shared()),
            seq,
            diagnostic: self.wait_core.diagnostic().clone(),
        })
    }

    /// Send an exec-control request for this supervised operation.
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control
            .as_ref()
            .ok_or_else(|| {
                exec_control_status_error(
                    ExecControlStatus::Unsupported,
                    "exec control is not supported by this operation",
                )
            })?
            .control(message_id, payload, timeout)
            .await
    }

    /// Take the bounded output event receiver for streaming operations.
    pub fn take_stream_receiver(&mut self) -> Option<mpsc::Receiver<ExecOutputEvent>> {
        self.stream_rx.take()
    }

    fn clear_unclaimed_stream_sender(&mut self) {
        let Some(seq) = self.wait_core.active_seq() else {
            return;
        };
        if self.stream_rx.take().is_some() {
            clear_exec_operation_stream_sender(self.wait_core.shared(), seq);
        }
    }

    /// Wait for the terminal exec result.
    ///
    /// On timeout, this abandons the host-side operation registration but does
    /// not send `MSG_EXEC_CANCEL`. Because the terminal proof is abandoned
    /// after a guest write, later normal operations become unavailable on this
    /// connection.
    pub async fn wait(mut self, timeout: Duration) -> io::Result<ExecOperationResult> {
        self.clear_unclaimed_stream_sender();
        self.wait_core
            .wait_with_timeout(timeout, false, ExecWaitLifecycle::Supervised)
            .await
    }

    /// Send `MSG_EXEC_CANCEL` and wait for the terminal exec result.
    ///
    /// If the terminal result is already available before cancel is sent, this
    /// returns that result without sending a duplicate cancel frame. If cancel
    /// is sent but the terminal result does not arrive before `timeout`, the
    /// connection is poisoned because guest process state is no longer known.
    pub async fn cancel_and_wait(self, timeout: Duration) -> io::Result<ExecOperationResult> {
        let cancel_label_log = self.wait_core.diagnostic().label_log.clone();
        let registered_at = self.wait_core.diagnostic().registered_at;
        let wait_result = self.cancel_and_wait_for_terminal_status(timeout).await?;
        if wait_result.cancel_seq.is_none()
            || wait_result.result.termination == ExecTermination::Cancelled
        {
            if let Some(seq) = wait_result.cancel_seq {
                tracing::info!(
                    seq = seq,
                    label = %cancel_label_log,
                    elapsed_ms = registered_at.elapsed().as_millis(),
                    "supervised exec operation cancel completed"
                );
            }
            return Ok(wait_result.result);
        }

        Err(io::Error::other(format!(
            "supervised exec cancel returned terminal state: {:?}",
            wait_result.result.termination
        )))
    }

    pub(in crate::exec_operation) async fn cancel_and_wait_for_terminal_status(
        mut self,
        timeout: Duration,
    ) -> io::Result<ExecCancelWaitResult> {
        if let Some(result) = self.wait_core.try_take_ready_result()? {
            return Ok(ExecCancelWaitResult {
                result,
                cancel_seq: None,
            });
        }

        let seq = self
            .wait_core
            .active_seq_or_closed(ExecWaitCore::operation_closed_message(
                ExecWaitLifecycle::Supervised,
            ))?;
        send_supervised_exec_cancel_frame(
            self.wait_core.shared(),
            seq,
            self.wait_core.diagnostic(),
        )
        .await?;

        self.clear_unclaimed_stream_sender();
        let result = self
            .wait_core
            .wait_with_timeout(timeout, true, ExecWaitLifecycle::Supervised)
            .await?;
        Ok(ExecCancelWaitResult {
            result,
            cancel_seq: Some(seq),
        })
    }
}

impl Drop for SupervisedExecHandle {
    fn drop(&mut self) {
        self.clear_unclaimed_stream_sender();
    }
}

/// Cloneable handle for sending control messages to a supervised exec operation.
#[derive(Clone)]
pub struct ExecControlHandle {
    pub(in crate::exec_operation) shared: Arc<Shared>,
    pub(in crate::exec_operation) target_seq: u32,
    pub(in crate::exec_operation) control_nonce: ExecControlNonce,
}

impl ExecControlHandle {
    /// Send an exec-control request and require a delivered acknowledgement.
    ///
    /// `message_id` must be non-empty and fit the protocol string length
    /// bound. `payload` must fit the exec-control payload limit. Invalid
    /// inputs fail before the request frame is written. The timeout is encoded
    /// for guest-side control delivery and also bounds the host wait for a
    /// response after the request frame is written.
    ///
    /// Only [`ExecControlOutcome::Delivered`] is returned as an
    /// [`ExecControlAck`]. Guest statuses and guest error responses are
    /// converted into `io::Error` values.
    pub async fn control(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
    ) -> io::Result<ExecControlAck> {
        self.control_with_write_observer(
            message_id,
            payload,
            timeout,
            FrameWriteObserver::default(),
        )
        .await?
        .into_ack()
    }

    /// Send an exec-control request and return the raw guest outcome.
    ///
    /// This has the same parameter and timeout contract as
    /// [`ExecControlHandle::control`], but returns [`ExecControlOutcome`] so
    /// callers can distinguish delivered requests, non-delivered guest
    /// statuses, and guest error responses.
    pub async fn control_with_write_observer(
        &self,
        message_id: &str,
        payload: &[u8],
        timeout: Duration,
        write_observer: FrameWriteObserver,
    ) -> io::Result<ExecControlOutcome> {
        exec_control_on_shared(
            &self.shared,
            self.target_seq,
            self.control_nonce,
            message_id,
            payload,
            timeout,
            write_observer,
        )
        .await
    }
}

pub(crate) struct ExecOperationCancelOnDropGuard {
    pub(in crate::exec_operation) shared: Option<Arc<Shared>>,
    pub(in crate::exec_operation) seq: u32,
    pub(in crate::exec_operation) diagnostic: ExecOperationDiagnostic,
}

impl ExecOperationCancelOnDropGuard {
    pub(in crate::exec_operation) fn new_for_seq(
        shared: Arc<Shared>,
        seq: u32,
        diagnostic: ExecOperationDiagnostic,
    ) -> Self {
        Self {
            shared: Some(shared),
            seq,
            diagnostic,
        }
    }

    pub(crate) fn new(handle: &ExecOperationHandle) -> Option<Self> {
        Some(Self {
            shared: Some(Arc::clone(handle.wait_core.shared())),
            seq: handle.wait_core.active_seq()?,
            diagnostic: handle.wait_core.diagnostic().clone(),
        })
    }

    #[cfg(test)]
    pub(crate) fn new_supervised(handle: &SupervisedExecHandle) -> Option<Self> {
        Some(Self {
            shared: Some(Arc::clone(handle.wait_core.shared())),
            seq: handle.wait_core.active_seq()?,
            diagnostic: handle.wait_core.diagnostic().clone(),
        })
    }

    pub(crate) fn disarm(&mut self) {
        self.shared = None;
    }
}

impl Drop for ExecOperationCancelOnDropGuard {
    fn drop(&mut self) {
        let Some(shared) = self.shared.take() else {
            return;
        };
        let seq = self.seq;
        let diagnostic = self.diagnostic.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };

        handle.spawn(async move {
            let payload = vsock_proto::encode_exec_cancel();
            let result = tokio::time::timeout(
                EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT,
                write_frame(
                    &shared,
                    MSG_EXEC_CANCEL,
                    seq,
                    &payload,
                    Some(diagnostic.frame("drop-cancel")),
                    None,
                    exec_cancel_write_observer(&shared, seq),
                ),
            )
            .await;
            match result {
                Ok(Ok(())) => {
                    tracing::info!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        "exec operation cancel sent on drop"
                    );
                }
                Ok(Err(err)) => {
                    tracing::warn!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        error = %err,
                        "exec operation cancel on drop failed"
                    );
                }
                Err(_) => {
                    tracing::warn!(
                        seq = seq,
                        label = %diagnostic.label_log,
                        elapsed_ms = diagnostic.elapsed_ms(),
                        "exec operation cancel on drop timed out"
                    );
                }
            }
        });
    }
}

pub(in crate::exec_operation) fn duration_to_request_timeout_ms(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }

    u32::try_from(timeout.as_millis())
        .unwrap_or(u32::MAX)
        .max(1)
}

pub(in crate::exec_operation) async fn exec_control_on_shared(
    shared: &Arc<Shared>,
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
    control_payload: &[u8],
    timeout: Duration,
    write_observer: FrameWriteObserver,
) -> io::Result<ExecControlOutcome> {
    let request_timeout_ms = duration_to_request_timeout_ms(timeout);
    let payload = vsock_proto::encode_exec_control(
        target_seq,
        control_nonce,
        message_id,
        control_payload,
        request_timeout_ms,
    )
    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let request_seq = shared.next_seq();
    let normal_operation = shared.reserve_normal_operation()?;
    let (response_tx, response_rx) = oneshot::channel();
    {
        let mut guard = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            ConnectionState::Closed => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "connection closed",
                ));
            }
            ConnectionState::Connected { operations, .. } => {
                operations.insert_pending_control(
                    target_seq,
                    request_seq,
                    PendingExecControl {
                        target_seq,
                        message_id: message_id.to_owned(),
                        control_nonce,
                        response_tx,
                        normal_operation,
                    },
                )?;
            }
        }
    }
    let _pending_guard = PendingExecControlGuard::new(Arc::clone(shared), request_seq);
    write_frame_with_pre_write(
        shared,
        MSG_EXEC_CONTROL,
        request_seq,
        &payload,
        None,
        || {
            mark_pending_exec_control_possible_guest_write(shared, target_seq, request_seq)?;
            write_observer.record_write_start()
        },
    )
    .await?;

    tokio::select! {
        biased;
        result = response_rx => {
            result.map_err(|_| io::Error::new(
                io::ErrorKind::ConnectionReset,
                "connection closed",
            ))?
        }
        _ = tokio::time::sleep(timeout) => {
            Err(io::Error::new(io::ErrorKind::TimedOut, "request timeout"))
        }
    }
}
