#[cfg(test)]
use std::path::Path;
use std::time::Instant;

use crate::device_lock::NbdDeviceClaim;
use crate::error::{NbdCowError, Result};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

use super::lease::{DeviceAcquisition, DeviceLease};
use super::scan::{ScanRequest, ScannedDeviceClaim};
#[cfg(test)]
use super::state::DevicePoolSnapshot;
use super::state::{DevicePool, DevicePoolConfig};

/// Cloneable handle to the cooperative NBD device pool.
///
/// All clones share one background actor and command channel. That actor owns
/// the pool state machine and serializes transitions for `/dev/nbdN` claims,
/// pending scans, cooldown slots, and checked-out [`DeviceLease`] returns.
///
/// The handle coordinates this process-local pool state, while cooperative
/// cross-process safety still comes from shared per-index lock files and sysfs
/// checks.
///
/// Successful acquisitions come either from a demand scan or from an expired
/// clean-release claim. Demand scans acquire a per-index lock and re-check
/// sysfs. Clean releases retain the claim and lock during cooldown; after
/// cooldown, a queued waiter may receive that claim after a sysfs free check,
/// without a new scan or lock acquisition. If no waiter is queued or the free
/// check fails, the expired claim is dropped and its lock is released.
///
/// Dropping a handle is not normal device cleanup. Checked-out leases also carry
/// return senders, so dropping every handle only stops the actor after
/// outstanding leases release those senders. Successful pooled devices must
/// finish through an explicit [`crate::PooledNbdCowDevice`] finalizer such as
/// [`crate::PooledNbdCowDevice::destroy_with_retries`],
/// [`crate::PooledNbdCowDevice::destroy_keep_cow_with_retries`], or
/// [`crate::PooledNbdCowDevice::abandon`].
#[derive(Clone)]
pub struct DevicePoolHandle {
    commands: mpsc::UnboundedSender<DevicePoolCommand>,
}

#[derive(Clone, Copy)]
pub(super) enum LeaseReturnAction {
    ReleaseClean,
    Discard,
    RetireUncertain,
}

#[derive(Clone, Copy)]
enum LeaseReturnOperation {
    CleanRelease,
    Discard,
    UncertainRetire,
    DetachedUncertainRetire,
}

impl LeaseReturnOperation {
    fn action(self) -> LeaseReturnAction {
        match self {
            Self::CleanRelease => LeaseReturnAction::ReleaseClean,
            Self::Discard => LeaseReturnAction::Discard,
            Self::UncertainRetire | Self::DetachedUncertainRetire => {
                LeaseReturnAction::RetireUncertain
            }
        }
    }

    fn missing_claim_message(self) -> &'static str {
        match self {
            Self::CleanRelease => "device lease missing claim before clean release",
            Self::Discard => "device lease missing claim before discard",
            Self::UncertainRetire => "device lease missing claim before uncertain retire",
            Self::DetachedUncertainRetire => {
                "device lease missing claim before detached uncertain retire"
            }
        }
    }

    fn actor_stopped_message(self) -> &'static str {
        match self {
            Self::CleanRelease => "device pool actor stopped before clean release",
            Self::Discard => "device pool actor stopped before discard",
            Self::UncertainRetire => "device pool actor stopped before uncertain retire",
            Self::DetachedUncertainRetire => {
                "device pool actor stopped before detached uncertain retire"
            }
        }
    }
}

pub(super) enum DevicePoolCommand {
    Acquire {
        respond_to: oneshot::Sender<Result<DeviceAcquisition>>,
    },
    ReturnLease {
        action: LeaseReturnAction,
        claim: NbdDeviceClaim,
        done: oneshot::Sender<()>,
    },
    Cleanup {
        done: oneshot::Sender<()>,
    },
    #[cfg(test)]
    Snapshot {
        respond_to: oneshot::Sender<DevicePoolSnapshot>,
    },
}

struct DevicePoolActor {
    pool: DevicePool,
    commands: mpsc::UnboundedReceiver<DevicePoolCommand>,
    pending: JoinSet<Result<ScannedDeviceClaim>>,
    active_scan: Option<ScanRequest>,
    scan_exhausted: bool,
    scan_faulted: bool,
}

impl DevicePoolHandle {
    /// Create a new shared device pool handle.
    ///
    /// Must be called from a Tokio runtime: this spawns the background actor
    /// that backs the returned handle and all of its clones.
    pub fn new(config: DevicePoolConfig) -> Self {
        Self::from_pool(DevicePool::new(config))
    }

    #[cfg(test)]
    pub(crate) fn new_one_device_for_test(config: DevicePoolConfig, lock_dir: &Path) -> Self {
        Self::from_pool(DevicePool::new_with_options(
            config,
            1,
            lock_dir.to_path_buf(),
            |_| true,
        ))
    }

