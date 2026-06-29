use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant as StdInstant};

use tokio::sync::oneshot;
use tokio::task::JoinSet;
use tokio::time::Instant as TokioInstant;
use tracing::{error, info, warn};

#[cfg(test)]
use super::CowPoolSnapshot;
use super::create::default_slot_spawner;
use super::{
    AcquireResult, BUFFER_SIZE, CowPoolConfig, CowPoolError, MAX_CONCURRENT_SLOT_CREATIONS,
    MAX_SLOTS, PrewarmedSlot, SlotSpawner, WARM_RETRY_BACKOFF, destroy_slot_async,
};
use crate::duration::duration_ms;

#[derive(Clone, Copy, Debug)]
enum CreationPurpose {
    Demand,
    Warm,
}

pub(super) struct SlotCreationOutcome {
    purpose: CreationPurpose,
    elapsed: Duration,
    result: Result<PrewarmedSlot, CowPoolError>,
}

struct AcquireWaiter {
    requested_at: StdInstant,
    respond_to: oneshot::Sender<AcquireResult>,
}

/// Single-owner state for the bounded one-shot COW slot producer.
pub(super) struct CowPool {
    active: bool,
    ready: VecDeque<PrewarmedSlot>,
    pub(super) pending: JoinSet<SlotCreationOutcome>,
    waiters: VecDeque<AcquireWaiter>,
    warmup_waiters: Vec<oneshot::Sender<()>>,
    buffer_size: usize,
    max_concurrent_creations: usize,
    max_slots: usize,
    warm_retry_backoff: Duration,
    pub(super) warm_retry_at: Option<TokioInstant>,
    config: CowPoolConfig,
    slot_spawner: SlotSpawner,
}

impl CowPool {
    /// Create a new producer without allocating resources.
    pub(super) fn new(config: CowPoolConfig) -> Self {
        Self::new_with_options(
            config,
            BUFFER_SIZE,
            MAX_CONCURRENT_SLOT_CREATIONS,
            MAX_SLOTS,
            WARM_RETRY_BACKOFF,
            default_slot_spawner(),
        )
    }

    pub(super) fn new_with_options(
        config: CowPoolConfig,
        buffer_size: usize,
        max_concurrent_creations: usize,
        max_slots: usize,
        warm_retry_backoff: Duration,
        slot_spawner: SlotSpawner,
    ) -> Self {
        Self {
            active: true,
            ready: VecDeque::with_capacity(buffer_size),
            pending: JoinSet::new(),
            waiters: VecDeque::new(),
            warmup_waiters: Vec::new(),
            buffer_size,
            max_concurrent_creations,
            max_slots,
            warm_retry_backoff,
            warm_retry_at: None,
            config,
            slot_spawner,
        }
    }

    pub(super) fn handle_warmup(&mut self, done: oneshot::Sender<()>) {
        if !self.active {
            let _ = done.send(());
            return;
        }
        self.warmup_waiters.push(done);
        self.pump();
        self.maybe_finish_warmup();
    }

    pub(super) fn handle_acquire(
        &mut self,
        requested_at: StdInstant,
        respond_to: oneshot::Sender<AcquireResult>,
    ) {
        if !self.active {
            let _ = respond_to.send(Err(CowPoolError::NotActive));
            return;
        }

        self.waiters.push_back(AcquireWaiter {
            requested_at,
            respond_to,
        });
        self.pump();
    }

    pub(super) fn pump(&mut self) {
        if !self.active {
            return;
        }

        self.prune_closed_waiters();
        self.assign_ready_slots();
        while !self.waiters.is_empty()
            && self.ready.is_empty()
            && self.pending.is_empty()
            && self.pipeline_slots() >= self.max_slots
        {
            let _ = self.fail_one_waiter(CowPoolError::SlotLimitReached {
                max: self.max_slots,
            });
        }

        let desired_pipeline = self.desired_pipeline_slots();
        if desired_pipeline <= self.pipeline_slots() {
            return;
        }
        if self.waiters.is_empty() && self.warm_retry_at.is_some() {
            return;
        }

        let purpose = if self.waiters.is_empty() {
            CreationPurpose::Warm
        } else {
            CreationPurpose::Demand
        };

        while self.pipeline_slots() < desired_pipeline
            && self.pipeline_slots() < self.max_slots
            && self.pending.len() < self.max_concurrent_creations
        {
            if !self.spawn_slot_creation(purpose) {
                break;
            }
        }
    }

