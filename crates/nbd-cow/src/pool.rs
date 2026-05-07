//! Device pool for host-global NBD device claims.
//!
//! Allocation is demand-only: each acquire scans for a free `/dev/nbdN`,
//! acquires the per-index host `flock`, and re-checks sysfs before returning a
//! lease. Released devices keep their lock through a short cooldown period so
//! kernel teardown cannot race a different runner process.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::device_lock::{self, NbdDeviceClaim};
use crate::error::{NbdCowError, Result};
use crate::netlink;
use tokio::sync::{mpsc, oneshot};

/// Maximum blocking NBD scans running concurrently.
const MAX_PENDING: usize = 4;

/// Default cooldown period (milliseconds) after disconnecting a device.
const DEFAULT_COOLDOWN_MS: u64 = 500;

type DeviceFreeCheck = fn(u32) -> bool;

/// A device claim with a timestamp marking when it was released.
struct CooldownSlot {
    claim: NbdDeviceClaim,
    released_at: Instant,
}

impl CooldownSlot {
    fn index(&self) -> u32 {
        self.claim.index()
    }

    fn deadline(&self, cooldown: Duration) -> Instant {
        self.released_at + cooldown
    }
}

/// Owned authority for a checked-out NBD device.
///
/// This is intentionally move-only: releasing, discarding, or retiring the
/// device must consume the lease, which owns the underlying `NbdDeviceClaim`.
/// The copied device index is only diagnostic metadata, not pool authority.
pub struct DeviceLease {
    index: u32,
    claim: Option<NbdDeviceClaim>,
    return_to: Option<mpsc::UnboundedSender<DevicePoolCommand>>,
}

impl DeviceLease {
    fn new(claim: NbdDeviceClaim) -> Self {
        let index = claim.index();
        Self {
            index,
            claim: Some(claim),
            return_to: None,
        }
    }

