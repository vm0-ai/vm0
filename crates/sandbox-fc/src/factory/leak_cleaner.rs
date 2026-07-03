use tracing::{info, warn};

use crate::cow_cleanup::CowCleanupOutcome;
use crate::factory::cow_cleanup::destroy_cow_device_with_retries;
use crate::leaked_resources::LeakedResources;
use crate::network::NetnsPoolHandle;

/// Maximum time to wait for leaked-resource cleanup during normal shutdown.
///
/// Shutdown is the graceful path, so already-queued leak reports should drain
/// before the pool Arcs are unwrapped. If cleanup gets stuck, fall back to
/// aborting and let the next `runner gc` clean leftovers. This must exceed the
/// COW destroy retry budget because leaked sandbox cleanup now owns the pooled
/// COW device and may need a full finalizer pass before releasing netns/dirs.
const LEAK_CLEANUP_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub(super) struct LeakCleaner {
    tx: Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl LeakCleaner {
    pub(super) fn spawn(netns_pool: NetnsPoolHandle) -> Self {
        // Drop cannot await, and losing a leak report can strand host resources.
        // Keep this unbounded: reports only come from exceptional cleanup paths,
        // with runner GC as the final backstop if the cleaner stalls.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(drain_leaked_resources(rx, shutdown_rx, netns_pool));
        Self {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        }
    }

    pub(super) fn sender(&self) -> Option<tokio::sync::mpsc::UnboundedSender<LeakedResources>> {
        self.tx.clone()
    }

    #[cfg(test)]
    pub(super) fn from_parts_for_test(
        tx: tokio::sync::mpsc::UnboundedSender<LeakedResources>,
        shutdown_tx: tokio::sync::oneshot::Sender<()>,
        handle: tokio::task::JoinHandle<()>,
    ) -> Self {
        Self {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        }
    }

    pub(super) async fn shutdown(mut self) {
        self.tx.take();
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        let Some(mut handle) = self.handle.take() else {
            return;
        };

        tokio::select! {
            result = &mut handle => {
                if let Err(e) = result {
                    warn!(error = %e, "leak cleanup task exited unexpectedly");
                }
            }
            () = tokio::time::sleep(LEAK_CLEANUP_SHUTDOWN_TIMEOUT) => {
                warn!(
                    timeout_ms = LEAK_CLEANUP_SHUTDOWN_TIMEOUT.as_millis() as u64,
                    "timed out waiting for leak cleanup task; aborting"
                );
                handle.abort();
                if let Err(e) = handle.await
                    && !e.is_cancelled()
                {
                    warn!(error = %e, "leak cleanup task failed after abort");
                }
            }
        }
    }

    #[cfg(test)]
    fn abort(&mut self) {
        // Drop handles first, then abort immediately as a synchronous Drop backstop.
        self.tx.take();
        self.shutdown_tx.take();
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }

    fn detach_for_drop(&mut self) {
        self.tx.take();
        self.shutdown_tx.take();
        // Dropping JoinHandle detaches the task. If the runtime is still alive,
        // the drain loop can finish queued cleanup and accept leak reports from
        // live sandbox sender clones without blocking this synchronous Drop path.
        self.handle.take();
    }
}

impl Drop for LeakCleaner {
    fn drop(&mut self) {
        self.detach_for_drop();
    }
}

async fn drain_leaked_resources(
    rx: tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    netns_pool: NetnsPoolHandle,
) {
    drain_leaked_resources_with_cleanup(rx, shutdown_rx, move |leaked| {
        let netns_pool = netns_pool.clone();
        async move {
            cleanup_leaked_resource(leaked, &netns_pool).await;
        }
    })
    .await;
}

async fn drain_leaked_resources_with_cleanup<C, Fut>(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<LeakedResources>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
    mut cleanup: C,
) where
    C: FnMut(LeakedResources) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut shutdown_rx = Some(shutdown_rx);
    loop {
        tokio::select! {
            biased;
            shutdown = wait_for_leak_cleaner_shutdown(&mut shutdown_rx) => {
                if shutdown {
                    rx.close();
                    while let Some(leaked) = rx.recv().await {
                        cleanup(leaked).await;
                    }
                    break;
                }
            }
            maybe_leaked = rx.recv() => {
                let Some(leaked) = maybe_leaked else {
                    break;
                };
                cleanup(leaked).await;
            }
        }
    }
}

