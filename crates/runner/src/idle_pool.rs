use std::collections::HashMap;
use std::time::{Duration, Instant};

use sandbox::{DeviceRateLimits, SandboxId};

use crate::ids::RunId;
use crate::status::IdleVm;
use crate::types::{HeldSandboxState, ReusableSandboxState};

mod entry;
mod park_transition;
mod parking_gate;

pub(crate) use entry::{DestroyOutcome, IdleDestroyPayload, IdleDestroyResult};
pub use entry::{
    IdleDestroyJob, IdleEntry, IdleUnparkResult, ParkedIdleCandidate, RejectedParkedIdleCandidate,
    ReservedIdleSandbox, RestoreReservedIdleResult, ReusableIdleSandbox, ReusableIdleSandboxParts,
};
pub(crate) use park_transition::{
    IdleParkActiveParts, IdleParkFailureParts, IdleParkRequest, IdleParkRequestParts,
};
pub(crate) use parking_gate::ParkingGate;
#[cfg(test)]
pub(crate) use parking_gate::ParkingState;

#[cfg(test)]
pub(crate) mod test_support;

/// Default idle timeout for kept-alive VMs (30 minutes).
///
/// Re-exported via `SandboxConfig::default()` so the YAML default and
/// the in-process fallback stay locked together.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 1800;

/// Configuration for the idle sandbox pool.
#[derive(Debug, Clone)]
pub struct IdlePoolConfig {
    /// Default idle timeout for parked VMs.
    pub default_timeout: Duration,
    /// Maximum number of idle VMs (0 = unlimited).
    pub max_idle: usize,
}

impl Default for IdlePoolConfig {
    fn default() -> Self {
        Self {
            default_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
            max_idle: 0,
        }
    }
}

/// Idle pool status snapshot paired with a monotonic mutation revision.
///
/// Status writes happen after dropping the pool lock, so an older snapshot can
/// otherwise complete after a newer drain/evict write and reintroduce stale
/// `idle_vms` in status.json.
#[derive(Clone, Debug)]
pub struct IdlePoolSnapshot {
    pub revision: u64,
    pub idle_vms: Vec<IdleVm>,
}

/// Pool of idle sandboxes keyed by reuse key.
///
/// After a job completes successfully, its sandbox can be parked here
/// instead of being destroyed. A subsequent job for the same reuse key
/// can reuse the parked sandbox, skipping VM creation and startup.
pub struct IdlePool {
    entries: HashMap<String, IdleEntry>,
    config: IdlePoolConfig,
    revision: u64,
    /// Shared lifecycle gate. The signal/main-loop lifecycle controller updates
    /// this before publishing externally visible mode transitions.
    parking_gate: ParkingGate,
}

impl IdlePool {
    #[cfg(test)]
    pub fn new(config: IdlePoolConfig) -> Self {
        Self::new_with_parking_gate(config, ParkingGate::new_open())
    }

    pub(crate) fn new_with_parking_gate(config: IdlePoolConfig, parking_gate: ParkingGate) -> Self {
        Self {
            entries: HashMap::new(),
            config,
            revision: 0,
            parking_gate,
        }
    }

    /// Park a sandbox in the pool. Returns the previously parked destroy job
    /// for this reuse key if one existed (caller must destroy it).
    ///
    /// Returns `Rejected(candidate)` if parking is closed/soft-draining or at capacity.
    pub fn park(&mut self, candidate: ParkedIdleCandidate) -> ParkResult {
        self.park_at(candidate, Instant::now(), self.config.default_timeout)
    }

    #[cfg(test)]
    pub fn park_at_for_test(
        &mut self,
        candidate: ParkedIdleCandidate,
        parked_at: Instant,
        idle_timeout: Duration,
    ) -> ParkResult {
        self.park_at(candidate, parked_at, idle_timeout)
    }