    fn with_return(
        claim: NbdDeviceClaim,
        return_to: mpsc::UnboundedSender<DevicePoolCommand>,
    ) -> Self {
        let index = claim.index();
        Self {
            index,
            claim: Some(claim),
            return_to: Some(return_to),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(index: u32, lock_dir: &Path) -> Self {
        Self::new(NbdDeviceClaim::new_for_test(index, lock_dir))
    }

    /// NBD device index (N in `/dev/nbdN`).
    pub fn index(&self) -> u32 {
        self.index
    }

    fn into_claim(mut self) -> Option<NbdDeviceClaim> {
        self.return_to.take();
        self.claim.take()
    }
}

impl Drop for DeviceLease {
    fn drop(&mut self) {
        let Some(return_to) = self.return_to.take() else {
            return;
        };
        let Some(claim) = self.claim.take() else {
            return;
        };
        let index = claim.index();
        let (done, _done_rx) = oneshot::channel();
        if return_to
            .send(DevicePoolCommand::ReturnLease {
                action: LeaseReturnAction::RetireUncertain,
                claim,
                done,
            })
            .is_err()
        {
            tracing::warn!(
                device_index = index,
                "device pool actor stopped before dropped lease could be retired"
            );
        }
    }
}

/// Configuration for the device pool.
pub struct DevicePoolConfig {
    /// Cooldown period before a released device can be reused.
    pub cooldown: Duration,
}

impl Default for DevicePoolConfig {
    fn default() -> Self {
        Self {
            cooldown: Duration::from_millis(DEFAULT_COOLDOWN_MS),
        }
    }
}

/// Cloneable handle to the shared NBD device pool.
#[derive(Clone)]
pub struct DevicePoolHandle {
    commands: mpsc::UnboundedSender<DevicePoolCommand>,
}

#[derive(Clone, Copy)]
enum LeaseReturnAction {
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

enum DevicePoolCommand {
    Warmup {
        done: oneshot::Sender<()>,
    },
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
}

#[cfg(test)]
#[derive(Debug)]
struct DevicePoolSnapshot {
    cooldown: Vec<u32>,
    in_flight: HashSet<u32>,
    waiting_acquires: usize,
}

impl DevicePoolHandle {
    /// Create a new shared device pool handle.
    ///
    /// Must be called from a Tokio runtime: the handle owns a background actor
    /// task that serializes all pool state transitions.
    pub fn new(config: DevicePoolConfig) -> Self {
        Self::from_pool(DevicePool::new(config))
    }

    fn from_pool(mut pool: DevicePool) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        pool.set_lease_return(commands.downgrade());
        tokio::spawn(
            DevicePoolActor {
                pool,
                commands: command_rx,
            }
            .run(),
        );
        Self { commands }
    }

    /// Compatibility hook for older callers. Allocation is demand-only.
    pub async fn warmup(&self) {
        let (done, done_rx) = oneshot::channel();
        if self
            .commands
            .send(DevicePoolCommand::Warmup { done })
            .is_ok()
        {
            let _ = done_rx.await;
        }
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
    async fn snapshot(&self) -> DevicePoolSnapshot {
        let (respond_to, response) = oneshot::channel();
        self.commands
            .send(DevicePoolCommand::Snapshot { respond_to })
            .expect("device pool actor stopped before snapshot");
        response.await.expect("device pool actor dropped snapshot")
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
            self.pool.process_expired_cooldown();
            let deadline = self.pool.next_cooldown_deadline();
            let has_pending = !self.pool.pending.is_empty();

            tokio::select! {
                command = self.commands.recv() => {
                    let Some(command) = command else {
                        break;
                    };
                    self.handle_command(command).await;
                }
                scan = self.pool.pending.join_next(), if has_pending => {
                    self.pool.handle_scan_join(scan);
                }
                () = sleep_until_deadline(deadline), if deadline.is_some() => {
                    self.handle_cooldown_deadline();
                }
            }
        }

        self.pool.active = false;
        self.pool.abort_pending().await;
    }

    async fn handle_command(&mut self, command: DevicePoolCommand) {
        match command {
            DevicePoolCommand::Warmup { done } => {
                self.pool.warmup();
                let _ = done.send(());
            }
            DevicePoolCommand::Acquire { respond_to } => {
                self.pool.handle_acquire(respond_to);
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
                self.pool.ensure_waiting_progress();
                let _ = done.send(());
            }
            DevicePoolCommand::Cleanup { done } => {
                self.pool.cleanup().await;
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
        self.pool.ensure_waiting_progress();
    }
}

/// Demand-only NBD device claim pool.
///
/// Production callers should share it through [`DevicePoolHandle`] so pool
/// release authority stays tied to owned device leases.
pub struct DevicePool {
    active: bool,
    /// Recently released device claims waiting for cooldown to expire.
    cooldown: VecDeque<CooldownSlot>,
    /// Blocking demand scans.
    pending: tokio::task::JoinSet<Result<NbdDeviceClaim>>,
    /// Weak sender used to embed a strong return path in assigned leases.
    lease_return: Option<mpsc::WeakUnboundedSender<DevicePoolCommand>>,
    /// Acquire errors that raced with still-pending scans.
    deferred_acquire_errors: VecDeque<NbdCowError>,
    /// Acquire requests waiting for a scan or an expired cooldown claim.
    waiting_acquires: VecDeque<oneshot::Sender<Result<DeviceLease>>>,
    /// Total number of NBD devices (from sysfs nbds_max).
    max_devices: u32,
    /// Pool configuration.
    config: DevicePoolConfig,
    /// Indices returned by `acquire()` but not yet released or discarded.
    in_flight: HashSet<u32>,
    /// Directory containing per-index lock files.
    lock_dir: PathBuf,
    /// Device free predicate, injected in unit tests.
    device_appears_free: DeviceFreeCheck,
}

impl DevicePool {
    /// Create a new device pool.
    ///
    /// Reads `nbds_max` from sysfs to determine the device range.
    pub fn new(config: DevicePoolConfig) -> Self {
        let max_devices = netlink::nbds_max();
        Self::new_with_options(
            config,
            max_devices,
            device_lock::default_lock_dir(),
            netlink::device_appears_free,
        )
    }

    fn new_with_options(
        config: DevicePoolConfig,
        max_devices: u32,
        lock_dir: PathBuf,
        device_appears_free: DeviceFreeCheck,
    ) -> Self {
        Self {
            active: true,
            cooldown: VecDeque::new(),
            pending: tokio::task::JoinSet::new(),
            lease_return: None,
            deferred_acquire_errors: VecDeque::new(),
            waiting_acquires: VecDeque::new(),
            max_devices,
            config,
            in_flight: HashSet::new(),
            lock_dir,
            device_appears_free,
        }
    }

    fn set_lease_return(&mut self, return_to: mpsc::WeakUnboundedSender<DevicePoolCommand>) {
        self.lease_return = Some(return_to);
    }

    fn lease_for(&self, claim: NbdDeviceClaim) -> DeviceLease {
        match self
            .lease_return
            .as_ref()
            .and_then(|return_to| return_to.upgrade())
        {
            Some(return_to) => DeviceLease::with_return(claim, return_to),
            None => DeviceLease::new(claim),
        }
    }

    /// Compatibility no-op. Allocation happens on demand.
    fn warmup(&mut self) {
        if self.active {
            tracing::debug!(max_devices = self.max_devices, "device pool warmup skipped");
        }
    }

    fn handle_acquire(&mut self, respond_to: oneshot::Sender<Result<DeviceLease>>) {
        if !self.active {
            let _ = respond_to.send(Err(NbdCowError::NoFreeDevice));
            return;
        }

        self.waiting_acquires.push_back(respond_to);
        self.ensure_waiting_progress();
    }

    fn ensure_waiting_progress(&mut self) {
        if !self.active {
            self.fail_all_waiters();
            return;
        }

        self.process_expired_cooldown();

        if self.waiting_acquires.is_empty() {
            self.deferred_acquire_errors.clear();
            return;
        }

        if self.pending.is_empty()
            && !self.deferred_acquire_errors.is_empty()
            && self.cooldown.is_empty()
        {
            self.fail_deferred_acquire_errors();
        }

        if self.waiting_acquires.is_empty() {
            self.deferred_acquire_errors.clear();
            return;
        }

        if self.deferred_acquire_errors.is_empty() {
            self.spawn_demand_batch();
        }
    }

    fn spawn_demand_batch(&mut self) {
        while self.active
            && self.pending.len() < MAX_PENDING
            && self.pending.len() < self.waiting_acquires.len()
        {
            self.spawn_scan();
        }
    }

    fn spawn_scan(&mut self) {
        let max = self.max_devices;
        let exclude = self.tracked_indices();
        let lock_dir = self.lock_dir.clone();
        let device_appears_free = self.device_appears_free;
        self.pending.spawn_blocking(move || {
            scan_and_claim_with(max, &exclude, &lock_dir, device_appears_free)
        });
    }

    fn handle_scan_join(
        &mut self,
        scan: Option<std::result::Result<Result<NbdDeviceClaim>, tokio::task::JoinError>>,
    ) {
        match scan {
            Some(Ok(Ok(claim))) => {
                if self.is_tracked(claim.index()) {
                    tracing::debug!(
                        device_index = claim.index(),
                        "dropping scan result because index is already tracked"
                    );
                } else {
                    self.assign_claim_to_waiter(claim);
                }
                self.ensure_waiting_progress();
            }
            Some(Ok(Err(e))) => {
                self.defer_acquire_error(e);
                self.ensure_waiting_progress();
            }
            Some(Err(e)) => {
                if !self.waiting_acquires.is_empty() {
                    self.defer_acquire_error(NbdCowError::Io(std::io::Error::other(format!(
                        "device scan task failed: {e}"
                    ))));
                }
                self.ensure_waiting_progress();
            }
            None => {}
        }
    }

    fn assign_claim_to_waiter(&mut self, mut claim: NbdDeviceClaim) -> bool {
        let index = claim.index();
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            match respond_to.send(Ok(self.lease_for(claim))) {
                Ok(()) => {
                    self.in_flight.insert(index);
                    return true;
                }
                Err(Ok(lease)) => {
                    let Some(returned_claim) = lease.into_claim() else {
                        return false;
                    };
                    claim = returned_claim;
                }
                Err(Err(_)) => {
                    return false;
                }
            }
        }
        false
    }

    fn fail_one_waiter(&mut self, mut error: NbdCowError) -> bool {
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            match respond_to.send(Err(error)) {
                Ok(()) => return true,
                Err(Err(e)) => error = e,
                Err(Ok(_lease)) => return false,
            }
        }
        false
    }

    fn defer_acquire_error(&mut self, error: NbdCowError) {
        if self.waiting_acquires.is_empty() {
            return;
        }
        self.deferred_acquire_errors.push_back(error);
    }

    fn fail_deferred_acquire_errors(&mut self) {
        while !self.waiting_acquires.is_empty() {
            let Some(error) = self.deferred_acquire_errors.pop_front() else {
                break;
            };
            self.fail_one_waiter(error);
        }
        if self.waiting_acquires.is_empty() {
            self.deferred_acquire_errors.clear();
        }
    }

    fn fail_all_waiters(&mut self) {
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            let _ = respond_to.send(Err(NbdCowError::NoFreeDevice));
        }
    }

    /// Release a device claim back to the pool after disconnect.
    ///
    /// The claim enters cooldown before the lock can be released, giving the
    /// kernel time to finish teardown.
    #[cfg(test)]
    fn release(&mut self, lease: DeviceLease) {
        if let Some(claim) = lease.into_claim() {
            self.release_claim(claim);
        }
    }

    fn release_claim(&mut self, claim: NbdDeviceClaim) {
        if !self.active {
            return;
        }
        let index = claim.index();
        if !self.in_flight.remove(&index) {
            tracing::warn!(
                device_index = index,
                "device release ignored because index is not in flight"
            );
            return;
        }
        self.cooldown.push_back(CooldownSlot {
            claim,
            released_at: Instant::now(),
        });
    }

    /// Stop tracking an in-flight claim without returning it to cooldown.
    ///
    /// Used when `connect_device` fails with EBUSY — the device belongs to
    /// another process or non-cooperating owner and should not remain locked by us.
    fn discard_claim(&mut self, claim: NbdDeviceClaim) {
        let index = claim.index();
        if !self.in_flight.remove(&index) {
            tracing::warn!(
                device_index = index,
                "device discard ignored because index is not in flight"
            );
        }
    }

    /// Retire a device whose post-owner state is uncertain.
    ///
    /// This is intentionally conservative: the claim stays locked through
    /// cooldown before it can be reused or released.
    #[cfg(test)]
    fn retire_uncertain(&mut self, lease: DeviceLease) {
        if let Some(claim) = lease.into_claim() {
            self.retire_uncertain_claim(claim);
        }
    }

    fn retire_uncertain_claim(&mut self, claim: NbdDeviceClaim) {
        self.release_claim(claim);
    }

    /// Clean up the pool: cancel pending scans and clear queues.
    pub async fn cleanup(&mut self) {
        self.active = false;
        if !self.in_flight.is_empty() {
            tracing::warn!(
                in_flight = self.in_flight.len(),
                "device pool cleanup with outstanding leases"
            );
        }
        self.fail_all_waiters();
        self.deferred_acquire_errors.clear();
        self.abort_pending().await;
        self.cooldown.clear();
        self.in_flight.clear();
        tracing::info!("device pool cleanup complete");
    }

    async fn abort_pending(&mut self) {
        self.pending.abort_all();
        while self.pending.join_next().await.is_some() {}
    }

    fn process_expired_cooldown(&mut self) {
        let now = Instant::now();
        while let Some(slot) = self.cooldown.front() {
            if slot.deadline(self.config.cooldown) > now {
                break;
            }
            let Some(slot) = self.cooldown.pop_front() else {
                break;
            };
            self.handle_expired_cooldown(slot);
        }
    }

    fn handle_expired_cooldown(&mut self, slot: CooldownSlot) {
        let index = slot.index();
        if self.waiting_acquires.is_empty() {
            return;
        }
        if !(self.device_appears_free)(index) {
            tracing::debug!(
                device_index = index,
                "dropping expired NBD cooldown claim because device is not free"
            );
            return;
        }
        self.assign_claim_to_waiter(slot.claim);
    }

    fn next_cooldown_deadline(&self) -> Option<Instant> {
        self.cooldown
            .front()
            .map(|slot| slot.deadline(self.config.cooldown))
    }

    /// Collect all indices currently tracked by the pool (cooldown + in-flight)
    /// to exclude from demand scans. Concurrent scans are still safe because the
    /// host-global per-index lock serializes claims across tasks and processes.
    fn tracked_indices(&self) -> Vec<u32> {
        self.cooldown
            .iter()
            .map(CooldownSlot::index)
            .chain(self.in_flight.iter().copied())
            .collect()
    }

    fn is_tracked(&self, index: u32) -> bool {
        self.in_flight.contains(&index) || self.cooldown.iter().any(|slot| slot.index() == index)
    }

    #[cfg(test)]
    fn snapshot(&self) -> DevicePoolSnapshot {
        DevicePoolSnapshot {
            cooldown: self.cooldown.iter().map(CooldownSlot::index).collect(),
            in_flight: self.in_flight.clone(),
            waiting_acquires: self.waiting_acquires.len(),
        }
    }
}

impl Drop for DevicePool {
    fn drop(&mut self) {
        if self.active {
            tracing::warn!("DevicePool dropped without cleanup — call cleanup() first");
        }
    }
}

/// Scan sysfs for a single free device and acquire its per-index lock.
///
/// Starts from a random offset to distribute usage across runners. The first
/// sysfs check is a cheap precheck; the post-lock sysfs check is the correctness
/// gate that prevents stale observations from becoming leases.
fn scan_and_claim_with<F>(
    max_devices: u32,
    exclude: &[u32],
    lock_dir: &Path,
    device_appears_free: F,
) -> Result<NbdDeviceClaim>
where
    F: Fn(u32) -> bool,
{
    if max_devices == 0 {
        return Err(NbdCowError::NoFreeDevice);
    }

    let start = netlink::random_offset(max_devices);

    for n in 0..max_devices {
        let i = (start + n) % max_devices;
        if exclude.contains(&i) {
            continue;
        }
        if !device_appears_free(i) {
            continue;
        }
        match device_lock::try_acquire_device_claim_in(i, lock_dir) {
            Ok(Some(claim)) => {
                if device_appears_free(i) {
                    return Ok(claim);
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::debug!(
                    device_index = i,
                    error = %e,
                    "cannot acquire NBD device lock, skipping index"
                );
            }
        }
    }

    Err(NbdCowError::NoFreeDevice)
}

fn actor_stopped_error() -> NbdCowError {
    NbdCowError::Io(std::io::Error::other("device pool actor stopped"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn always_free(_: u32) -> bool {
        true
    }

    fn never_free(_: u32) -> bool {
        false
    }

    fn test_pool(
        max_devices: u32,
        cooldown: Duration,
        lock_dir: &Path,
        device_appears_free: DeviceFreeCheck,
    ) -> DevicePool {
        DevicePool::new_with_options(
            DevicePoolConfig { cooldown },
            max_devices,
            lock_dir.to_path_buf(),
            device_appears_free,
        )
    }

    fn queue_scan_result(pool: &mut DevicePool, result: Result<NbdDeviceClaim>) {
        pool.pending.spawn(async move { result });
    }

    fn queue_controlled_scan(pool: &mut DevicePool) -> oneshot::Sender<Result<NbdDeviceClaim>> {
        let (complete, complete_rx) = oneshot::channel();
        pool.pending
            .spawn(async move { complete_rx.await.unwrap_or(Err(NbdCowError::NoFreeDevice)) });
        complete
    }

    async fn wait_for_scan_waiter(handle: &DevicePoolHandle) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if handle.snapshot().await.waiting_acquires > 0 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("acquire did not wait for scan");
    }

    fn claim(index: u32, lock_dir: &Path) -> NbdDeviceClaim {
        NbdDeviceClaim::new_for_test(index, lock_dir)
    }

    fn lease(index: u32, lock_dir: &Path) -> DeviceLease {
        DeviceLease::new_for_test(index, lock_dir)
    }

    fn test_pool_with_in_flight(index: u32, lock_dir: &Path) -> DevicePool {
        let mut pool = test_pool(
            8,
            DevicePoolConfig::default().cooldown,
            lock_dir,
            always_free,
        );
        pool.in_flight.insert(index);
        pool
    }

    fn test_pool_for_pending_scan(lock_dir: &Path) -> DevicePool {
        test_pool(
            0,
            DevicePoolConfig::default().cooldown,
            lock_dir,
            always_free,
        )
    }

    #[test]
    fn scan_and_claim_skips_held_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _held = claim(0, dir.path());

        let result = scan_and_claim_with(1, &[], dir.path(), always_free);

        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[test]
    fn scan_and_claim_skips_unopenable_lock_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("vm0-nbd-0.lock")).expect("create lock path dir");

        let result = scan_and_claim_with(1, &[], dir.path(), always_free);

        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[test]
    fn scan_and_claim_releases_lock_when_post_lock_recheck_fails() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn free_once(_: u32) -> bool {
            CALLS.fetch_add(1, Ordering::SeqCst) == 0
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let result = scan_and_claim_with(1, &[], dir.path(), free_once);

        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
        assert!(claim(0, dir.path()).index() == 0);
        CALLS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn release_consumes_lease_and_enters_cooldown_with_lock_held() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_with_in_flight(3, dir.path());

        pool.release(lease(3, dir.path()));

        assert_eq!(pool.cooldown.len(), 1);
        assert_eq!(pool.cooldown.front().map(CooldownSlot::index), Some(3));
        assert!(pool.in_flight.is_empty());
        assert!(
            device_lock::try_acquire_device_claim_in(3, dir.path())
                .expect("lock probe")
                .is_none()
        );
    }

    #[test]
    fn retire_uncertain_enters_cooldown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_with_in_flight(3, dir.path());

        pool.retire_uncertain(lease(3, dir.path()));

        assert_eq!(pool.cooldown.len(), 1);
        assert_eq!(pool.cooldown.front().map(CooldownSlot::index), Some(3));
        assert!(pool.in_flight.is_empty());
    }

    #[tokio::test]
    async fn cleanup_with_outstanding_lease_does_not_panic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_with_in_flight(3, dir.path());

        pool.cleanup().await;

        assert!(!pool.active);
        assert!(pool.in_flight.is_empty());
    }

