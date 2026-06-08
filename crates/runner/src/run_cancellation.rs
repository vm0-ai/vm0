use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use crate::ids::RunId;

pub(crate) type SharedRunCancellationMap = Arc<Mutex<HashMap<RunId, RunCancellationHandle>>>;

#[derive(Clone, Debug)]
pub(crate) struct RunCancellationHandle {
    inner: Arc<RunCancellationInner>,
}

#[derive(Debug)]
struct RunCancellationInner {
    token: CancellationToken,
    transfer_gate: Arc<Mutex<()>>,
}

impl RunCancellationHandle {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RunCancellationInner {
                token: CancellationToken::new(),
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

    pub(crate) async fn cancel(&self) -> bool {
        let _transfer_guard = self.inner.transfer_gate.lock().await;
        let was_cancelled = self.inner.token.is_cancelled();
        self.inner.token.cancel();
        !was_cancelled
    }

    pub(crate) async fn transfer_guard(&self) -> OwnedMutexGuard<()> {
        self.inner.transfer_gate.clone().lock_owned().await
    }

    pub(crate) fn try_transfer_guard(&self) -> Option<OwnedMutexGuard<()>> {
        self.inner.transfer_gate.clone().try_lock_owned().ok()
    }
}
