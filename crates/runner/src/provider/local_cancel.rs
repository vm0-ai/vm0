use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::ids::RunId;
#[cfg(test)]
use crate::local_queue;
use crate::local_queue::{CancelTargetState, LocalQueue};

/// Poll interval for scanning local cancel markers.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub(super) struct LocalCancelScanner {
    queue: LocalQueue,
    cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    owned_claims: Arc<tokio::sync::Mutex<HashSet<RunId>>>,
}

pub(super) struct LocalCancelWatcher {
    shutdown: CancellationToken,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl LocalCancelScanner {
    pub(super) fn new(
        queue: LocalQueue,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        owned_claims: Arc<tokio::sync::Mutex<HashSet<RunId>>>,
    ) -> Self {
        Self {
            queue,
            cancel_tokens,
            owned_claims,
        }
    }

    /// Scan for `.cancel` files and trigger the corresponding cancel tokens.
    ///
    /// Active markers are deleted only when this runner owns the claim. A token
    /// can exist before `claim()` succeeds, so ownership is tracked separately
    /// to avoid stealing another runner's cancel marker. Markers without a
    /// token are kept while a claim/job may still exist, and are deleted only
    /// after they no longer have a pending target.
    pub(super) async fn scan_cancel_files(&self) {
        let queue = self.queue.clone();
        let cancel_markers =
            match tokio::task::spawn_blocking(move || queue.collect_cancel_markers_sync()).await {
                Ok(markers) => markers,
                Err(e) => {
                    warn!(error = %e, "local: blocking cancel marker scan failed");
                    return;
                }
            };
        if cancel_markers.is_empty() {
            return;
        }

        let cancel_ids: Vec<RunId> = cancel_markers.iter().map(|marker| marker.run_id).collect();
        if cancel_ids.is_empty() {
            return;
        }

        let tokens = self.snapshot_cancel_tokens(&cancel_ids).await;
        let owned_claims = self.snapshot_owned_claims(&cancel_ids).await;

        let mut delete_cancel_ids = Vec::new();
        for marker in cancel_markers {
            let run_id = marker.run_id;
            if let Some(token) = tokens.get(&run_id) {
                let was_cancelled = token.is_cancelled();
                token.cancel();
                if !was_cancelled {
                    info!(run_id = %run_id, "local: cancel file detected, cancelling job");
                }
                let should_delete = owned_claims.contains(&run_id)
                    || marker.target_state == CancelTargetState::NotPending;
                if should_delete {
                    delete_cancel_ids.push(run_id);
                }
            } else if marker.target_state == CancelTargetState::NotPending {
                delete_cancel_ids.push(run_id);
            }
        }

        if !delete_cancel_ids.is_empty() {
            let queue = self.queue.clone();
            if let Err(e) = tokio::task::spawn_blocking(move || {
                queue.remove_cancel_files_sync(delete_cancel_ids)
            })
            .await
            {
                warn!(error = %e, "local: blocking cancel marker cleanup failed");
            }
        }
    }

    async fn snapshot_cancel_tokens(
        &self,
        cancel_ids: &[RunId],
    ) -> HashMap<RunId, CancellationToken> {
        let tokens = self.cancel_tokens.lock().await;
        cancel_ids
            .iter()
            .filter_map(|run_id| tokens.get(run_id).cloned().map(|token| (*run_id, token)))
            .collect()
    }

    async fn snapshot_owned_claims(&self, cancel_ids: &[RunId]) -> HashSet<RunId> {
        let owned = self.owned_claims.lock().await;
        cancel_ids
            .iter()
            .copied()
            .filter(|run_id| owned.contains(run_id))
            .collect()
    }

    pub(super) async fn mark_owned_claim(&self, run_id: RunId) {
        self.owned_claims.lock().await.insert(run_id);
    }

    pub(super) async fn remove_owned_claim(&self, run_id: RunId) {
        self.owned_claims.lock().await.remove(&run_id);
    }

    async fn prune_owned_claims_without_tokens(&self) {
        let owned_ids: Vec<RunId> = {
            let owned = self.owned_claims.lock().await;
            if owned.is_empty() {
                return;
            }
            owned.iter().copied().collect()
        };
        let stale_ids: Vec<RunId> = {
            let tokens = self.cancel_tokens.lock().await;
            owned_ids
                .into_iter()
                .filter(|run_id| !tokens.contains_key(run_id))
                .collect()
        };
        if stale_ids.is_empty() {
            return;
        }

        let mut owned = self.owned_claims.lock().await;
        for run_id in stale_ids {
            owned.remove(&run_id);
        }
    }
}

impl LocalCancelWatcher {
    pub(super) fn start(scanner: LocalCancelScanner) -> Self {
        let shutdown = CancellationToken::new();
        let task_shutdown = shutdown.clone();
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => Some(handle.spawn(async move {
                loop {
                    scanner.prune_owned_claims_without_tokens().await;
                    scanner.scan_cancel_files().await;
                    tokio::select! {
                        () = task_shutdown.cancelled() => break,
                        () = tokio::time::sleep(POLL_INTERVAL) => {}
                    }
                }
            })),
            Err(e) => {
                warn!(error = %e, "local: cancel watcher not started because no tokio runtime is active");
                None
            }
        };

