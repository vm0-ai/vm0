use std::{
    any::Any,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{Mutex as StdMutex, MutexGuard as StdMutexGuard, TryLockError},
    task::{Context, Poll},
};

use futures_util::{FutureExt, task::noop_waker_ref};
use tokio::task::{JoinError, JoinHandle};
use tracing::{info, warn};

/// Maximum time to wait for explicit factory cleanup tasks during shutdown.
///
/// These tasks own normal destroy/rollback cleanup work. If they stall, abort
/// them before shutting down leak cleanup and factory-owned pools; runner GC
/// remains the final backstop for orphaned host resources.
const FACTORY_CLEANUP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Copy)]
pub(super) enum FactoryCleanupTaskKind {
    Destroy,
    Rollback,
}

impl FactoryCleanupTaskKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Destroy => "destroy",
            Self::Rollback => "rollback",
        }
    }
}

#[derive(Clone)]
struct FactoryCleanupTaskRecord {
    kind: FactoryCleanupTaskKind,
    label: String,
}

struct FactoryCleanupTaskFinished {
    kind: FactoryCleanupTaskKind,
    label: String,
}

struct FactoryCleanupTaskHandle {
    record: FactoryCleanupTaskRecord,
    handle: JoinHandle<FactoryCleanupTaskFinished>,
}

impl FactoryCleanupTaskHandle {
    fn abort(&self) {
        self.handle.abort();
    }

    fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    fn record(&self) -> &FactoryCleanupTaskRecord {
        &self.record
    }
}

impl Future for FactoryCleanupTaskHandle {
    type Output = (
        FactoryCleanupTaskRecord,
        Result<FactoryCleanupTaskFinished, JoinError>,
    );

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let result = match Pin::new(&mut self.handle).poll(cx) {
            Poll::Ready(result) => result,
            Poll::Pending => return Poll::Pending,
        };
        Poll::Ready((self.record.clone(), result))
    }
}

enum FactoryCleanupTaskOutcome {
    Completed,
    Panicked(Box<dyn Any + Send + 'static>),
}

enum FactoryCleanupPanicPolicy {
    Propagate,
    Log,
}

pub(super) struct FactoryCleanupWaiter {
    kind: FactoryCleanupTaskKind,
    label: String,
    rx: tokio::sync::oneshot::Receiver<FactoryCleanupTaskOutcome>,
}

impl FactoryCleanupWaiter {
    async fn wait(self, panic_policy: FactoryCleanupPanicPolicy) {
        match self.rx.await {
            Ok(FactoryCleanupTaskOutcome::Completed) => {}
            Ok(FactoryCleanupTaskOutcome::Panicked(payload)) => match panic_policy {
                FactoryCleanupPanicPolicy::Propagate => std::panic::resume_unwind(payload),
                FactoryCleanupPanicPolicy::Log => {}
            },
            Err(_) => {
                info!(
                    kind = self.kind.as_str(),
                    label = %self.label,
                    "factory cleanup task ended before reporting completion"
                );
            }
        }
    }
}

pub(super) struct FactoryCleanupGroup {
    state: StdMutex<FactoryCleanupGroupState>,
}

struct FactoryCleanupGroupState {
    accepting: bool,
    closed: bool,
    tasks: Vec<FactoryCleanupTaskHandle>,
}

impl FactoryCleanupGroupState {
    fn new() -> Self {
        Self {
            accepting: true,
            closed: false,
            tasks: Vec::new(),
        }
    }
}

struct FactoryCleanupBatch<'a> {
    group: &'a FactoryCleanupGroup,
    tasks: Vec<FactoryCleanupTaskHandle>,
}