    #[cfg(test)]
    pub(super) fn from_pool(pool: DevicePool) -> Self {
        Self::from_pool_with_pending(pool, JoinSet::new())
    }

    #[cfg(not(test))]
    fn from_pool(pool: DevicePool) -> Self {
        Self::from_pool_with_pending(pool, JoinSet::new())
    }

    #[cfg(test)]
    pub(super) fn from_pool_with_pending(
        pool: DevicePool,
        pending: JoinSet<Result<ScannedDeviceClaim>>,
    ) -> Self {
        Self::spawn_actor(pool, pending)
    }

    #[cfg(not(test))]
    fn from_pool_with_pending(
        pool: DevicePool,
        pending: JoinSet<Result<ScannedDeviceClaim>>,
    ) -> Self {
        Self::spawn_actor(pool, pending)
    }

    fn spawn_actor(mut pool: DevicePool, pending: JoinSet<Result<ScannedDeviceClaim>>) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        pool.set_lease_return(commands.downgrade());
        tokio::spawn(
            DevicePoolActor {
                pool,
                commands: command_rx,
                pending,
                active_scan: None,
                scan_exhausted: false,
                scan_faulted: false,
            }
            .run(),
        );
        Self { commands }
    }

    /// Clean up the underlying pool state.
    ///
    /// If the actor is still accepting commands, this waits for cleanup to be
    /// acknowledged. When the cleanup command is processed, cleanup deactivates
    /// the pool, fails acquire waiters still queued in the pool and later
    /// acquire attempts, prevents pending scan results from satisfying waiters,
    /// drains the pending scan set, and clears the pool's cooldown queue and
    /// in-flight bookkeeping.
    ///
    /// Scans run on Tokio's blocking task pool, so cleanup may still wait for a
    /// scan that has already started to return before the acknowledgement is
    /// sent. Deactivation happens first, so late scan results are discarded
    /// rather than handed to acquire waiters.
    ///
    /// Cleanup does not replace per-device finalization. Outstanding
    /// [`DeviceLease`] values still own their NBD claim until they are returned
    /// or dropped, and [`crate::PooledNbdCowDevice`] values still own device
    /// finalization. Finish successful pooled devices with
    /// [`crate::PooledNbdCowDevice::destroy_with_retries`],
    /// [`crate::PooledNbdCowDevice::destroy_keep_cow_with_retries`], or
    /// [`crate::PooledNbdCowDevice::abandon`].
    pub async fn cleanup(&self) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Cleanup { done })
            .is_ok()
        {
            let _ = done_rx.await;
        }
    }

    pub(crate) async fn acquire(&self) -> Result<DeviceAcquisition> {
        let (respond_to, response) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Acquire { respond_to })
            .is_err()
        {
            return Err(actor_stopped_error());
        }
        response.await.map_err(|_| actor_stopped_error())?
    }

    pub(crate) async fn release_clean(&self, lease: DeviceLease) {
        if let Some(done_rx) = self.enqueue_lease_return(lease, LeaseReturnOperation::CleanRelease)
        {
            let _ = done_rx.await;
        }
    }

    pub(crate) async fn discard(&self, lease: DeviceLease) {
        if let Some(done_rx) = self.enqueue_lease_return(lease, LeaseReturnOperation::Discard) {
            let _ = done_rx.await;
        }
    }

    pub(crate) async fn retire_uncertain(&self, lease: DeviceLease) {
        if let Some(done_rx) =
            self.enqueue_lease_return(lease, LeaseReturnOperation::UncertainRetire)
        {
            let _ = done_rx.await;
        }
    }

    pub(crate) fn retire_uncertain_detached(&self, lease: DeviceLease) {
        let _ = self.enqueue_lease_return(lease, LeaseReturnOperation::DetachedUncertainRetire);
    }

    fn enqueue_lease_return(
        &self,
        lease: DeviceLease,
        operation: LeaseReturnOperation,
    ) -> Option<oneshot::Receiver<()>> {
        let Some(claim) = lease.into_claim() else {
            tracing::warn!("{}", operation.missing_claim_message());
            return None;
        };
        let index = claim.index();
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::ReturnLease {
                action: operation.action(),
                claim,
                done,
            })
            .is_err()
        {
            tracing::warn!(
                device_index = index,
                "{}",
                operation.actor_stopped_message()
            );
            return None;
        }
        Some(done_rx)
    }

    #[cfg(test)]
    pub(crate) async fn snapshot(&self) -> DevicePoolSnapshot {
        let (respond_to, response) = oneshot::channel();
        self.commands
            .send(DevicePoolCommand::Snapshot { respond_to })
            .expect("device pool actor stopped before snapshot");
        response.await.expect("device pool actor dropped snapshot")
    }

    #[cfg(test)]
    pub(super) fn weak_commands(&self) -> mpsc::WeakUnboundedSender<DevicePoolCommand> {
        self.commands.downgrade()
    }
}

