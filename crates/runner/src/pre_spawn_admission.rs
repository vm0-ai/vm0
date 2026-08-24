use std::collections::BTreeSet;
use std::fs::File;
use std::sync::Arc;
use std::time::Duration;

use nix::fcntl::Flock;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::{RunnerError, RunnerResult};
use crate::lock::{self, TryLock};
use crate::paths::HomePaths;

const TOKEN_RETRY_DELAY: Duration = Duration::from_millis(10);

#[derive(Clone)]
pub(crate) struct PreSpawnAdmission {
    inner: Arc<PreSpawnAdmissionInner>,
}

struct PreSpawnAdmissionInner {
    home: HomePaths,
    total_tokens: u32,
    local_turn: Mutex<()>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PreSpawnAdmissionMetadata {
    pub(crate) requested_tokens: u32,
    pub(crate) effective_tokens: u32,
    pub(crate) total_tokens: u32,
    pub(crate) contended: bool,
}

pub(crate) struct PreSpawnAdmissionLease {
    _tokens: Vec<Flock<File>>,
    metadata: PreSpawnAdmissionMetadata,
}

impl PreSpawnAdmissionLease {
    pub(crate) fn metadata(&self) -> PreSpawnAdmissionMetadata {
        self.metadata
    }
}

impl PreSpawnAdmission {
    pub(crate) fn new(home: HomePaths, total_tokens: u32) -> RunnerResult<Self> {
        if total_tokens == 0 {
            return Err(RunnerError::Internal(
                "pre-spawn admission capacity must be positive".into(),
            ));
        }
        Ok(Self {
            inner: Arc::new(PreSpawnAdmissionInner {
                home,
                total_tokens,
                local_turn: Mutex::new(()),
            }),
        })
    }

    pub(crate) fn total_tokens(&self) -> u32 {
        self.inner.total_tokens
    }

    pub(crate) async fn acquire(
        &self,
        requested_tokens: u32,
        cancel: &CancellationToken,
    ) -> RunnerResult<PreSpawnAdmissionLease> {
        if requested_tokens == 0 {
            return Err(RunnerError::Internal(
                "pre-spawn admission request must be positive".into(),
            ));
        }

        let effective_tokens = requested_tokens.min(self.inner.total_tokens);
        let mut contended = false;
        let local_turn = match self.inner.local_turn.try_lock() {
            Ok(local_turn) => local_turn,
            Err(_) => {
                contended = true;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(RunnerError::Cancelled),
                    local_turn = self.inner.local_turn.lock() => local_turn,
                }
            }
        };

