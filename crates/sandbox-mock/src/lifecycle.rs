use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::sandbox::Result;

use crate::support::LockIgnoringPoison;

enum LifecycleBehavior {
    Result(Result<()>),
    Panic(String),
}

impl LifecycleBehavior {
    fn into_result(self) -> Result<()> {
        match self {
            Self::Result(result) => result,
            #[allow(clippy::panic)]
            Self::Panic(message) => panic!("{message}"),
        }
    }
}

#[derive(Default)]
pub(crate) struct LifecycleBehaviors {
    queue: Mutex<VecDeque<LifecycleBehavior>>,
}

impl LifecycleBehaviors {
    pub(crate) fn push_result(&self, result: Result<()>) {
        self.queue
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Result(result));
    }

    pub(crate) fn push_panic(&self, message: impl Into<String>) {
        self.queue
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Panic(message.into()));
    }

    pub(crate) fn next_result(&self) -> Result<()> {
        let behavior = self.queue.lock_ignoring_poison().pop_front();
        behavior.map_or(Ok(()), LifecycleBehavior::into_result)
    }
}

pub(crate) enum DestroyBehavior {
    Panic(String),
}

/// Error returned when a [`MockLifecycleGate`] does not record enough entries
/// before the caller's timeout expires.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct MockLifecycleGateTimeout {
    target_count: u64,
    actual_count: u64,
    timeout: Duration,
}

impl MockLifecycleGateTimeout {
    /// Entry count that the caller was waiting for.
    pub fn target_count(&self) -> u64 {
        self.target_count
    }

    /// Entry count observed when the timeout expired.
    pub fn actual_count(&self) -> u64 {
        self.actual_count
    }

    /// Timeout used by the wait operation.
    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

impl std::fmt::Display for MockLifecycleGateTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "mock lifecycle gate did not reach entry count {} within {:?} (actual: {})",
            self.target_count, self.timeout, self.actual_count
        )
    }
}

impl std::error::Error for MockLifecycleGateTimeout {}

struct MockLifecycleGateInner {
    state: Mutex<MockLifecycleGateState>,
    entered_tx: tokio::sync::watch::Sender<u64>,
    release_tx: tokio::sync::watch::Sender<u64>,
}

struct MockLifecycleGateState {
    entered_count: u64,
    released_count: u64,
}

/// Durable lifecycle gate for tests that need to block mock sandbox lifecycle
/// operations at deterministic points.
///
/// Unlike raw [`tokio::sync::Notify`] pairs, entries and releases are counted
/// durably. A test can wait for an entry after it has already happened, and a
/// release issued before the lifecycle operation blocks is consumed by that
/// entry instead of being lost. Releases advance entry tickets, so a cancelled
/// entry still consumes its ticket instead of transferring that release to a
/// later lifecycle operation.
#[derive(Clone)]
pub struct MockLifecycleGate {
    inner: Arc<MockLifecycleGateInner>,
}

impl MockLifecycleGate {
    /// Create a gate with zero recorded entries and no releases.
    pub fn new() -> Self {
        let (entered_tx, _) = tokio::sync::watch::channel(0);
        let (release_tx, _) = tokio::sync::watch::channel(0);
        Self {
            inner: Arc::new(MockLifecycleGateInner {
                state: Mutex::new(MockLifecycleGateState {
                    entered_count: 0,
                    released_count: 0,
                }),
                entered_tx,
                release_tx,
            }),
        }
    }

    /// Return the number of lifecycle entries recorded by this gate.
    pub fn entered_count(&self) -> u64 {
        self.inner.state.lock_ignoring_poison().entered_count
    }

    /// Wait until at least `target_count` lifecycle entries have been recorded.
    pub async fn wait_entered(
        &self,
        target_count: u64,
        timeout: Duration,
    ) -> std::result::Result<u64, MockLifecycleGateTimeout> {
        let gate = self.clone();
        let wait = async move {
            let mut entered_rx = gate.inner.entered_tx.subscribe();
            loop {
                let current = *entered_rx.borrow_and_update();
                if current >= target_count {
                    return current;
                }
                if entered_rx.changed().await.is_err() {
                    // The waiter owns a gate clone, so sender closure should not
                    // happen. Let the outer timeout report failure instead of
                    // returning a below-target count as success.
                    return std::future::pending().await;
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| MockLifecycleGateTimeout {
                target_count,
                actual_count: self.entered_count(),
                timeout,
            })
    }

    /// Release the next lifecycle entry ticket.
    pub fn release_one(&self) {
        self.release_many(1);
    }

    /// Release `count` lifecycle entry tickets by advancing the durable
    /// release count.
    ///
    /// Cancelled entries still occupy tickets. If a blocked lifecycle future is
    /// cancelled, a later release advances past that cancelled ticket instead of
    /// being reused by a future entry.
    pub fn release_many(&self, count: usize) {
        let release_count = u64::try_from(count).unwrap_or(u64::MAX);
        if release_count == 0 {
            return;
        }

        let mut state = self.inner.state.lock_ignoring_poison();
        state.released_count = state.released_count.saturating_add(release_count);
        self.inner.release_tx.send_replace(state.released_count);
    }

    pub(crate) async fn enter_and_wait(&self) {
        let ticket = {
            let mut state = self.inner.state.lock_ignoring_poison();
            state.entered_count = state.entered_count.saturating_add(1);
            self.inner.entered_tx.send_replace(state.entered_count);
            state.entered_count
        };
        let mut release_rx = self.inner.release_tx.subscribe();
        loop {
            let released_count = *release_rx.borrow_and_update();
            if released_count >= ticket {
                return;
            }
            if release_rx.changed().await.is_err() {
                // The waiter owns a gate clone, so sender closure should not
                // happen. Keep waiting rather than letting this entry through.
                std::future::pending::<()>().await;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn released_count(&self) -> u64 {
        self.inner.state.lock_ignoring_poison().released_count
    }
}

impl Default for MockLifecycleGate {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub(crate) enum BlockingGate {
    LegacyNotify {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    Lifecycle(MockLifecycleGate),
}

pub(crate) async fn wait_blocking_gate(gate: &Mutex<Option<BlockingGate>>) {
    let gate = gate.lock_ignoring_poison().clone();
    if let Some(gate) = gate {
        match gate {
            BlockingGate::LegacyNotify { entered, release } => {
                entered.notify_waiters();
                release.notified().await;
            }
            BlockingGate::Lifecycle(gate) => gate.enter_and_wait().await,
        }
    }
}