impl FactoryCleanupBatch<'_> {
    fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    fn len(&self) -> usize {
        self.tasks.len()
    }

    fn abort_all(&self) {
        for task in &self.tasks {
            task.abort();
        }
    }

    fn records(&self) -> impl Iterator<Item = &FactoryCleanupTaskRecord> {
        self.tasks.iter().map(FactoryCleanupTaskHandle::record)
    }

    async fn next_finished(
        &mut self,
    ) -> Option<(
        FactoryCleanupTaskRecord,
        Result<FactoryCleanupTaskFinished, JoinError>,
    )> {
        std::future::poll_fn(|cx| {
            let mut index = 0;
            while index < self.tasks.len() {
                let poll_result = {
                    let Some(task) = self.tasks.get_mut(index) else {
                        break;
                    };
                    Pin::new(task).poll(cx)
                };
                match poll_result {
                    Poll::Ready(result) => {
                        self.tasks.swap_remove(index);
                        return Poll::Ready(Some(result));
                    }
                    Poll::Pending => {
                        index += 1;
                    }
                }
            }

            if self.tasks.is_empty() {
                Poll::Ready(None)
            } else {
                Poll::Pending
            }
        })
        .await
    }
}

impl Drop for FactoryCleanupBatch<'_> {
    fn drop(&mut self) {
        if self.tasks.is_empty() {
            return;
        }

        let mut state = self.group.lock_state();
        state.tasks.append(&mut self.tasks);
    }
}

pub(super) struct FactoryCleanupRejected<F> {
    kind: FactoryCleanupTaskKind,
    label: String,
    cleanup: F,
}

#[must_use = "factory cleanup registrations must be awaited so closed-group cleanup can run"]
pub(super) enum FactoryCleanupRegistration<F> {
    Waiter(FactoryCleanupWaiter),
    Rejected(FactoryCleanupRejected<F>),
}

impl<F> FactoryCleanupRegistration<F>
where
    F: Future<Output = ()> + Send + 'static,
{
    pub(super) async fn wait_propagating_panic(self) {
        self.wait(FactoryCleanupPanicPolicy::Propagate).await;
    }

    pub(super) async fn wait_logging_panic(self) {
        self.wait(FactoryCleanupPanicPolicy::Log).await;
    }

    async fn wait(self, panic_policy: FactoryCleanupPanicPolicy) {
        match self {
            Self::Waiter(waiter) => waiter.wait(panic_policy).await,
            Self::Rejected(rejected) => rejected.wait(panic_policy).await,
        }
    }
}

impl<F> FactoryCleanupRejected<F>
where
    F: Future<Output = ()> + Send + 'static,
{
    async fn wait(self, panic_policy: FactoryCleanupPanicPolicy) {
        warn!(
            kind = self.kind.as_str(),
            label = %self.label,
            "factory cleanup group is closed; running cleanup in caller task"
        );

        match AssertUnwindSafe(self.cleanup).catch_unwind().await {
            Ok(()) => {}
            Err(payload) => match panic_policy {
                FactoryCleanupPanicPolicy::Propagate => std::panic::resume_unwind(payload),
                FactoryCleanupPanicPolicy::Log => {
                    warn!(
                        kind = self.kind.as_str(),
                        label = %self.label,
                        "factory cleanup task panicked"
                    );
                }
            },
        }
    }
}

impl FactoryCleanupGroup {
    pub(super) fn new() -> Self {
        Self {
            state: StdMutex::new(FactoryCleanupGroupState::new()),
        }
    }