    fn desired_pipeline_slots(&self) -> usize {
        let desired = self.buffer_size.saturating_add(self.waiters.len());
        desired.min(self.max_slots)
    }

    fn pipeline_slots(&self) -> usize {
        self.ready.len() + self.pending.len()
    }

    fn prune_closed_waiters(&mut self) {
        self.waiters.retain(|waiter| !waiter.respond_to.is_closed());
    }

    fn assign_ready_slots(&mut self) {
        while let Some(slot) = self.ready.pop_front() {
            if let AssignOutcome::NoWaiter(slot) = self.assign_slot_to_waiter(slot) {
                self.ready.push_front(slot);
                break;
            }
        }
    }

    fn assign_slot_to_waiter(&mut self, mut slot: PrewarmedSlot) -> AssignOutcome {
        while let Some(waiter) = self.waiters.pop_front() {
            let waited_ms = duration_ms(waiter.requested_at.elapsed());
            let slot_id = slot.id().to_owned();
            match waiter.respond_to.send(Ok(slot)) {
                Ok(()) => {
                    info!(
                        id = %slot_id,
                        waited_ms,
                        ready = self.ready.len(),
                        pending = self.pending.len(),
                        waiters = self.waiters.len(),
                        "acquired COW slot"
                    );
                    return AssignOutcome::Assigned;
                }
                Err(Ok(returned_slot)) => {
                    slot = returned_slot;
                }
                Err(Err(_)) => {
                    return AssignOutcome::Assigned;
                }
            }
        }
        AssignOutcome::NoWaiter(slot)
    }

    fn fail_one_waiter(&mut self, mut error: CowPoolError) -> Option<CowPoolError> {
        while let Some(waiter) = self.waiters.pop_front() {
            match waiter.respond_to.send(Err(error)) {
                Ok(()) => return None,
                Err(Err(returned_error)) => {
                    error = returned_error;
                }
                Err(Ok(slot)) => {
                    self.ready.push_front(slot);
                    return None;
                }
            }
        }
        Some(error)
    }

    fn spawn_slot_creation(&mut self, purpose: CreationPurpose) -> bool {
        if !self.active
            || self.pending.len() >= self.max_concurrent_creations
            || self.pipeline_slots() >= self.max_slots
        {
            return false;
        }

        let config = self.config.clone();
        let spawner = Arc::clone(&self.slot_spawner);
        self.pending.spawn(async move {
            let started = StdInstant::now();
            let handle = spawner(config);
            let result = handle
                .await
                .map_err(|e| CowPoolError::CowFileCreation(format!("join: {e}")))
                .and_then(|result| result);
            SlotCreationOutcome {
                purpose,
                elapsed: started.elapsed(),
                result,
            }
        });
        true
    }

    pub(super) async fn handle_creation_join(
        &mut self,
        completion: Option<Result<SlotCreationOutcome, tokio::task::JoinError>>,
    ) {
        let Some(completion) = completion else {
            self.maybe_finish_warmup();
            return;
        };
        match completion {
            Ok(outcome) => self.handle_creation_outcome(outcome).await,
            Err(e) => {
                self.handle_creation_failure(CowPoolError::CowFileCreation(format!("join: {e}")));
            }
        }
        self.pump();
        self.maybe_finish_warmup();
    }

    async fn handle_creation_outcome(&mut self, outcome: SlotCreationOutcome) {
        let elapsed_ms = duration_ms(outcome.elapsed);
        match outcome.result {
            Ok(slot) => {
                let slot_id = slot.id().to_owned();
                self.warm_retry_at = None;
                if self.active {
                    self.ready.push_back(slot);
                } else {
                    destroy_slot_async(slot).await;
                }
                info!(
                    id = %slot_id,
                    purpose = ?outcome.purpose,
                    elapsed_ms,
                    ready = self.ready.len(),
                    pending = self.pending.len(),
                    waiters = self.waiters.len(),
                    pipeline_slots = self.pipeline_slots(),
                    "COW slot created"
                );
            }
            Err(e) => {
                error!(
                    purpose = ?outcome.purpose,
                    elapsed_ms,
                    error = %e,
                    ready = self.ready.len(),
                    pending = self.pending.len(),
                    waiters = self.waiters.len(),
                    pipeline_slots = self.pipeline_slots(),
                    "COW slot creation failed"
                );
                self.handle_creation_failure(e);
            }
        }
    }

