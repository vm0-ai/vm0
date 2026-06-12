use std::io;
use std::time::Duration;

mod diagnostics;
mod dispatch;
mod frame;
mod handle;
mod start;
mod state;
mod types;

pub use handle::{
    ExecControlHandle, ExecOperationHandle, SupervisedExecCancelHandle, SupervisedExecHandle,
};
pub use types::{
    ExecCaptureRequest, ExecControlAck, ExecControlGuestStatus, ExecControlOutcome,
    ExecOperationRequest, ExecOperationResult, ExecOutputEvent, ExecOwnedCapturedOutput,
    ExecStreamRequest, SupervisedExecControl, SupervisedExecRequest,
};

pub(crate) use diagnostics::log_operations_closed;
pub(crate) use dispatch::dispatch_incoming_frame;
pub(crate) use handle::ExecOperationCancelOnDropGuard;
pub(crate) use start::{
    append_diagnostic, exec_capture_on_shared, exec_capture_on_shared_with_write_observer,
    exec_capture_with_composite_on_shared_and_observer,
    exec_cleanup_untracked_on_shared_with_write_observer,
    exec_cleanup_with_composite_on_shared_and_observer, exec_on_shared,
    exec_operation_capture_on_shared, exec_operation_stream_on_shared,
    exec_operation_stream_with_composite_on_shared_and_observer, start_exec_operation_on_shared,
    start_supervised_exec_on_shared,
};
pub(crate) use state::Operations;

pub(crate) const DEFAULT_EXEC_CAPTURE_LIMIT_BYTES: u32 = 1024 * 1024;
pub(crate) const SMALL_EXEC_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;
const EXEC_TIMEOUT_EXIT_CODE: i32 = 124;
const DEFAULT_EXEC_STREAM_CAPACITY: usize = 32;
// Large enough for the current 64 MiB guest-log copy cap even when the guest
// emits stream events at the exec-operation drainer's 8 KiB read granularity.
pub(crate) const MAX_EXEC_STREAM_CAPACITY: usize = 8192;
const EXEC_OPERATION_LABEL_LOG_PREFIX_MAX_BYTES: usize = 100;
const EXEC_OPERATION_CLOSE_ACTIVE_LOG_LIMIT: usize = 16;
const EXEC_OPERATION_FRAME_WRITE_SLOW_THRESHOLD: Duration = Duration::from_millis(500);
const EXEC_OPERATION_STAGE_SLOW_THRESHOLD: Duration = Duration::from_secs(5);
const EXEC_OPERATION_DROP_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const EXEC_OPERATION_START_TIMEOUT_CANCEL_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const EXEC_OPERATION_FRAME_WRITE_NOT_STARTED: u8 = 0;
const EXEC_OPERATION_FRAME_WRITE_STARTED: u8 = 1;
const EXEC_OPERATION_FRAME_WRITE_COMPLETED: u8 = 2;

fn exec_operation_protocol_error(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::future::Future;
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::AtomicU8;
    use std::time::Duration;

    use crate::Shared;

    use super::frame::ExecOperationFrameWriteGuard;
    use super::handle::SupervisedExecHandle;
    use super::start::start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout;
    use super::types::SupervisedExecRequest;
    use super::{EXEC_OPERATION_FRAME_WRITE_STARTED, MAX_EXEC_STREAM_CAPACITY};

    pub(crate) const MAX_STREAM_CAPACITY: usize = MAX_EXEC_STREAM_CAPACITY;

    pub(crate) fn drop_started_frame_write_guard(shared: Arc<Shared>) {
        let state = Arc::new(AtomicU8::new(EXEC_OPERATION_FRAME_WRITE_STARTED));
        drop(ExecOperationFrameWriteGuard::new(shared, state));
    }

    pub(crate) async fn start_supervised_exec_after_start_write<F>(
        shared: &Arc<Shared>,
        request: SupervisedExecRequest<'_>,
        after_start_write: F,
        start_timeout_cancel_write_timeout: Duration,
    ) -> io::Result<SupervisedExecHandle>
    where
        F: Future<Output = ()>,
    {
        start_supervised_exec_on_shared_with_after_start_write_and_cancel_timeout(
            shared,
            request,
            after_start_write,
            start_timeout_cancel_write_timeout,
        )
        .await
    }
}

#[cfg(test)]
mod tests;
