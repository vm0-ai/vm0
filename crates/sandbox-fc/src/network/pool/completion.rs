use std::future::Future;

use tokio::sync::{mpsc, watch};
use tracing::warn;

use super::super::error::{NetworkError, Result};
use super::host::{NamespaceDeleteOutcome, NetnsLifecycleOps};
use super::types::NetnsInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct PendingId(pub(super) u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NetnsKind {
    Plain,
    Proxy,
}

pub(super) struct CreationCompletion {
    pub(super) id: PendingId,
    pub(super) kind: NetnsKind,
    pub(super) result: Result<NetnsInfo>,
}

pub(super) struct PreparedCreationWait {
    pub(super) completions: Vec<CreationCompletion>,
    pub(super) receiver: watch::Receiver<()>,
}

/// Owns durable creation completions and the broadcast signal used by waiters.
///
/// The mpsc queue is the source of truth. The watch channel is only a progress
/// hint, so every caller that may wait must use [`Self::prepare_wait`].
pub(super) struct CreationCompletionCoordinator {
    tx: mpsc::UnboundedSender<CreationCompletion>,
    rx: mpsc::UnboundedReceiver<CreationCompletion>,
    wake_tx: watch::Sender<()>,
}

impl CreationCompletionCoordinator {
    pub(super) fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let (wake_tx, _) = watch::channel(());
        Self { tx, rx, wake_tx }
    }

    pub(super) fn notifier(&self, ops: NetnsLifecycleOps) -> CreationNotifier {
        CreationNotifier {
            tx: self.tx.clone(),
            wake_tx: self.wake_tx.clone(),
            ops,
        }
    }

    pub(super) fn try_recv(&mut self) -> Option<CreationCompletion> {
        self.rx.try_recv().ok()
    }

    fn drain(&mut self) -> Vec<CreationCompletion> {
        let mut completions = Vec::new();
        while let Some(completion) = self.try_recv() {
            completions.push(completion);
        }
        completions
    }

    /// Arms a wake receiver before draining so a caller cannot miss a completion
    /// between deciding to wait and observing the durable queue.
    pub(super) fn prepare_wait(&mut self) -> PreparedCreationWait {
        let receiver = self.wake_tx.subscribe();
        let completions = self.drain();
        PreparedCreationWait {
            completions,
            receiver,
        }
    }

    #[cfg(test)]
    pub(super) fn enqueue_for_test(&self, completion: CreationCompletion) {
        self.tx.send(completion).expect("completion receiver open");
    }
}

#[derive(Clone)]
pub(super) struct CreationNotifier {
    tx: mpsc::UnboundedSender<CreationCompletion>,
    wake_tx: watch::Sender<()>,
    ops: NetnsLifecycleOps,
}

impl CreationNotifier {
    pub(super) async fn send(self, completion: CreationCompletion) {
        match self.tx.send(completion) {
            Ok(()) => self.wake(),
            Err(err) => {
                let completion = err.0;
                if let Ok(ns) = completion.result {
                    warn!(
                        name = %ns.name,
                        host_device = %ns.host_device,
                        "namespace creation completed after pool receiver dropped; deleting"
                    );
                    let outcome = self
                        .ops
                        .delete_network_resources(vec![ns.clone()], None)
                        .await;
                    if matches!(outcome, NamespaceDeleteOutcome::Abandoned) {
                        warn!(
                            name = %ns.name,
                            host_device = %ns.host_device,
                            "failed to delete namespace after completion delivery failed; startup orphan reconciliation will retry"
                        );
                    }
                }
                self.wake();
            }
        }
    }

    fn wake(&self) {
        // Watch versions every successful send; the payload itself is unused.
        // With no receiver, the mpsc queue still retains the completion.
        let _ = self.wake_tx.send(());
    }
}

pub(super) fn spawn_creation_worker<F>(
    id: PendingId,
    kind: NetnsKind,
    notifier: CreationNotifier,
    future: F,
) where
    F: Future<Output = Result<NetnsInfo>> + Send + 'static,
{
    let worker = tokio::spawn(future);
    tokio::spawn(async move {
        let result = match worker.await {
            Ok(result) => result,
            Err(error) => Err(join_error_to_creation_error(error, kind)),
        };
        notifier.send(CreationCompletion { id, kind, result }).await;
    });
}

fn join_error_to_creation_error(error: tokio::task::JoinError, kind: NetnsKind) -> NetworkError {
    if error.is_panic() {
        NetworkError::Prerequisite(format!(
            "{kind:?} namespace creation task panicked: {error}"
        ))
    } else {
        NetworkError::Prerequisite(format!(
            "{kind:?} namespace creation task cancelled: {error}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed_completion(id: u64) -> CreationCompletion {
        CreationCompletion {
            id: PendingId(id),
            kind: NetnsKind::Plain,
            result: Err(NetworkError::Prerequisite("test completion".into())),
        }
    }

    #[tokio::test]
    async fn prepare_wait_drains_completion_sent_without_receiver() {
        let mut coordinator = CreationCompletionCoordinator::new();
        let notifier = coordinator.notifier(NetnsLifecycleOps::trusted_for_test());
        notifier.send(failed_completion(1)).await;

        let prepared = coordinator.prepare_wait();

        assert_eq!(prepared.completions.len(), 1);
        assert_eq!(prepared.completions[0].id, PendingId(1));
        assert!(!prepared.receiver.has_changed().unwrap());
    }

    #[tokio::test]
    async fn prepared_receiver_observes_later_completion() {
        let mut coordinator = CreationCompletionCoordinator::new();
        let notifier = coordinator.notifier(NetnsLifecycleOps::trusted_for_test());
        let prepared = coordinator.prepare_wait();
        assert!(prepared.completions.is_empty());

        notifier.send(failed_completion(2)).await;

        assert!(prepared.receiver.has_changed().unwrap());
        let completion = coordinator.try_recv().unwrap();
        assert_eq!(completion.id, PendingId(2));
    }

    #[tokio::test]
    async fn one_completion_wakes_all_prepared_receivers_and_drains_once() {
        let mut coordinator = CreationCompletionCoordinator::new();
        let notifier = coordinator.notifier(NetnsLifecycleOps::trusted_for_test());
        let first = coordinator.prepare_wait();
        let second = coordinator.prepare_wait();

        notifier.send(failed_completion(3)).await;

        assert!(first.receiver.has_changed().unwrap());
        assert!(second.receiver.has_changed().unwrap());
        let completion = coordinator.try_recv().unwrap();
        assert_eq!(completion.id, PendingId(3));
        assert!(coordinator.try_recv().is_none());
    }
}