    fn park_at(
        &mut self,
        candidate: ParkedIdleCandidate,
        parked_at: Instant,
        idle_timeout: Duration,
    ) -> ParkResult {
        let reuse_key = candidate.reuse_key().to_string();
        if !self.parking_gate.is_open() {
            return ParkResult::Rejected(candidate.into_rejected());
        }
        if self.config.max_idle > 0 && self.entries.len() >= self.config.max_idle {
            // At capacity and this reuse key has no existing entry to replace.
            if !self.entries.contains_key(&reuse_key) {
                return ParkResult::Rejected(candidate.into_rejected());
            }
        }
        let entry = candidate.into_idle_entry(parked_at, idle_timeout);
        let result = match self.entries.insert(reuse_key, entry) {
            Some(evicted) => ParkResult::Replaced(evicted.into_destroy_job()),
            None => ParkResult::Parked,
        };
        self.bump_revision();
        result
    }

    pub fn take(&mut self, reuse_key: &str) -> Option<IdleEntry> {
        let entry = self.entries.remove(reuse_key);
        if entry.is_some() {
            self.bump_revision();
        }
        entry
    }

    pub fn has_reusable(
        &self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> bool {
        self.entries.get(reuse_key).is_some_and(|entry| {
            !entry.is_expired_at(Instant::now())
                && entry.profile_name() == profile_name
                && entry.device_rate_limits() == device_rate_limits
        })
    }

    pub fn reserve_reusable(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
    ) -> Option<ReservedIdleSandbox> {
        if !self.has_reusable(reuse_key, profile_name, device_rate_limits) {
            return None;
        }
        let entry = self.entries.remove(reuse_key)?;
        self.bump_revision();
        Some(ReservedIdleSandbox { entry })
    }

    pub fn reserve_reusable_generation(
        &mut self,
        reuse_key: &str,
        profile_name: &str,
        device_rate_limits: &Option<DeviceRateLimits>,
        history_generation_run_id: RunId,
    ) -> Option<ReservedIdleSandbox> {
        if !self.has_reusable(reuse_key, profile_name, device_rate_limits)
            || self
                .entries
                .get(reuse_key)
                .and_then(|entry| entry.metadata.history_generation_run_id)
                != Some(history_generation_run_id)
        {
            return None;
        }
        let entry = self.entries.remove(reuse_key)?;
        self.bump_revision();
        Some(ReservedIdleSandbox { entry })
    }

    pub fn restore_reserved(
        &mut self,
        reservation: ReservedIdleSandbox,
    ) -> RestoreReservedIdleResult {
        let entry = reservation.entry;
        let reuse_key = entry.reuse_key().to_owned();
        let has_capacity = self.config.max_idle == 0 || self.entries.len() < self.config.max_idle;
        if !self.parking_gate.is_open()
            || entry.is_expired_at(Instant::now())
            || !has_capacity
            || self.entries.contains_key(&reuse_key)
        {
            return RestoreReservedIdleResult::Rejected(Box::new(entry.into_destroy_job()));
        }

        self.entries.insert(reuse_key, entry);
        self.bump_revision();
        RestoreReservedIdleResult::Restored
    }

    /// Remove and return all entries that have exceeded their idle timeout.
    pub fn evict_expired(&mut self) -> Vec<IdleDestroyJob> {
        let now = Instant::now();
        let expired: Vec<IdleDestroyJob> = self
            .entries
            .extract_if(|_, entry| entry.is_expired_at(now))
            .map(|(_, entry)| entry.into_destroy_job())
            .collect();
        if !expired.is_empty() {
            self.bump_revision();
        }
        expired
    }

    /// Remove expired entries and return the post-eviction idle status snapshot.
    pub fn evict_expired_with_snapshot(&mut self) -> (Vec<IdleDestroyJob>, IdlePoolSnapshot) {
        let expired = self.evict_expired();
        let snapshot = self.status_snapshot();
        (expired, snapshot)
    }

    /// Evict the oldest idle entry (by park time). Used for resource
    /// pressure relief.
    pub fn evict_oldest(&mut self) -> Option<IdleDestroyJob> {
        let oldest_key = self
            .entries
            .iter()
            .min_by_key(|(_, e)| e.parked_at)
            .map(|(k, _)| k.clone())?;
        let job = self
            .entries
            .remove(&oldest_key)
            .map(IdleEntry::into_destroy_job);
        if job.is_some() {
            self.bump_revision();
        }
        job
    }

    /// Return a revisioned reuse-key-sorted snapshot suitable for status.json.
    ///
    /// Produced in a single iteration so `reuse_key` and `sandbox_id` can never
    /// drift out of pairing.
    pub fn status_snapshot(&self) -> IdlePoolSnapshot {
        let mut vms: Vec<IdleVm> = self.entries.values().map(idle_vm_for_entry).collect();
        vms.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
        IdlePoolSnapshot {
            revision: self.revision,
            idle_vms: vms,
        }
    }

    /// Return true when the idle pool currently owns `sandbox_id`.
    pub fn contains_sandbox_id(&self, sandbox_id: SandboxId) -> bool {
        self.entries
            .values()
            .any(|entry| entry.metadata.sandbox_id == sandbox_id)
    }

    /// Return a reuse-key-sorted snapshot of the idle pool suitable
    /// for status.json. Produced in a single iteration so `reuse_key` and
    /// `sandbox_id` can never drift out of pairing.
    #[cfg(test)]
    pub fn held_snapshot(&self) -> Vec<IdleVm> {
        self.status_snapshot().idle_vms
    }

    /// Return every reusable sandbox currently held in the pool, sorted by
    /// reuse key for deterministic heartbeat output.
    ///
    /// Prefer [`status_snapshot`](Self::status_snapshot) when pairing with
    /// sandbox IDs — it produces both views from a single iteration.
    pub fn held_sandbox_states(&self) -> Vec<HeldSandboxState> {
        let mut states: Vec<HeldSandboxState> = self
            .entries
            .iter()
            .filter_map(|(reuse_key, entry)| {
                entry
                    .metadata
                    .last_completed_at
                    .as_ref()
                    .map(|last_completed_at| HeldSandboxState {
                        reuse_key: reuse_key.clone(),
                        last_completed_at: last_completed_at.clone(),
                        reusable_sandbox: ReusableSandboxState {
                            profile: entry.metadata.profile_name.clone(),
                            history_generation_run_id: entry.metadata.history_generation_run_id,
                        },
                    })
            })
            .collect();
        states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
        states
    }

    #[cfg(test)]
    pub fn held_reuse_keys(&self) -> Vec<String> {
        let mut reuse_keys: Vec<String> = self.entries.keys().cloned().collect();
        reuse_keys.sort_unstable();
        reuse_keys
    }

    /// Number of idle VMs in the pool.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Current lifecycle parking state.
    #[cfg(test)]
    pub fn parking_state(&self) -> ParkingState {
        self.parking_gate.state()
    }

    /// Shared lifecycle parking gate.
    #[cfg(test)]
    pub fn parking_gate(&self) -> ParkingGate {
        self.parking_gate.clone()
    }

    /// Drain all entries from the pool. Parking permission is controlled by
    /// [`ParkingGate`] so soft-drain resume can reopen parking before
    /// [`crate::lifecycle::RunnerMode::Running`] becomes visible.
    pub fn drain(&mut self) -> Vec<IdleDestroyJob> {
        let jobs: Vec<IdleDestroyJob> = self
            .entries
            .drain()
            .map(|(_, entry)| entry.into_destroy_job())
            .collect();
        if !jobs.is_empty() {
            self.bump_revision();
        }
        jobs
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

fn idle_vm_for_entry(entry: &IdleEntry) -> IdleVm {
    IdleVm {
        reuse_key: entry.reuse_key().to_owned(),
        sandbox_id: entry.metadata.sandbox_id,
    }
}

/// Result of a `park` operation.
#[must_use]
pub enum ParkResult {
    /// Successfully parked; no previous entry for this reuse key.
    Parked,
    /// Successfully parked; the returned job destroys the replaced idle VM.
    Replaced(IdleDestroyJob),
    /// Parking is closed/soft-draining or at capacity; the entry could not be parked.
    Rejected(RejectedParkedIdleCandidate),
}

#[cfg(test)]
mod destroy_tests;

#[cfg(test)]
mod park_transition_tests;

#[cfg(test)]
mod pool_tests;
