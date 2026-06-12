use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::device_lock::{self, NbdDeviceClaim};
use crate::error::{NbdCowError, Result};
use crate::netlink;
use tokio::sync::{mpsc, oneshot};

use super::actor::DevicePoolCommand;
use super::lease::DeviceLease;
use super::scan::ScanRequest;
use super::{DEFAULT_COOLDOWN_MS, DeviceFreeCheck, MAX_PENDING};

/// A device claim with a timestamp marking when it was released.
pub(super) struct CooldownSlot {
    claim: NbdDeviceClaim,
    pub(super) released_at: Instant,
}

impl CooldownSlot {
    pub(super) fn index(&self) -> u32 {
        self.claim.index()
    }

    fn deadline(&self, cooldown: Duration) -> Instant {
        self.released_at + cooldown
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

#[cfg(test)]
#[derive(Debug)]
pub(super) struct DevicePoolSnapshot {
    pub(super) cooldown: Vec<u32>,
    pub(super) in_flight: HashSet<u32>,
    pub(super) waiting_acquires: usize,
}

/// Demand-only NBD device claim pool.
///
/// Production callers should share it through [`crate::pool::DevicePoolHandle`] so pool
/// release authority stays tied to owned device leases.
pub struct DevicePool {
    pub(super) active: bool,
    /// Recently released device claims waiting for cooldown to expire.
    pub(super) cooldown: VecDeque<CooldownSlot>,
    /// Weak sender used to embed a strong return path in assigned leases.
    pub(super) lease_return: Option<mpsc::WeakUnboundedSender<DevicePoolCommand>>,
    /// Acquire errors that raced with still-pending scans.
    pub(super) deferred_acquire_errors: VecDeque<NbdCowError>,
    /// Acquire requests waiting for a scan or an expired cooldown claim.
    pub(super) waiting_acquires: VecDeque<oneshot::Sender<Result<DeviceLease>>>,
    /// Total number of NBD devices (from sysfs nbds_max).
    pub(super) max_devices: u32,
    /// Pool configuration.
    pub(super) config: DevicePoolConfig,
    /// Indices returned by `acquire()` but not yet released or discarded.
    pub(super) in_flight: HashSet<u32>,
    /// Directory containing per-index lock files.
    pub(super) lock_dir: PathBuf,
    /// Device free predicate, injected in unit tests.
    pub(super) device_appears_free: DeviceFreeCheck,
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

    pub(super) fn new_with_options(
        config: DevicePoolConfig,
        max_devices: u32,
        lock_dir: PathBuf,
        device_appears_free: DeviceFreeCheck,
    ) -> Self {
        Self {
            active: true,
            cooldown: VecDeque::new(),
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

    pub(super) fn set_lease_return(
        &mut self,
        return_to: mpsc::WeakUnboundedSender<DevicePoolCommand>,
    ) {
        self.lease_return = Some(return_to);
    }

    pub(super) fn lease_for(&self, claim: NbdDeviceClaim) -> DeviceLease {
        match self
            .lease_return
            .as_ref()
            .and_then(|return_to| return_to.upgrade())
        {
            Some(return_to) => DeviceLease::with_return(claim, return_to),
            None => DeviceLease::new(claim),
        }
    }

    pub(super) fn handle_acquire(
        &mut self,
        respond_to: oneshot::Sender<Result<DeviceLease>>,
        pending_scans: usize,
    ) {
        if !self.active {
            let _ = respond_to.send(Err(NbdCowError::NoFreeDevice));
            return;
        }

        self.waiting_acquires.push_back(respond_to);
        self.ensure_waiting_progress(pending_scans);
    }

    pub(super) fn ensure_waiting_progress(&mut self, pending_scans: usize) {
        if !self.active {
            self.fail_all_waiters();
            return;
        }

        self.process_expired_cooldown();

        if self.waiting_acquires.is_empty() {
            self.deferred_acquire_errors.clear();
            return;
        }

        if pending_scans == 0
            && !self.deferred_acquire_errors.is_empty()
            && self.cooldown.is_empty()
        {
            self.fail_deferred_acquire_errors();
        }

        if self.waiting_acquires.is_empty() {
            self.deferred_acquire_errors.clear();
        }
    }

    pub(super) fn scans_to_spawn(&self, pending_scans: usize) -> usize {
        if !self.active || !self.deferred_acquire_errors.is_empty() {
            return 0;
        }
        let remaining_capacity = MAX_PENDING.saturating_sub(pending_scans);
        let waiting_without_scan = self.waiting_acquires.len().saturating_sub(pending_scans);
        remaining_capacity.min(waiting_without_scan)
    }

    pub(super) fn scan_request(&self) -> ScanRequest {
        ScanRequest {
            max_devices: self.max_devices,
            exclude: self.tracked_indices(),
            lock_dir: self.lock_dir.clone(),
            device_appears_free: self.device_appears_free,
        }
    }

    pub(super) fn handle_scan_join(
        &mut self,
        scan: Option<std::result::Result<Result<NbdDeviceClaim>, tokio::task::JoinError>>,
    ) {
        match scan {
            Some(Ok(Ok(claim))) => {
                if self.is_tracked(claim.index()) {
                    tracing::warn!(
                        device_index = claim.index(),
                        "dropping scan result because index is already tracked"
                    );
                } else {
                    self.assign_claim_to_waiter(claim);
                }
            }
            Some(Ok(Err(e))) => {
                self.defer_acquire_error(e);
            }
            Some(Err(e)) if !self.waiting_acquires.is_empty() => {
                self.defer_acquire_error(NbdCowError::Io(std::io::Error::other(format!(
                    "device scan task failed: {e}"
                ))));
            }
            Some(Err(_)) | None => {}
        }
    }

    pub(super) fn assign_claim_to_waiter(&mut self, mut claim: NbdDeviceClaim) -> bool {
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
    pub(super) fn release(&mut self, lease: DeviceLease) {
        if let Some(claim) = lease.into_claim() {
            self.release_claim(claim);
        }
    }

    pub(super) fn release_claim(&mut self, claim: NbdDeviceClaim) {
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
    pub(super) fn discard_claim(&mut self, claim: NbdDeviceClaim) {
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
    pub(super) fn retire_uncertain(&mut self, lease: DeviceLease) {
        if let Some(claim) = lease.into_claim() {
            self.retire_uncertain_claim(claim);
        }
    }

    pub(super) fn retire_uncertain_claim(&mut self, claim: NbdDeviceClaim) {
        self.release_claim(claim);
    }

    /// Clean up the pool: reject waiters and clear queues.
    pub async fn cleanup(&mut self) {
        self.begin_cleanup();
        self.finish_cleanup();
    }

    pub(super) fn begin_cleanup(&mut self) {
        self.active = false;
        if !self.in_flight.is_empty() {
            tracing::warn!(
                in_flight = self.in_flight.len(),
                "device pool cleanup with outstanding leases"
            );
        }
        self.fail_all_waiters();
        self.deferred_acquire_errors.clear();
    }

    pub(super) fn finish_cleanup(&mut self) {
        self.cooldown.clear();
        self.in_flight.clear();
        tracing::info!("device pool cleanup complete");
    }

    pub(super) fn deactivate(&mut self) {
        self.active = false;
    }

    pub(super) fn process_expired_cooldown(&mut self) {
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
            tracing::info!(
                device_index = index,
                "dropping expired NBD cooldown claim because device is not free"
            );
            return;
        }
        self.assign_claim_to_waiter(slot.claim);
    }

    pub(super) fn next_cooldown_deadline(&self) -> Option<Instant> {
        self.cooldown
            .front()
            .map(|slot| slot.deadline(self.config.cooldown))
    }

    /// Collect all indices currently tracked by the pool (cooldown + in-flight)
    /// to exclude from demand scans. Concurrent scans are still safe because the
    /// host-global per-index lock serializes claims across tasks and processes.
    pub(super) fn tracked_indices(&self) -> HashSet<u32> {
        self.cooldown
            .iter()
            .map(CooldownSlot::index)
            .chain(self.in_flight.iter().copied())
            .collect()
    }

    pub(super) fn is_tracked(&self, index: u32) -> bool {
        self.in_flight.contains(&index) || self.cooldown.iter().any(|slot| slot.index() == index)
    }

    #[cfg(test)]
    pub(super) fn snapshot(&self) -> DevicePoolSnapshot {
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
