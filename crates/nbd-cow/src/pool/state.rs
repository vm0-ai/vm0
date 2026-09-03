use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::device_lock::{self, NbdDeviceClaim};
use crate::error::{NbdCowError, Result};
use crate::netlink;
use tokio::sync::{mpsc, oneshot};

use super::actor::DevicePoolCommand;
use super::lease::{DeviceAcquireSource, DeviceAcquisition, DeviceLease};
use super::scan::{ScanRequest, ScannedDeviceClaim};
use super::{DEFAULT_COOLDOWN_MS, DeviceFreeCheck, MAX_PENDING};

#[derive(Clone, Copy)]
enum CooldownExpiration {
    At(Instant),
    Never,
}

impl CooldownExpiration {
    fn from_release(released_at: Instant, cooldown: Duration) -> Self {
        match released_at.checked_add(cooldown) {
            Some(deadline) => Self::At(deadline),
            None => Self::Never,
        }
    }

    fn deadline(self) -> Option<Instant> {
        match self {
            Self::At(deadline) => Some(deadline),
            Self::Never => None,
        }
    }
}

/// A device claim waiting for its cooldown expiration.
pub(super) struct CooldownSlot {
    claim: NbdDeviceClaim,
    expiration: CooldownExpiration,
}

impl CooldownSlot {
    pub(super) fn index(&self) -> u32 {
        self.claim.index()
    }

    fn deadline(&self) -> Option<Instant> {
        self.expiration.deadline()
    }

    #[cfg(test)]
    pub(super) fn expire_for_test(&mut self) {
        self.expiration = CooldownExpiration::At(Instant::now());
    }
}

/// Configuration for the device pool.
pub struct DevicePoolConfig {
    /// Cooldown period before a released device can be reused.
    ///
    /// If a released claim's deadline cannot be represented as an [`Instant`],
    /// the claim remains in a non-expiring cooldown until pool cleanup or drop.
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
pub(crate) struct DevicePoolSnapshot {
    pub(crate) cooldown: Vec<u32>,
    pub(crate) in_flight: HashSet<u32>,
    pub(super) waiting_acquires: usize,
}

/// NBD device claim pool.
///
/// Successful acquisitions use either a demand scan for a new claim or a
/// cooled claim retained from a clean release. Production callers should share
/// the pool through [`crate::pool::DevicePoolHandle`] so release authority stays
/// tied to owned device leases.
pub struct DevicePool {
    pub(super) active: bool,
    /// Recently released device claims waiting for cooldown to expire.
    pub(super) cooldown: VecDeque<CooldownSlot>,
    /// Weak sender used to embed a strong return path in assigned leases.
    pub(super) lease_return: Option<mpsc::WeakUnboundedSender<DevicePoolCommand>>,
    /// Acquire errors that raced with still-pending scans.
    pub(super) deferred_acquire_errors: VecDeque<NbdCowError>,
    /// A complete shared scan that found no claim, deferred behind cooldown.
    pub(super) deferred_scan_exhaustion: bool,
    /// Acquire requests waiting for a scan or an expired cooldown claim.
    pub(super) waiting_acquires: VecDeque<oneshot::Sender<Result<DeviceAcquisition>>>,
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
            deferred_scan_exhaustion: false,
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
        respond_to: oneshot::Sender<Result<DeviceAcquisition>>,
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
            self.deferred_scan_exhaustion = false;
            return;
        }

        if pending_scans == 0 && !self.cooldown_timer_pending() {
            if !self.deferred_acquire_errors.is_empty() {
                self.fail_deferred_acquire_errors();
            } else if self.deferred_scan_exhaustion {
                self.fail_all_waiters();
            }
        }

        if self.waiting_acquires.is_empty() {
            self.deferred_acquire_errors.clear();
            self.deferred_scan_exhaustion = false;
        }
    }

    pub(super) fn scans_to_spawn(&self, pending_scans: usize) -> usize {
        if !self.active || !self.deferred_acquire_errors.is_empty() || self.deferred_scan_exhaustion
        {
            return 0;
        }
        let remaining_capacity = MAX_PENDING.saturating_sub(pending_scans);
        let waiting_without_scan = self.waiting_acquires.len().saturating_sub(pending_scans);
        remaining_capacity.min(waiting_without_scan)
    }

    pub(super) fn scan_request(&self) -> ScanRequest {
        ScanRequest::new(
            self.max_devices,
            self.tracked_indices(),
            self.lock_dir.clone(),
            self.device_appears_free,
        )
    }

    pub(super) fn handle_scan_claim(&mut self, scanned: ScannedDeviceClaim) {
        let (claim, scan_duration) = scanned.into_parts();
        if self.is_tracked(claim.index()) {
            tracing::warn!(
                device_index = claim.index(),
                "dropping scan result because index is already tracked"
            );
        } else {
            self.assign_claim_to_waiter(
                claim,
                DeviceAcquireSource::DemandScan,
                Some(scan_duration),
            );
        }
    }

    pub(super) fn assign_claim_to_waiter(
        &mut self,
        mut claim: NbdDeviceClaim,
        source: DeviceAcquireSource,
        scan_duration: Option<Duration>,
    ) -> bool {
        let index = claim.index();
        while let Some(respond_to) = self.waiting_acquires.pop_front() {
            let acquisition = DeviceAcquisition::new(self.lease_for(claim), source, scan_duration);
            match respond_to.send(Ok(acquisition)) {
                Ok(()) => {
                    self.in_flight.insert(index);
                    return true;
                }
                Err(Ok(acquisition)) => {
                    let (lease, _, _) = acquisition.into_parts();
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

    pub(super) fn defer_acquire_error(&mut self, error: NbdCowError) {
        if self.waiting_acquires.is_empty() {
            return;
        }
        self.deferred_acquire_errors.push_back(error);
    }

    pub(super) fn defer_scan_exhaustion(&mut self) {
        if !self.waiting_acquires.is_empty() {
            self.deferred_scan_exhaustion = true;
        }
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
            expiration: CooldownExpiration::from_release(Instant::now(), self.config.cooldown),
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

    /// Permanently deactivate the pool.
    ///
    /// Cleanup fails queued acquire requests with [`NbdCowError::NoFreeDevice`]
    /// and causes all subsequent acquire requests to return the same error.
    /// Repeated cleanup calls are safe and idempotent.
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
        self.deferred_scan_exhaustion = false;
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
            let Some(deadline) = slot.deadline() else {
                break;
            };
            if deadline > now {
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
        self.assign_claim_to_waiter(slot.claim, DeviceAcquireSource::CooledClaim, None);
    }

    pub(super) fn next_cooldown_deadline(&self) -> Option<Instant> {
        self.cooldown.front().and_then(CooldownSlot::deadline)
    }

    fn cooldown_timer_pending(&self) -> bool {
        // Cooldown slots are FIFO and every slot uses the same pool cooldown, so
        // only the front slot can produce the next timer-driven state change.
        self.next_cooldown_deadline().is_some()
    }

    /// Collect all indices currently tracked by the pool (cooldown + in-flight)
    /// to exclude from demand scans. Concurrent scans are still safe because the
    /// shared per-index lock serializes cooperating tasks and processes.
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