        Self {
            shutdown,
            handle: Mutex::new(handle),
        }
    }

    pub(super) fn disabled() -> Self {
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        Self {
            shutdown,
            handle: Mutex::new(None),
        }
    }

    pub(super) async fn shutdown(&self) {
        self.shutdown.cancel();
        let handle = self
            .handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let Some(handle) = handle else {
            return;
        };
        if let Err(e) = handle.await {
            warn!(error = %e, "local: cancel watcher task failed");
        }
    }
}

impl Drop for LocalCancelWatcher {
    fn drop(&mut self) {
        self.shutdown.cancel();
        let handle = self
            .handle
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = handle {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_cancel_tokens() -> Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> {
        Arc::new(tokio::sync::Mutex::new(HashMap::new()))
    }

    fn scanner(
        dir: &std::path::Path,
        tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    ) -> LocalCancelScanner {
        LocalCancelScanner::new(
            LocalQueue::new(dir.to_path_buf()),
            tokens,
            Arc::new(tokio::sync::Mutex::new(HashSet::new())),
        )
    }

    fn write_job(dir: &std::path::Path, run_id: RunId) {
        let job_path = local_queue::job_path(dir, crate::profile::DEFAULT_PROFILE, run_id).unwrap();
        std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
        std::fs::write(job_path, b"{}").unwrap();
    }

    fn write_cancel(dir: &std::path::Path, run_id: RunId) -> std::path::PathBuf {
        let cancel_path = local_queue::cancel_path(dir, run_id);
        std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
        std::fs::write(&cancel_path, b"").unwrap();
        cancel_path
    }

    fn write_claim(dir: &std::path::Path, run_id: RunId) -> std::path::PathBuf {
        let claim_path = local_queue::claim_path(dir, run_id);
        std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
        std::fs::write(&claim_path, b"").unwrap();
        claim_path
    }

    fn write_result(dir: &std::path::Path, run_id: RunId, content: &[u8]) -> std::path::PathBuf {
        let result_path = local_queue::result_path(dir, run_id);
        std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
        std::fs::write(&result_path, content).unwrap();
        result_path
    }

    #[tokio::test]
    async fn cancel_file_triggers_token() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        write_job(dir.path(), run_id);
        write_cancel(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(job_token.is_cancelled(), "cancel token should be triggered");
    }

    #[tokio::test]
    async fn cancel_file_deleted_after_owned_trigger() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        write_job(dir.path(), run_id);
        let cancel_path = write_cancel(dir.path(), run_id);
        let scanner = scanner(dir.path(), tokens);
        scanner.mark_owned_claim(run_id).await;

        scanner.scan_cancel_files().await;

        assert!(job_token.is_cancelled(), "cancel token should be triggered");
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after triggering an owned token"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_preclaim_token_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        write_job(dir.path(), run_id);
        let cancel_path = write_cancel(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "pre-claim token should be cancelled"
        );
        assert!(
            cancel_path.exists(),
            "cancel file should stay until this runner owns the claim"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_preclaim_token_and_other_runner_claim_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        let cancel_path = write_cancel(dir.path(), run_id);
        write_claim(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "pre-claim token should still observe cancellation"
        );
        assert!(
            cancel_path.exists(),
            "cancel file should stay for the runner that owns the claim"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_token_but_no_pending_target_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        let cancel_path = write_cancel(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "stale token should still be cancelled"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted when no claim or job target remains"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_token_terminal_result_and_leftover_claim_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"terminal");
        write_claim(dir.path(), run_id);

        scanner(dir.path(), tokens).scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "stale token should still observe the cancel"
        );
        assert!(
            !cancel_path.exists(),
            "terminal result should let stale token markers be deleted"
        );
    }

    #[tokio::test]
    async fn cancel_watcher_triggers_owned_token_without_discover() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), Arc::clone(&tokens));
        let run_id = RunId::new_v4();
        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        write_job(dir.path(), run_id);
        write_cancel(dir.path(), run_id);
        scanner.mark_owned_claim(run_id).await;

        let watcher = LocalCancelWatcher::start(scanner);
        tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
            .await
            .expect("cancel watcher should trigger token");

        watcher.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_watcher_shutdown_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = LocalCancelWatcher::start(scanner(dir.path(), empty_cancel_tokens()));

        tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
            .await
            .expect("first shutdown should complete");
        tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
            .await
            .expect("second shutdown should complete");
    }

