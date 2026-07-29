use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use crate::ids::RunId;

#[derive(Clone, Debug, Default)]
pub(crate) struct RunCancellationRegistry {
    inner: Arc<Mutex<RunCancellationRegistryState>>,
}

#[derive(Debug, Default)]
struct RunCancellationRegistryState {
    registrations: HashMap<RunId, RunCancellationHandle>,
    hard_stopping: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DuplicateRunCancellationRegistration;

#[derive(Debug)]
#[must_use = "the registration must remain owned until its run is cleaned up"]
pub(crate) struct RunCancellationRegistration {
    registry: RunCancellationRegistry,
    run_id: RunId,
    handle: RunCancellationHandle,
}

#[derive(Clone, Debug)]
pub(crate) struct RunCancellationHandle {
    inner: Arc<RunCancellationInner>,
}

#[derive(Debug)]
struct RunCancellationInner {
    token: CancellationToken,
    user_token: CancellationToken,
    hard_token: CancellationToken,
    transfer_gate: Arc<Mutex<()>>,
}

impl RunCancellationRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn register(
        &self,
        run_id: RunId,
    ) -> Result<RunCancellationRegistration, DuplicateRunCancellationRegistration> {
        let handle = RunCancellationHandle::new();
        let hard_stopping = {
            let mut state = self.inner.lock().await;
            if state.registrations.contains_key(&run_id) {
                return Err(DuplicateRunCancellationRegistration);
            }
            state.registrations.insert(run_id, handle.clone());
            state.hard_stopping
        };
        if hard_stopping {
            handle.hard_cancel().await;
        }
        Ok(RunCancellationRegistration {
            registry: self.clone(),
            run_id,
            handle,
        })
    }

    pub(crate) async fn handle(&self, run_id: RunId) -> Option<RunCancellationHandle> {
        self.inner.lock().await.registrations.get(&run_id).cloned()
    }

    pub(crate) async fn handles_for(
        &self,
        run_ids: &[RunId],
    ) -> HashMap<RunId, RunCancellationHandle> {
        let state = self.inner.lock().await;
        run_ids
            .iter()
            .filter_map(|run_id| {
                state
                    .registrations
                    .get(run_id)
                    .cloned()
                    .map(|handle| (*run_id, handle))
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) async fn contains(&self, run_id: RunId) -> bool {
        self.inner.lock().await.registrations.contains_key(&run_id)
    }

    pub(crate) async fn missing_run_ids(&self, run_ids: &[RunId]) -> Vec<RunId> {
        let state = self.inner.lock().await;
        run_ids
            .iter()
            .copied()
            .filter(|run_id| !state.registrations.contains_key(run_id))
            .collect()
    }

    pub(crate) async fn begin_hard_stop(&self) -> Vec<(RunId, RunCancellationHandle)> {
        let mut state = self.inner.lock().await;
        state.hard_stopping = true;
        state
            .registrations
            .iter()
            .map(|(run_id, handle)| (*run_id, handle.clone()))
            .collect()
    }
}

impl RunCancellationRegistration {
    pub(crate) fn handle(&self) -> RunCancellationHandle {
        self.handle.clone()
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.handle.token()
    }

    #[cfg(test)]
    pub(crate) fn is_cancelled(&self) -> bool {
        self.handle.is_cancelled()
    }

    pub(crate) async fn hard_cancel(&self) -> bool {
        self.handle.hard_cancel().await
    }

    pub(crate) async fn unregister(&self) -> bool {
        let mut state = self.registry.inner.lock().await;
        let is_current = state
            .registrations
            .get(&self.run_id)
            .is_some_and(|handle| handle.same_registration(&self.handle));
        if is_current {
            state.registrations.remove(&self.run_id);
        }
        is_current
    }
}

impl RunCancellationHandle {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RunCancellationInner {
                token: CancellationToken::new(),
                user_token: CancellationToken::new(),
                hard_token: CancellationToken::new(),
                transfer_gate: Arc::new(Mutex::new(())),
            }),
        }
    }

    pub(crate) fn token(&self) -> CancellationToken {
        self.inner.token.clone()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.inner.token.is_cancelled()
    }

    pub(crate) fn user_token(&self) -> CancellationToken {
        self.inner.user_token.clone()
    }

    pub(crate) fn hard_token(&self) -> CancellationToken {
        self.inner.hard_token.clone()
    }

    pub(crate) async fn cancel(&self) -> bool {
        let _transfer_guard = self.inner.transfer_gate.lock().await;
        let was_requested = self.inner.user_token.is_cancelled();
        self.inner.user_token.cancel();
        self.inner.token.cancel();
        !was_requested
    }

    pub(crate) async fn hard_cancel(&self) -> bool {
        let _transfer_guard = self.inner.transfer_gate.lock().await;
        let was_requested = self.inner.hard_token.is_cancelled();
        self.inner.hard_token.cancel();
        self.inner.token.cancel();
        !was_requested
    }

    pub(crate) async fn transfer_guard(&self) -> OwnedMutexGuard<()> {
        self.inner.transfer_gate.clone().lock_owned().await
    }

    pub(crate) fn try_transfer_guard(&self) -> Option<OwnedMutexGuard<()>> {
        self.inner.transfer_gate.clone().try_lock_owned().ok()
    }

    fn same_registration(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicate_registration_preserves_the_active_handle() {
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let registration = registry.register(run_id).await.unwrap();
        let token = registration.token();

        assert_eq!(
            registry.register(run_id).await.unwrap_err(),
            DuplicateRunCancellationRegistration,
        );

        registry.handle(run_id).await.unwrap().cancel().await;
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn registration_before_hard_stop_is_included_in_the_snapshot() {
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let registration = registry.register(run_id).await.unwrap();
        let token = registration.token();
        let hard_token = registration.handle().hard_token();

        let handles = registry.begin_hard_stop().await;

        assert_eq!(handles.len(), 1);
        assert_eq!(handles[0].0, run_id);
        assert!(!token.is_cancelled());
        handles[0].1.hard_cancel().await;
        assert!(token.is_cancelled());
        assert!(hard_token.is_cancelled());
    }

    #[tokio::test]
    async fn registration_after_hard_stop_is_returned_cancelled() {
        let registry = RunCancellationRegistry::new();
        assert!(registry.begin_hard_stop().await.is_empty());

        let registration = registry.register(RunId::new_v4()).await.unwrap();

        assert!(registration.is_cancelled());
        assert!(registration.handle().hard_token().is_cancelled());
        assert!(!registration.handle().user_token().is_cancelled());
    }

    #[tokio::test]
    async fn user_and_hard_cancellation_are_independent_monotonic_signals() {
        let handle = RunCancellationHandle::new();
        let any = handle.token();
        let user = handle.user_token();
        let hard = handle.hard_token();

        assert!(handle.cancel().await);
        assert!(!handle.cancel().await);
        assert!(any.is_cancelled());
        assert!(user.is_cancelled());
        assert!(!hard.is_cancelled());

        assert!(handle.hard_cancel().await);
        assert!(!handle.hard_cancel().await);
        assert!(hard.is_cancelled());
    }

    #[tokio::test]
    async fn stale_registration_does_not_remove_its_replacement() {
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let stale = registry.register(run_id).await.unwrap();
        assert!(stale.unregister().await);
        let replacement = registry.register(run_id).await.unwrap();
        let replacement_token = replacement.token();

        assert!(!stale.unregister().await);
        registry.handle(run_id).await.unwrap().cancel().await;

        assert!(replacement_token.is_cancelled());
    }
}