    fn lock_state(&self) -> StdMutexGuard<'_, FactoryCleanupGroupState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                warn!("factory cleanup group state mutex was poisoned; continuing");
                poisoned.into_inner()
            }
        }
    }

    pub(super) fn start_accepting(&self) {
        let mut state = self.lock_state();
        Self::reap_completed_locked(&mut state);
        state.accepting = true;
        state.closed = false;
    }

    pub(super) fn spawn<F>(
        &self,
        kind: FactoryCleanupTaskKind,
        label: impl Into<String>,
        cleanup: F,
    ) -> FactoryCleanupRegistration<F>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let label = label.into();
        let waiter_label = label.clone();
        let mut state = self.lock_state();
        Self::reap_completed_locked(&mut state);
        if state.closed {
            warn!(
                kind = kind.as_str(),
                label = %label,
                "factory cleanup group is closed; rejecting tracked cleanup registration"
            );
            return FactoryCleanupRegistration::Rejected(FactoryCleanupRejected {
                kind,
                label,
                cleanup,
            });
        }

        if !state.accepting {
            warn!(
                kind = kind.as_str(),
                label = %label,
                "factory cleanup group is shutting down; registered cleanup task for shutdown drain"
            );
        }

        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let task = Self::cleanup_task(kind, label.clone(), cleanup, done_tx);
        let handle = tokio::spawn(task);
        state.tasks.push(FactoryCleanupTaskHandle {
            record: FactoryCleanupTaskRecord {
                kind,
                label: label.clone(),
            },
            handle,
        });

        FactoryCleanupRegistration::Waiter(FactoryCleanupWaiter {
            kind,
            label: waiter_label,
            rx: done_rx,
        })
    }

    pub(super) async fn shutdown(&self) {
        let timeout = tokio::time::sleep(FACTORY_CLEANUP_SHUTDOWN_TIMEOUT);
        tokio::pin!(timeout);

        loop {
            let Some(mut batch) = self.take_shutdown_batch() else {
                return;
            };

            if self.drain_shutdown_batch(&mut batch, &mut timeout).await {
                self.abort_remaining_after_shutdown_timeout().await;
                return;
            }
        }
    }

    fn take_shutdown_batch(&self) -> Option<FactoryCleanupBatch<'_>> {
        let mut state = self.lock_state();
        state.accepting = false;
        Self::reap_completed_locked(&mut state);
        if state.tasks.is_empty() {
            state.closed = true;
            return None;
        }
        Some(FactoryCleanupBatch {
            group: self,
            tasks: std::mem::take(&mut state.tasks),
        })
    }

    async fn drain_shutdown_batch(
        &self,
        batch: &mut FactoryCleanupBatch<'_>,
        timeout: &mut std::pin::Pin<&mut tokio::time::Sleep>,
    ) -> bool {
        loop {
            if batch.is_empty() {
                return false;
            }

            tokio::select! {
                result = batch.next_finished() => {
                    let Some((record, result)) = result else {
                        return false;
                    };
                    Self::handle_join_result(record, result, false);
                }
                () = timeout.as_mut() => {
                    let task_count = batch.len();
                    warn!(
                        task_count,
                        timeout_ms = FACTORY_CLEANUP_SHUTDOWN_TIMEOUT.as_millis() as u64,
                        "timed out waiting for factory cleanup tasks; aborting"
                    );
                    for record in batch.records() {
                        warn!(
                            kind = record.kind.as_str(),
                            label = %record.label,
                            "aborting factory cleanup task; runner gc may need to clean leftovers"
                        );
                    }
                    batch.abort_all();
                    while !batch.is_empty() {
                        let Some((record, result)) = batch.next_finished().await else {
                            break;
                        };
                        Self::handle_join_result(record, result, true);
                    }
                    return true;
                }
            }
        }
    }

    async fn abort_remaining_after_shutdown_timeout(&self) {
        loop {
            let mut batch = {
                let mut state = self.lock_state();
                state.accepting = false;
                Self::reap_completed_locked(&mut state);
                if state.tasks.is_empty() {
                    state.closed = true;
                    return;
                }
                FactoryCleanupBatch {
                    group: self,
                    tasks: std::mem::take(&mut state.tasks),
                }
            };

            for record in batch.records() {
                warn!(
                    kind = record.kind.as_str(),
                    label = %record.label,
                    "aborting late factory cleanup task after shutdown timeout"
                );
            }
            batch.abort_all();
            while !batch.is_empty() {
                let Some((record, result)) = batch.next_finished().await else {
                    break;
                };
                Self::handle_join_result(record, result, true);
            }
        }
    }

    async fn cleanup_task<F>(
        kind: FactoryCleanupTaskKind,
        label: String,
        cleanup: F,
        done_tx: tokio::sync::oneshot::Sender<FactoryCleanupTaskOutcome>,
    ) -> FactoryCleanupTaskFinished
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let result = AssertUnwindSafe(cleanup).catch_unwind().await;
        match result {
            Ok(()) => {
                let _ = done_tx.send(FactoryCleanupTaskOutcome::Completed);
            }
            Err(payload) => {
                warn!(
                    kind = kind.as_str(),
                    label = %label,
                    "factory cleanup task panicked"
                );
                let _ = done_tx.send(FactoryCleanupTaskOutcome::Panicked(payload));
            }
        }
        FactoryCleanupTaskFinished { kind, label }
    }

    fn reap_completed_locked(state: &mut FactoryCleanupGroupState) {
        let mut index = 0;
        while index < state.tasks.len() {
            let Some(task) = state.tasks.get(index) else {
                break;
            };
            if !task.is_finished() {
                index += 1;
                continue;
            }

            let mut task = state.tasks.swap_remove(index);
            let waker = noop_waker_ref();
            let mut cx = Context::from_waker(waker);
            match Pin::new(&mut task).poll(&mut cx) {
                Poll::Ready((record, result)) => {
                    Self::handle_join_result(record, result, false);
                }
                Poll::Pending => {
                    state.tasks.insert(index, task);
                    index += 1;
                }
            };
        }
    }

    fn handle_join_result(
        record: FactoryCleanupTaskRecord,
        result: Result<FactoryCleanupTaskFinished, JoinError>,
        after_abort: bool,
    ) {
        match result {
            Ok(finished) => {
                if after_abort {
                    info!(
                        kind = finished.kind.as_str(),
                        label = %finished.label,
                        "factory cleanup task completed while shutdown abort was in progress"
                    );
                }
            }
            Err(err) => {
                let kind = record.kind.as_str();
                let label = record.label;
                if err.is_cancelled() && after_abort {
                    info!(
                        kind,
                        label = %label,
                        "factory cleanup task aborted during shutdown"
                    );
                } else {
                    warn!(
                        kind,
                        label = %label,
                        error = %err,
                        "factory cleanup task exited unexpectedly"
                    );
                }
            }
        }
    }
}