async fn wait_for_leak_cleaner_shutdown(
    shutdown_rx: &mut Option<tokio::sync::oneshot::Receiver<()>>,
) -> bool {
    let Some(rx) = shutdown_rx.as_mut() else {
        return std::future::pending::<bool>().await;
    };

    match rx.await {
        Ok(()) => true,
        Err(_) => {
            *shutdown_rx = None;
            false
        }
    }
}

async fn cleanup_leaked_resource(leaked: LeakedResources, netns_pool: &NetnsPoolHandle) {
    warn!(
        id = %leaked.sandbox_id,
        has_cow_device = leaked.cow_device.is_some(),
        has_network = leaked.network.is_some(),
        "cleaning up leaked sandbox resources"
    );

    let cow_cleanup_outcome = match leaked.cow_device {
        Some(cow_device) => destroy_cow_device_with_retries(&leaked.sandbox_id, cow_device).await,
        None => CowCleanupOutcome::BackingFilesSafeToDelete,
    };

    if let Some(network) = leaked.network {
        let mut network = Some(network);
        let outcome = netns_pool.release(&mut network).await;
        if let Some(message) = outcome.invalid_message() {
            warn!(id = %leaked.sandbox_id, error = %message, "failed to release leaked netns");
        }
    }
    if let Err(e) = tokio::fs::remove_dir_all(&leaked.sock_dir).await {
        warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked sock dir");
    }
    if cow_cleanup_outcome.backing_files_safe_to_delete()
        && leaked.delete_workspace
        && let Err(e) = tokio::fs::remove_dir_all(&leaked.workspace).await
    {
        warn!(id = %leaked.sandbox_id, error = %e, "failed to delete leaked workspace");
    }
    info!(id = %leaked.sandbox_id, "leaked sandbox resources cleaned up");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use crate::cow_cleanup::cow_destroy_retry_policy;
    use crate::network::NetnsPool;

    fn test_leaked_resource(sandbox_id: &str) -> LeakedResources {
        LeakedResources {
            sandbox_id: sandbox_id.into(),
            cow_device: None,
            network: None,
            sock_dir: PathBuf::from("/nonexistent"),
            workspace: PathBuf::from("/nonexistent"),
            delete_workspace: true,
        }
    }

    #[tokio::test]
    async fn cleanup_leaked_resource_respects_workspace_preservation() {
        let tmp = tempfile::tempdir().unwrap();
        let sock_dir = tmp.path().join("sock");
        let workspace = tmp.path().join("workspace");
        tokio::fs::create_dir_all(&sock_dir).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let netns_pool = NetnsPoolHandle::new_for_test(NetnsPool::inactive_for_test());

        cleanup_leaked_resource(
            LeakedResources {
                sandbox_id: "sandbox".into(),
                cow_device: None,
                network: None,
                sock_dir: sock_dir.clone(),
                workspace: workspace.clone(),
                delete_workspace: false,
            },
            &netns_pool,
        )
        .await;

        assert!(!sock_dir.exists());
        assert!(workspace.exists());
    }

    #[tokio::test]
    async fn drain_leaked_resources_shutdown_closes_receiver_and_drains_buffer() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        for index in 0..64 {
            tx.send(test_leaked_resource(&format!("leaked-{index}")))
                .unwrap();
        }

        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let handle = tokio::spawn(drain_leaked_resources_with_cleanup(
            rx,
            shutdown_rx,
            move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            },
        ));

        shutdown_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .unwrap()
            .unwrap();

        let expected: Vec<String> = (0..64).map(|index| format!("leaked-{index}")).collect();
        assert_eq!(*cleaned.lock().await, expected);
        assert!(matches!(
            live_sender_clone.send(test_leaked_resource("late")),
            Err(tokio::sync::mpsc::error::SendError(_))
        ));
    }

    #[tokio::test]
    async fn drain_leaked_resources_exits_after_sender_close() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (_shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        tx.send(test_leaked_resource("first")).unwrap();
        tx.send(test_leaked_resource("second")).unwrap();
        drop(tx);

        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        drain_leaked_resources_with_cleanup(rx, shutdown_rx, move |leaked| {
            let cleaned = Arc::clone(&cleaned_clone);
            async move {
                cleaned.lock().await.push(leaked.sandbox_id);
            }
        })
        .await;

        assert_eq!(
            *cleaned.lock().await,
            vec!["first".to_string(), "second".to_string()]
        );
    }

    #[tokio::test]
    async fn leak_cleaner_shutdown_signals_drain_with_live_sender_clone() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let _live_sender_clone = tx.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let drained = Arc::new(AtomicBool::new(false));
        let drained_clone = Arc::clone(&drained);
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    rx.close();
                    while rx.recv().await.is_some() {}
                    drained_clone.store(true, Ordering::SeqCst);
                }
                _ = rx.recv() => {
                    panic!("leak cleaner did not signal shutdown before receiver completion");
                }
            }
        });

        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };
        cleaner.shutdown().await;

        assert!(drained.load(Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn leak_cleaner_shutdown_aborts_after_timeout() {
        struct AbortFlag(Arc<AtomicBool>);

        impl Drop for AbortFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };

        started_rx.await.unwrap();
        let shutdown = cleaner.shutdown();
        tokio::pin!(shutdown);
        tokio::task::yield_now().await;
        tokio::time::advance(LEAK_CLEANUP_SHUTDOWN_TIMEOUT).await;
        shutdown.await;

        assert!(aborted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn leak_cleaner_drop_detaches_drain_and_keeps_live_senders_usable() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let live_sender_clone = tx.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let handle = tokio::spawn(async move {
            drain_leaked_resources_with_cleanup(rx, shutdown_rx, move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            })
            .await;
            done_tx.send(()).unwrap();
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };

        live_sender_clone
            .send(test_leaked_resource("queued"))
            .unwrap();
        drop(cleaner);
        live_sender_clone
            .send(test_leaked_resource("late"))
            .unwrap();
        drop(live_sender_clone);

        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            *cleaned.lock().await,
            vec!["queued".to_string(), "late".to_string()]
        );
    }

    #[tokio::test]
    async fn leak_cleaner_drop_without_sender_clones_lets_drain_exit() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let cleaned = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cleaned_clone = Arc::clone(&cleaned);
        let handle = tokio::spawn(async move {
            drain_leaked_resources_with_cleanup(rx, shutdown_rx, move |leaked| {
                let cleaned = Arc::clone(&cleaned_clone);
                async move {
                    cleaned.lock().await.push(leaked.sandbox_id);
                }
            })
            .await;
            done_tx.send(()).unwrap();
        });
        let cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };

        drop(cleaner);

        tokio::time::timeout(std::time::Duration::from_secs(1), done_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(cleaned.lock().await.is_empty());
    }

    #[test]
    fn leak_cleaner_shutdown_timeout_covers_cow_destroy_retry_budget() {
        let retry_policy = cow_destroy_retry_policy();
        let retry_budget = retry_policy
            .delay
            .checked_mul(retry_policy.attempts)
            .expect("destroy retry budget should fit in Duration");

        assert!(
            LEAK_CLEANUP_SHUTDOWN_TIMEOUT > retry_budget,
            "leak cleaner shutdown timeout must allow queued COW finalizers to finish"
        );
    }

    #[tokio::test]
    async fn leak_cleaner_abort_closes_sender_and_aborts_task() {
        struct AbortFlag(Arc<AtomicBool>);

        impl Drop for AbortFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<LeakedResources>();
        let (shutdown_tx, _shutdown_rx) = tokio::sync::oneshot::channel();
        let aborted = Arc::new(AtomicBool::new(false));
        let aborted_clone = Arc::clone(&aborted);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(async move {
            let _flag = AbortFlag(aborted_clone);
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        let mut cleaner = LeakCleaner {
            tx: Some(tx),
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        };

        started_rx.await.unwrap();
        cleaner.abort();

        assert!(cleaner.tx.is_none());
        assert!(cleaner.shutdown_tx.is_none());
        assert!(cleaner.handle.is_none());
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !aborted.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