async fn sleep_until_deadline(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    } else {
        std::future::pending::<()>().await;
    }
}

impl DevicePoolActor {
    async fn run(mut self) {
        loop {
            self.ensure_waiting_progress();
            let deadline = self.pool.next_cooldown_deadline();
            let has_pending = !self.pending.is_empty();

            tokio::select! {
                command = self.commands.recv() => {
                    let Some(command) = command else {
                        break;
                    };
                    self.handle_command(command).await;
                }
                scan = self.pending.join_next(), if has_pending => {
                    self.handle_scan_join(scan);
                    self.ensure_waiting_progress();
                }
                () = sleep_until_deadline(deadline), if deadline.is_some() => {
                    self.handle_cooldown_deadline();
                }
            }
        }

        self.pool.deactivate();
        self.abort_pending().await;
    }

    async fn handle_command(&mut self, command: DevicePoolCommand) {
        match command {
            DevicePoolCommand::Acquire { respond_to } => {
                self.pool.handle_acquire(respond_to, self.pending.len());
                self.spawn_waiting_scans();
            }
            DevicePoolCommand::ReturnLease {
                action,
                claim,
                done,
            } => {
                match action {
                    LeaseReturnAction::ReleaseClean => self.pool.release_claim(claim),
                    LeaseReturnAction::Discard => self.pool.discard_claim(claim),
                    LeaseReturnAction::RetireUncertain => self.pool.retire_uncertain_claim(claim),
                }
                self.ensure_waiting_progress();
                let _ = done.send(());
            }
            DevicePoolCommand::Cleanup { done } => {
                self.pool.begin_cleanup();
                self.abort_pending().await;
                self.pool.finish_cleanup();
                let _ = done.send(());
            }
            #[cfg(test)]
            DevicePoolCommand::Snapshot { respond_to } => {
                let _ = respond_to.send(self.pool.snapshot());
            }
        }
    }

    fn handle_cooldown_deadline(&mut self) {
        self.pool.process_expired_cooldown();
        self.ensure_waiting_progress();
    }

    fn ensure_waiting_progress(&mut self) {
        let pending_scans = self.pending.len();
        if pending_scans == 0 {
            // One worker can reach the end of the shared cursor while peers are
            // still checking offsets they already reserved. Exhaustion becomes
            // authoritative only after every worker in the cohort has joined.
            if self.scan_faulted {
                self.reset_scan_cohort();
            } else if self.scan_exhausted {
                self.pool.defer_scan_exhaustion();
                self.reset_scan_cohort();
            } else if self.pool.waiting_acquires.is_empty() {
                self.active_scan = None;
            }
        }
        self.pool.ensure_waiting_progress(pending_scans);
        self.spawn_waiting_scans();
    }

    fn spawn_waiting_scans(&mut self) {
        if self.scan_exhausted || self.scan_faulted {
            return;
        }
        let scans_to_spawn = self.pool.scans_to_spawn(self.pending.len());
        for _ in 0..scans_to_spawn {
            self.spawn_scan();
        }
    }

    fn spawn_scan(&mut self) {
        let request = self
            .active_scan
            .get_or_insert_with(|| self.pool.scan_request())
            .clone();
        self.pending.spawn_blocking(move || request.run());
    }

    fn handle_scan_join(
        &mut self,
        scan: Option<std::result::Result<Result<ScannedDeviceClaim>, tokio::task::JoinError>>,
    ) {
        match scan {
            Some(Ok(Ok(scanned))) => self.pool.handle_scan_claim(scanned),
            Some(Ok(Err(NbdCowError::NoFreeDevice))) if !self.scan_faulted => {
                self.scan_exhausted = true;
            }
            Some(Ok(Err(NbdCowError::NoFreeDevice))) => {}
            Some(Ok(Err(error))) => self.handle_scan_fault(error),
            Some(Err(error)) => self.handle_scan_fault(NbdCowError::Io(std::io::Error::other(
                format!("device scan task failed: {error}"),
            ))),
            None => {}
        }
    }

    fn handle_scan_fault(&mut self, error: NbdCowError) {
        // A failed worker may have reserved an offset without completing its
        // checks, so this cohort can no longer prove clean exhaustion.
        self.scan_faulted = true;
        self.scan_exhausted = false;
        self.pool.defer_acquire_error(error);
    }

    fn reset_scan_cohort(&mut self) {
        self.active_scan = None;
        self.scan_exhausted = false;
        self.scan_faulted = false;
    }

    async fn abort_pending(&mut self) {
        self.pending.abort_all();
        while self.pending.join_next().await.is_some() {}
        self.reset_scan_cohort();
    }
}

fn actor_stopped_error() -> NbdCowError {
    NbdCowError::Io(std::io::Error::other("device pool actor stopped"))
}