    #[tokio::test]
    async fn owned_claim_without_cancel_token_is_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let run_id = RunId::new_v4();
        tokens.lock().await.insert(run_id, CancellationToken::new());
        let scanner = scanner(dir.path(), Arc::clone(&tokens));
        scanner.mark_owned_claim(run_id).await;
        assert!(
            scanner
                .snapshot_owned_claims(&[run_id])
                .await
                .contains(&run_id),
            "claim should be tracked as locally owned"
        );

        scanner.prune_owned_claims_without_tokens().await;
        assert!(
            scanner
                .snapshot_owned_claims(&[run_id])
                .await
                .contains(&run_id),
            "owned claim should stay while its cancel token is still active"
        );

        tokens.lock().await.remove(&run_id);
        scanner.prune_owned_claims_without_tokens().await;

        assert!(
            !scanner
                .snapshot_owned_claims(&[run_id])
                .await
                .contains(&run_id),
            "owned claim should be pruned after token cleanup"
        );
    }

    #[tokio::test]
    async fn cancel_file_without_pending_target_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let unknown_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), unknown_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted when no pending target exists"
        );
    }

    #[tokio::test]
    async fn cancel_file_is_kept_when_job_scan_fails() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        std::fs::write(local_queue::jobs_dir(dir.path()), b"not a directory").unwrap();

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            cancel_path.exists(),
            "cancel file should stay when the pending target state is unknown"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_claim_owned_by_other_runner_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_claim(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            cancel_path.exists(),
            "cancel file should be kept when another runner may own the claim"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_terminal_result_and_leftover_job_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"terminal");
        write_job(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted when the result is already terminal"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_terminal_result_and_leftover_claim_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"terminal");
        write_claim(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            !cancel_path.exists(),
            "terminal result should make a leftover claim non-pending"
        );
    }

    #[tokio::test]
    async fn cancel_file_with_empty_result_and_pending_job_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_result(dir.path(), run_id, b"");
        write_job(dir.path(), run_id);

        scanner(dir.path(), empty_cancel_tokens())
            .scan_cancel_files()
            .await;

        assert!(
            cancel_path.exists(),
            "empty result file is not terminal, so cancel should stay pending"
        );
    }

    #[tokio::test]
    async fn cancel_file_before_token_survives_until_token_inserted() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = empty_cancel_tokens();
        let scanner = scanner(dir.path(), Arc::clone(&tokens));
        let run_id = RunId::new_v4();
        let cancel_path = write_cancel(dir.path(), run_id);
        write_job(dir.path(), run_id);

        scanner.scan_cancel_files().await;
        assert!(
            cancel_path.exists(),
            "cancel file should survive while there is no token"
        );

        let job_token = CancellationToken::new();
        tokens.lock().await.insert(run_id, job_token.clone());
        scanner.mark_owned_claim(run_id).await;
        scanner.scan_cancel_files().await;

        assert!(
            job_token.is_cancelled(),
            "token should be cancelled on second scan"
        );
        assert!(
            !cancel_path.exists(),
            "cancel file should be deleted after trigger"
        );
    }
}