    fn handle_creation_failure(&mut self, error: CowPoolError) {
        if !self.active {
            return;
        }
        if let Some(error) = self.fail_one_waiter(error) {
            warn!(
                error = %error,
                backoff_ms = self.warm_retry_backoff.as_millis() as u64,
                "background COW slot creation failed; delaying warm retry"
            );
            self.schedule_warm_retry();
        } else if self.waiters.is_empty() {
            self.schedule_warm_retry();
        }
    }

    fn schedule_warm_retry(&mut self) {
        if self.warm_retry_at.is_none() {
            self.warm_retry_at = Some(TokioInstant::now() + self.warm_retry_backoff);
        }
    }

    pub(super) fn maybe_finish_warmup(&mut self) {
        if !self.pending.is_empty() || self.warmup_waiters.is_empty() {
            return;
        }

        let waiters = std::mem::take(&mut self.warmup_waiters);
        for done in waiters {
            let _ = done.send(());
        }
        if self.ready.is_empty() {
            warn!(
                "COW pool warmup produced no ready slots - acquire calls will create slots on demand"
            );
        }
        info!(
            ready = self.ready.len(),
            buffer = self.buffer_size,
            "COW pool warmed up"
        );
    }

    /// Shut down the producer and drop all pool-owned slots.
    pub(super) async fn cleanup(&mut self) {
        if !self.active && self.pending.is_empty() && self.ready.is_empty() {
            return;
        }

        let started = StdInstant::now();
        let pending_at_start = self.pending.len();
        let ready_at_start = self.ready.len();
        self.active = false;
        self.warm_retry_at = None;
        self.fail_all_waiters();
        self.finish_warmup_waiters();

        while let Some(slot) = self.ready.pop_front() {
            destroy_slot_async(slot).await;
        }

        while let Some(completion) = self.pending.join_next().await {
            self.handle_cleanup_completion(completion).await;
        }

        info!(
            pending_at_start,
            ready_at_start,
            elapsed_ms = duration_ms(started.elapsed()),
            "COW pool cleanup complete"
        );
    }

    fn fail_all_waiters(&mut self) {
        while let Some(waiter) = self.waiters.pop_front() {
            let _ = waiter.respond_to.send(Err(CowPoolError::NotActive));
        }
    }

    fn finish_warmup_waiters(&mut self) {
        for done in std::mem::take(&mut self.warmup_waiters) {
            let _ = done.send(());
        }
    }

    async fn handle_cleanup_completion(
        &mut self,
        completion: Result<SlotCreationOutcome, tokio::task::JoinError>,
    ) {
        match completion {
            Ok(SlotCreationOutcome {
                result: Ok(slot),
                elapsed,
                ..
            }) => {
                let slot_id = slot.id().to_owned();
                info!(
                    id = %slot_id,
                    elapsed_ms = duration_ms(elapsed),
                    "dropping late COW slot during cleanup"
                );
                destroy_slot_async(slot).await;
            }
            Ok(SlotCreationOutcome {
                result: Err(e),
                elapsed,
                ..
            }) => {
                error!(
                    error = %e,
                    elapsed_ms = duration_ms(elapsed),
                    "pending COW slot creation failed during cleanup"
                );
            }
            Err(e) => {
                error!(error = %e, "pending COW slot task panicked during cleanup");
            }
        }
    }

    #[cfg(test)]
    pub(super) fn snapshot(&self) -> CowPoolSnapshot {
        CowPoolSnapshot {
            ready: self.ready.len(),
            pending: self.pending.len(),
            waiters: self.waiters.len(),
            pipeline_slots: self.pipeline_slots(),
            warm_retry_scheduled: self.warm_retry_at.is_some(),
        }
    }
}

enum AssignOutcome {
    Assigned,
    NoWaiter(PrewarmedSlot),
}

impl Drop for CowPool {
    fn drop(&mut self) {
        if self.active || !self.pending.is_empty() || !self.waiters.is_empty() {
            warn!(
                active = self.active,
                ready = self.ready.len(),
                pending = self.pending.len(),
                waiters = self.waiters.len(),
                pipeline_slots = self.pipeline_slots(),
                "CowPool dropped without cleanup"
            );
        }
    }
}
