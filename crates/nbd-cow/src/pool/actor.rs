use std::time::Instant;

use crate::device_lock::NbdDeviceClaim;
use crate::error::{NbdCowError, Result};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

use super::lease::DeviceLease;
#[cfg(test)]
use super::state::DevicePoolSnapshot;
use super::state::{DevicePool, DevicePoolConfig};

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
        respond_to: oneshot::Sender<Result<DeviceLease>>,
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
    pending: JoinSet<Result<NbdDeviceClaim>>,
}

impl DevicePoolHandle {
    /// Create a new shared device pool handle.
    ///
    /// Must be called from a Tokio runtime: the handle owns a background actor
    /// task that serializes all pool state transitions.
    pub fn new(config: DevicePoolConfig) -> Self {
        Self::from_pool(DevicePool::new(config))
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
        pending: JoinSet<Result<NbdDeviceClaim>>,
    ) -> Self {
        Self::spawn_actor(pool, pending)
    }

    #[cfg(not(test))]
    fn from_pool_with_pending(pool: DevicePool, pending: JoinSet<Result<NbdDeviceClaim>>) -> Self {
        Self::spawn_actor(pool, pending)
    }

    fn spawn_actor(mut pool: DevicePool, pending: JoinSet<Result<NbdDeviceClaim>>) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        pool.set_lease_return(commands.downgrade());
        tokio::spawn(
            DevicePoolActor {
                pool,
                commands: command_rx,
                pending,
            }
            .run(),
        );
        Self { commands }
    }

    /// Clean up the underlying pool.
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

    pub(crate) async fn acquire(&self) -> Result<DeviceLease> {
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
    pub(super) async fn snapshot(&self) -> DevicePoolSnapshot {
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
                    self.pool.handle_scan_join(scan);
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
        self.pool.ensure_waiting_progress(self.pending.len());
        self.spawn_waiting_scans();
    }

    fn spawn_waiting_scans(&mut self) {
        let scans_to_spawn = self.pool.scans_to_spawn(self.pending.len());
        for _ in 0..scans_to_spawn {
            self.spawn_scan();
        }
    }

    fn spawn_scan(&mut self) {
        let request = self.pool.scan_request();
        self.pending.spawn_blocking(move || request.run());
    }

    async fn abort_pending(&mut self) {
        self.pending.abort_all();
        while self.pending.join_next().await.is_some() {}
    }
}

fn actor_stopped_error() -> NbdCowError {
    NbdCowError::Io(std::io::Error::other("device pool actor stopped"))
}