impl Drop for FactoryCleanupGroup {
    fn drop(&mut self) {
        match self.state.try_lock() {
            Ok(mut state) => {
                Self::reap_completed_locked(&mut state);
                if state.tasks.is_empty() {
                    return;
                }
                warn!(
                    task_count = state.tasks.len(),
                    "factory cleanup group dropped with in-flight tasks; aborting without await"
                );
                for task in state.tasks.iter() {
                    task.abort();
                }
            }
            Err(TryLockError::WouldBlock) => {
                warn!("factory cleanup group dropped while locked; cleanup tasks may keep running");
            }
            Err(TryLockError::Poisoned(poisoned)) => {
                let mut state = poisoned.into_inner();
                Self::reap_completed_locked(&mut state);
                if !state.tasks.is_empty() {
                    warn!(
                        task_count = state.tasks.len(),
                        "factory cleanup group dropped with poisoned state and in-flight tasks; aborting without await"
                    );
                    for task in state.tasks.iter() {
                        task.abort();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        panic::AssertUnwindSafe,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use futures_util::FutureExt;

    struct AbortFlag(Arc<AtomicBool>);

    impl Drop for AbortFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    struct SpawnLateCleanupOnDrop {
        group: Arc<FactoryCleanupGroup>,
        late_aborted: Arc<AtomicBool>,
    }

    impl Drop for SpawnLateCleanupOnDrop {
        fn drop(&mut self) {
            let late_flag = AbortFlag(Arc::clone(&self.late_aborted));
            let waiter = self.group.spawn(
                FactoryCleanupTaskKind::Destroy,
                "late-after-timeout",
                async move {
                    let _flag = late_flag;
                    std::future::pending::<()>().await;
                },
            );
            drop(waiter);
        }
    }

    #[tokio::test]
    async fn factory_cleanup_group_returns_completion_to_waiter() {
        let group = FactoryCleanupGroup::new();
        let ran = Arc::new(AtomicBool::new(false));
        let ran_clone = Arc::clone(&ran);

        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            ran_clone.store(true, Ordering::SeqCst);
        });

        waiter.wait_propagating_panic().await;
        group.shutdown().await;

        assert!(ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_keeps_task_after_waiter_abort() {
        let group = Arc::new(FactoryCleanupGroup::new());
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let completed_clone = Arc::clone(&completed);
        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            completed_clone.store(true, Ordering::SeqCst);
        });

        started_rx.await.unwrap();
        let waiter_task = tokio::spawn(waiter.wait_propagating_panic());
        waiter_task.abort();
        assert!(waiter_task.await.unwrap_err().is_cancelled());

        release_tx.send(()).unwrap();
        group.shutdown().await;

        assert!(completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_drains_task_after_waiter_drop_without_waiting() {
        let group = FactoryCleanupGroup::new();
        let completed = Arc::new(AtomicBool::new(false));
        let completed_clone = Arc::clone(&completed);

        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            completed_clone.store(true, Ordering::SeqCst);
        });
        drop(waiter);

        group.shutdown().await;

        assert!(completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_shutdown_waits_for_running_task() {
        let group = Arc::new(FactoryCleanupGroup::new());
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let completed_clone = Arc::clone(&completed);
        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            completed_clone.store(true, Ordering::SeqCst);
        });
        drop(waiter);

        started_rx.await.unwrap();
        let shutdown_group = Arc::clone(&group);
        let shutdown_task = tokio::spawn(async move {
            shutdown_group.shutdown().await;
        });
        tokio::task::yield_now().await;
        assert!(!shutdown_task.is_finished());

        release_tx.send(()).unwrap();
        shutdown_task.await.unwrap();

        assert!(completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_shutdown_cancel_reinserts_running_and_late_tasks() {
        let group = Arc::new(FactoryCleanupGroup::new());
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let late_completed = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let completed_clone = Arc::clone(&completed);
        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            completed_clone.store(true, Ordering::SeqCst);
        });
        drop(waiter);

        started_rx.await.unwrap();
        let shutdown_group = Arc::clone(&group);
        let shutdown_task = tokio::spawn(async move {
            shutdown_group.shutdown().await;
        });
        tokio::task::yield_now().await;
        assert!(!shutdown_task.is_finished());

        shutdown_task.abort();
        assert!(shutdown_task.await.unwrap_err().is_cancelled());

        let late_completed_clone = Arc::clone(&late_completed);
        let late_waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "late", async move {
            late_completed_clone.store(true, Ordering::SeqCst);
        });
        drop(late_waiter);

        let retry_group = Arc::clone(&group);
        let retry_shutdown = tokio::spawn(async move {
            retry_group.shutdown().await;
        });
        tokio::task::yield_now().await;
        assert!(!retry_shutdown.is_finished());

        assert!(release_tx.send(()).is_ok());
        retry_shutdown.await.unwrap();

        assert!(completed.load(Ordering::SeqCst));
        assert!(late_completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_shutdown_drains_late_registered_task() {
        let group = Arc::new(FactoryCleanupGroup::new());
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let late_completed = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "first", async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
        });
        drop(waiter);

        started_rx.await.unwrap();
        let shutdown_group = Arc::clone(&group);
        let shutdown_task = tokio::spawn(async move {
            shutdown_group.shutdown().await;
        });
        tokio::task::yield_now().await;
        assert!(!shutdown_task.is_finished());

        let late_completed_clone = Arc::clone(&late_completed);
        let late_waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "late", async move {
            late_completed_clone.store(true, Ordering::SeqCst);
        });
        drop(late_waiter);

        release_tx.send(()).unwrap();
        shutdown_task.await.unwrap();

        assert!(late_completed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_closed_registration_runs_in_caller_task() {
        let group = FactoryCleanupGroup::new();
        group.shutdown().await;

        let ran = Arc::new(AtomicBool::new(false));
        let ran_clone = Arc::clone(&ran);
        let cleanup = group.spawn(FactoryCleanupTaskKind::Destroy, "closed", async move {
            ran_clone.store(true, Ordering::SeqCst);
        });

        assert!(!ran.load(Ordering::SeqCst));
        cleanup.wait_propagating_panic().await;

        assert!(ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_group_closed_logging_wait_suppresses_panic() {
        let group = FactoryCleanupGroup::new();
        group.shutdown().await;

        let cleanup = group.spawn(FactoryCleanupTaskKind::Rollback, "closed", async {
            panic!("rollback cleanup failed");
        });

        let result = AssertUnwindSafe(cleanup.wait_logging_panic())
            .catch_unwind()
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn factory_cleanup_group_drop_aborts_in_flight_task() {
        let group = FactoryCleanupGroup::new();
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "drop-abort", async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        drop(waiter);

        started_rx.await.unwrap();
        drop(group);

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !aborted.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn factory_cleanup_group_start_accepting_reopens_after_shutdown() {
        let group = Arc::new(FactoryCleanupGroup::new());
        group.shutdown().await;
        group.start_accepting();

        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let completed_clone = Arc::clone(&completed);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "restart", async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            completed_clone.store(true, Ordering::SeqCst);
        });
        drop(waiter);

        started_rx.await.unwrap();
        let shutdown_group = Arc::clone(&group);
        let shutdown_task = tokio::spawn(async move {
            shutdown_group.shutdown().await;
        });
        tokio::task::yield_now().await;
        assert!(!shutdown_task.is_finished());

        release_tx.send(()).unwrap();
        shutdown_task.await.unwrap();

        assert!(completed.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn factory_cleanup_group_shutdown_aborts_stuck_task_after_timeout() {
        let group = FactoryCleanupGroup::new();
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        drop(waiter);

        started_rx.await.unwrap();
        let shutdown = group.shutdown();
        tokio::pin!(shutdown);
        tokio::task::yield_now().await;
        tokio::time::advance(FACTORY_CLEANUP_SHUTDOWN_TIMEOUT).await;
        shutdown.await;

        assert!(aborted.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn factory_cleanup_group_shutdown_aborts_task_registered_during_timeout_abort() {
        let group = Arc::new(FactoryCleanupGroup::new());
        let late_aborted = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let on_drop = SpawnLateCleanupOnDrop {
            group: Arc::clone(&group),
            late_aborted: Arc::clone(&late_aborted),
        };
        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async move {
            let _on_drop = on_drop;
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        drop(waiter);

        started_rx.await.unwrap();
        let shutdown = group.shutdown();
        tokio::pin!(shutdown);
        tokio::task::yield_now().await;
        tokio::time::advance(FACTORY_CLEANUP_SHUTDOWN_TIMEOUT).await;
        shutdown.await;

        assert!(late_aborted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn factory_cleanup_destroy_waiter_propagates_panic() {
        let group = FactoryCleanupGroup::new();
        let waiter = group.spawn(FactoryCleanupTaskKind::Destroy, "sandbox", async {
            panic!("destroy cleanup failed");
        });

        let result = AssertUnwindSafe(waiter.wait_propagating_panic())
            .catch_unwind()
            .await;
        group.shutdown().await;

        assert!(result.is_err());
    }
}