    #[tokio::test]
    async fn cleanup_with_outstanding_handle_lease_releases_lock_after_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool(1, Duration::from_secs(60), dir.path(), always_free);
        queue_scan_result(&mut pool, Ok(claim(0, dir.path())));
        let handle = DevicePoolHandle::from_pool(pool);

        let lease = handle.acquire().await.expect("acquire lease");
        handle.cleanup().await;
        assert!(
            device_lock::try_acquire_device_claim_in(0, dir.path())
                .expect("lock probe")
                .is_none()
        );

        drop(lease);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if device_lock::try_acquire_device_claim_in(0, dir.path())
                    .expect("lock probe")
                    .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped lease did not release lock after cleanup");
    }

    #[tokio::test]
    async fn cleanup_rejects_acquire() {
        let dir = tempfile::tempdir().expect("tempdir");
        let handle = DevicePoolHandle::from_pool(test_pool_for_pending_scan(dir.path()));

        handle.cleanup().await;

        let result = handle.acquire().await;
        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[tokio::test]
    async fn cleanup_drops_completed_pending_scan_claim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        queue_scan_result(&mut pool, Ok(claim(4, dir.path())));

        pool.cleanup().await;

        assert!(
            device_lock::try_acquire_device_claim_in(4, dir.path())
                .expect("lock probe")
                .is_some()
        );
    }

    #[tokio::test]
    async fn dropping_last_handle_closes_actor_command_channel_after_lease_drops() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool(1, Duration::from_secs(60), dir.path(), always_free);
        queue_scan_result(&mut pool, Ok(claim(0, dir.path())));
        let handle = DevicePoolHandle::from_pool(pool);
        let weak_commands = handle.commands.downgrade();

        let lease = handle.acquire().await.expect("acquire lease");
        drop(handle);
        assert!(weak_commands.upgrade().is_some());

        drop(lease);
        assert!(weak_commands.upgrade().is_none());
    }

    #[tokio::test]
    async fn warmup_after_cleanup_does_not_restart_pool() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());

        pool.cleanup().await;
        pool.warmup();

        assert!(!pool.active);
        assert!(pool.pending.is_empty());
        assert!(pool.cooldown.is_empty());
    }

    #[tokio::test]
    async fn acquire_rejects_duplicate_pending_scan_result() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        pool.in_flight.insert(3);
        queue_scan_result(&mut pool, Ok(claim(3, dir.path())));
        let handle = DevicePoolHandle::from_pool(pool);

        let result = handle.acquire().await;

        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
        let snapshot = handle.snapshot().await;
        assert!(snapshot.in_flight.contains(&3));
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn waiting_acquires_spawn_demand_scans_up_to_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let mut responses = Vec::new();

        for _ in 0..(MAX_PENDING + 2) {
            let (respond_to, response) = oneshot::channel();
            pool.handle_acquire(respond_to);
            responses.push(response);
        }

        assert_eq!(pool.waiting_acquires.len(), MAX_PENDING + 2);
        assert_eq!(pool.pending.len(), MAX_PENDING);
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn single_waiting_acquire_spawns_single_demand_scan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let (respond_to, _response) = oneshot::channel();

        pool.handle_acquire(respond_to);

        assert_eq!(pool.waiting_acquires.len(), 1);
        assert_eq!(pool.pending.len(), 1);
        pool.cleanup().await;
    }

    #[tokio::test]
    async fn detached_retire_returns_in_flight_lease_to_cooldown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let handle = DevicePoolHandle::from_pool(test_pool_with_in_flight(3, dir.path()));

        handle.retire_uncertain_detached(lease(3, dir.path()));

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if handle.snapshot().await.cooldown == vec![3] {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("detached retire did not reach actor");
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn discard_releases_in_flight_lease_without_cooldown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        pool.in_flight.insert(3);
        let complete_scan = queue_controlled_scan(&mut pool);
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_scan_waiter(&handle).await;

        handle.discard(lease(3, dir.path())).await;

        let snapshot = handle.snapshot().await;
        assert!(!snapshot.in_flight.contains(&3));
        assert!(snapshot.cooldown.is_empty());
        assert!(
            device_lock::try_acquire_device_claim_in(3, dir.path())
                .expect("lock probe")
                .is_some()
        );

        complete_scan.send(Ok(claim(4, dir.path()))).unwrap();
        let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("acquire did not finish after discard")
            .expect("acquire task panicked")
            .expect("acquire failed");
        assert_eq!(lease.index(), 4);
        handle.discard(lease).await;
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn dropped_assigned_lease_retires_to_cooldown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool(1, Duration::from_secs(60), dir.path(), always_free);
        queue_scan_result(&mut pool, Ok(claim(0, dir.path())));
        let handle = DevicePoolHandle::from_pool(pool);

        let lease = handle.acquire().await.expect("acquire lease");
        assert_eq!(lease.index(), 0);
        drop(lease);

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let snapshot = handle.snapshot().await;
                if snapshot.cooldown == vec![0] && !snapshot.in_flight.contains(&0) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped lease did not return to cooldown");
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn separate_pools_do_not_claim_same_locked_index() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = DevicePoolHandle::from_pool(test_pool(
            1,
            DevicePoolConfig::default().cooldown,
            dir.path(),
            always_free,
        ));
        let second = DevicePoolHandle::from_pool(test_pool(
            1,
            DevicePoolConfig::default().cooldown,
            dir.path(),
            always_free,
        ));

        let first_lease = first.acquire().await.expect("first acquire");
        assert_eq!(first_lease.index(), 0);

        let second_result = second.acquire().await;
        assert!(matches!(second_result, Err(NbdCowError::NoFreeDevice)));

        first.discard(first_lease).await;
        first.cleanup().await;
        second.cleanup().await;
    }

    #[tokio::test]
    async fn demand_error_waits_for_pending_success_before_failing_waiter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let complete_scan = queue_controlled_scan(&mut pool);
        let (first_tx, mut first_rx) = oneshot::channel();
        let (second_tx, second_rx) = oneshot::channel();
        pool.waiting_acquires.push_back(first_tx);
        pool.waiting_acquires.push_back(second_tx);

        pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));

        assert!(matches!(
            first_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        complete_scan.send(Ok(claim(4, dir.path()))).unwrap();
        let scan = pool.pending.join_next().await.unwrap();
        pool.handle_scan_join(Some(scan));

        let first_lease = first_rx.await.unwrap().unwrap();
        assert_eq!(first_lease.index(), 4);
        assert!(matches!(
            second_rx.await.unwrap(),
            Err(NbdCowError::NoFreeDevice)
        ));
    }

    #[tokio::test]
    async fn deferred_error_starts_new_demand_scan_for_remaining_waiter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let (first_tx, first_rx) = oneshot::channel();
        let (second_tx, mut second_rx) = oneshot::channel();
        pool.waiting_acquires.push_back(first_tx);
        pool.waiting_acquires.push_back(second_tx);

        pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));

        assert!(matches!(
            first_rx.await.unwrap(),
            Err(NbdCowError::NoFreeDevice)
        ));
        assert!(matches!(
            second_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(pool.waiting_acquires.len(), 1);
        assert_eq!(pool.pending.len(), 1);
        pool.cleanup().await;
    }

    #[test]
    fn scan_success_skips_cancelled_waiter_without_leaking_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let (active_tx, mut active_rx) = oneshot::channel();
        drop(cancelled_rx);
        pool.waiting_acquires.push_back(cancelled_tx);
        pool.waiting_acquires.push_back(active_tx);

        pool.handle_scan_join(Some(Ok(Ok(claim(4, dir.path())))));

        let lease = active_rx.try_recv().unwrap().unwrap();
        assert_eq!(lease.index(), 4);
        assert!(pool.waiting_acquires.is_empty());
        assert!(pool.in_flight.contains(&4));
    }

    #[test]
    fn cancelled_waiter_after_scan_completion_drops_claim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        drop(cancelled_rx);
        pool.waiting_acquires.push_back(cancelled_tx);

        pool.handle_scan_join(Some(Ok(Ok(claim(4, dir.path())))));

        assert!(pool.waiting_acquires.is_empty());
        assert!(pool.in_flight.is_empty());
        assert!(
            device_lock::try_acquire_device_claim_in(4, dir.path())
                .expect("lock probe")
                .is_some()
        );
    }

    #[tokio::test]
    async fn deferred_error_skips_cancelled_waiter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let (active_tx, active_rx) = oneshot::channel();
        drop(cancelled_rx);
        pool.waiting_acquires.push_back(cancelled_tx);
        pool.waiting_acquires.push_back(active_tx);

        pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));

        assert!(matches!(
            active_rx.await.unwrap(),
            Err(NbdCowError::NoFreeDevice)
        ));
        assert!(pool.waiting_acquires.is_empty());
        assert!(pool.deferred_acquire_errors.is_empty());
    }

    #[tokio::test]
    async fn handle_acquire_waiting_for_scan_does_not_block_release() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        pool.in_flight.insert(3);
        let complete_scan = queue_controlled_scan(&mut pool);
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_scan_waiter(&handle).await;
        tokio::time::timeout(
            Duration::from_secs(1),
            handle.release_clean(lease(3, dir.path())),
        )
        .await
        .expect("release blocked behind pending acquire");
        assert_eq!(handle.snapshot().await.cooldown, vec![3]);

        complete_scan.send(Ok(claim(4, dir.path()))).unwrap();
        let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("acquire did not finish after scan")
            .expect("acquire task panicked")
            .expect("acquire failed");
        assert_eq!(lease.index(), 4);
        handle.discard(lease).await;
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn cleanup_wakes_handle_acquire_waiting_for_scan() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool_for_pending_scan(dir.path());
        let _complete_scan = queue_controlled_scan(&mut pool);
        let handle = DevicePoolHandle::from_pool(pool);
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        wait_for_scan_waiter(&handle).await;
        tokio::time::timeout(Duration::from_secs(1), handle.cleanup())
            .await
            .expect("cleanup blocked behind pending acquire");

        let result = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("acquire did not finish after cleanup")
            .expect("acquire task panicked");
        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    }

    #[tokio::test]
    async fn cooldown_timer_releases_expired_claim_without_waiter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let handle = DevicePoolHandle::from_pool(test_pool_with_in_flight(3, dir.path()));

        handle.release_clean(lease(3, dir.path())).await;
        assert!(
            device_lock::try_acquire_device_claim_in(3, dir.path())
                .expect("lock probe")
                .is_none()
        );

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let snapshot = handle.snapshot().await;
                if snapshot.cooldown.is_empty()
                    && device_lock::try_acquire_device_claim_in(3, dir.path())
                        .expect("lock probe")
                        .is_some()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cooldown timer did not release claim");
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn expired_cooldown_with_waiter_hands_off_same_claim() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool(0, Duration::from_millis(20), dir.path(), always_free);
        pool.in_flight.insert(3);
        let handle = DevicePoolHandle::from_pool(pool);

        handle.release_clean(lease(3, dir.path())).await;
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("cooldown handoff timed out")
            .expect("acquire task panicked")
            .expect("acquire failed");
        assert_eq!(lease.index(), 3);
        handle.discard(lease).await;
        handle.cleanup().await;
    }

    #[tokio::test]
    async fn expired_cooldown_with_failed_recheck_drops_claim_and_scans() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut pool = test_pool(0, Duration::from_millis(1), dir.path(), never_free);
        pool.in_flight.insert(3);
        let handle = DevicePoolHandle::from_pool(pool);

        handle.release_clean(lease(3, dir.path())).await;
        let acquire_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.acquire().await }
        });

        let result = tokio::time::timeout(Duration::from_secs(1), acquire_task)
            .await
            .expect("acquire timed out")
            .expect("acquire task panicked");
        assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
        assert!(
            device_lock::try_acquire_device_claim_in(3, dir.path())
                .expect("lock probe")
                .is_some()
        );
        handle.cleanup().await;
    }
}