        let turnstile_path = self.inner.home.pre_spawn_admission_turnstile_lock();
        let turnstile = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(RunnerError::Cancelled),
            result = lock::try_acquire_or_busy(turnstile_path.clone()) => result?,
        };
        let turnstile = match turnstile {
            TryLock::Acquired(turnstile) => turnstile,
            TryLock::Busy => {
                contended = true;
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(RunnerError::Cancelled),
                    result = lock::acquire(turnstile_path) => result?,
                }
            }
        };

        let mut held_indices = BTreeSet::new();
        let mut tokens = Vec::with_capacity(effective_tokens as usize);
        while tokens.len() < effective_tokens as usize {
            for token in 0..self.inner.total_tokens {
                if held_indices.contains(&token) {
                    continue;
                }
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(RunnerError::Cancelled),
                    result = lock::try_acquire_or_busy(
                        self.inner.home.pre_spawn_admission_token_lock(token),
                    ) => result?,
                };
                match result {
                    TryLock::Acquired(guard) => {
                        held_indices.insert(token);
                        tokens.push(guard);
                        if tokens.len() == effective_tokens as usize {
                            break;
                        }
                    }
                    TryLock::Busy => contended = true,
                }
            }

            if tokens.len() < effective_tokens as usize {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(RunnerError::Cancelled),
                    () = tokio::time::sleep(TOKEN_RETRY_DELAY) => {}
                }
            }
        }

        if cancel.is_cancelled() {
            return Err(RunnerError::Cancelled);
        }
        drop(turnstile);
        drop(local_turn);

        Ok(PreSpawnAdmissionLease {
            _tokens: tokens,
            metadata: PreSpawnAdmissionMetadata {
                requested_tokens,
                effective_tokens,
                total_tokens: self.inner.total_tokens,
                contended,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::os::unix::fs::symlink;
    use std::panic::AssertUnwindSafe;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);

    fn admissions(total_tokens: u32) -> (tempfile::TempDir, PreSpawnAdmission, PreSpawnAdmission) {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let first = PreSpawnAdmission::new(home.clone(), total_tokens).unwrap();
        let second = PreSpawnAdmission::new(home, total_tokens).unwrap();
        (dir, first, second)
    }

    fn assert_pending<T>(future: Pin<&mut impl Future<Output = T>>) {
        let waker = futures_util::task::noop_waker();
        let mut context = Context::from_waker(&waker);
        assert!(matches!(future.poll(&mut context), Poll::Pending));
    }

    async fn wait_for_local_turn(admission: &PreSpawnAdmission) {
        tokio::time::timeout(TEST_TIMEOUT, async {
            loop {
                if admission.inner.local_turn.try_lock().is_err() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn independent_instances_share_weighted_capacity() {
        let (_dir, first, second) = admissions(3);
        let cancel = CancellationToken::new();
        let first_lease = first.acquire(2, &cancel).await.unwrap();
        let second_lease = second.acquire(1, &cancel).await.unwrap();
        let mut blocked = Box::pin(second.acquire(1, &cancel));

        assert_pending(blocked.as_mut());
        drop(second_lease);
        let acquired = tokio::time::timeout(TEST_TIMEOUT, blocked)
            .await
            .unwrap()
            .unwrap();

        assert!(acquired.metadata().contended);
        drop(first_lease);
    }

    #[tokio::test]
    async fn cancelled_partial_request_releases_every_token() {
        let (_dir, first, second) = admissions(2);
        let holder_cancel = CancellationToken::new();
        let holder = first.acquire(1, &holder_cancel).await.unwrap();
        let waiter_cancel = CancellationToken::new();
        let mut waiter = Box::pin(second.acquire(2, &waiter_cancel));

        assert_pending(waiter.as_mut());
        waiter_cancel.cancel();
        assert!(matches!(
            tokio::time::timeout(TEST_TIMEOUT, waiter).await.unwrap(),
            Err(RunnerError::Cancelled)
        ));
        drop(holder);

        let full = tokio::time::timeout(TEST_TIMEOUT, first.acquire(2, &holder_cancel))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(full.metadata().effective_tokens, 2);
    }

    #[tokio::test]
    async fn local_mixed_weight_waiters_keep_fifo_order() {
        let (_dir, admission, other) = admissions(2);
        let holder_cancel = CancellationToken::new();
        let holder = other.acquire(1, &holder_cancel).await.unwrap();
        let first_cancel = CancellationToken::new();
        let mut first = tokio::spawn({
            let admission = admission.clone();
            let cancel = first_cancel.clone();
            async move { admission.acquire(2, &cancel).await }
        });
        wait_for_local_turn(&admission).await;
        tokio::time::timeout(TEST_TIMEOUT, async {
            loop {
                match lock::try_acquire_or_busy(
                    admission.inner.home.pre_spawn_admission_token_lock(1),
                )
                .await
                .unwrap()
                {
                    TryLock::Busy => break,
                    TryLock::Acquired(token) => drop(token),
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let second_cancel = CancellationToken::new();
        let second = tokio::spawn({
            let admission = admission.clone();
            let cancel = second_cancel.clone();
            async move { admission.acquire(1, &cancel).await }
        });
        tokio::task::yield_now().await;
        drop(holder);

        let first_lease = tokio::time::timeout(TEST_TIMEOUT, &mut first)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            !second.is_finished(),
            "later light waiter bypassed the earlier weighted waiter"
        );
        drop(first_lease);
        tokio::time::timeout(TEST_TIMEOUT, second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn oversized_request_runs_alone() {
        let (_dir, first, second) = admissions(2);
        let cancel = CancellationToken::new();
        let oversized = first.acquire(8, &cancel).await.unwrap();
        assert_eq!(
            oversized.metadata(),
            PreSpawnAdmissionMetadata {
                requested_tokens: 8,
                effective_tokens: 2,
                total_tokens: 2,
                contended: false,
            }
        );
        let mut blocked = Box::pin(second.acquire(1, &cancel));
        assert_pending(blocked.as_mut());

        drop(oversized);
        tokio::time::timeout(TEST_TIMEOUT, blocked)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn drop_and_unwind_release_capacity() {
        let (_dir, first, second) = admissions(1);
        let cancel = CancellationToken::new();

        let lease = first.acquire(1, &cancel).await.unwrap();
        drop(lease);
        second.acquire(1, &cancel).await.unwrap();

        let lease = first.acquire(1, &cancel).await.unwrap();
        let panic = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _lease = lease;
            panic!("release admission lease during unwind");
        }));
        assert!(panic.is_err());
        second.acquire(1, &cancel).await.unwrap();
    }

    #[tokio::test]
    async fn unsafe_token_path_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        std::fs::create_dir_all(home.locks_dir()).unwrap();
        symlink("missing", home.pre_spawn_admission_token_lock(0)).unwrap();
        let admission = PreSpawnAdmission::new(home, 1).unwrap();

        assert!(matches!(
            admission.acquire(1, &CancellationToken::new()).await,
            Err(RunnerError::Internal(_))
        ));
    }
}
