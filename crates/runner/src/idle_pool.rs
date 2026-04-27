use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sandbox::{Sandbox, SandboxFactory, SandboxId};

use crate::resource_budget::BudgetLease;
use crate::status::IdleVm;
use crate::types::StorageManifest;

/// Default idle timeout for kept-alive VMs (30 minutes).
///
/// Re-exported via `SandboxConfig::default()` so the YAML default and
/// the in-process fallback stay locked together.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 1800;

/// Compact version fingerprints for storage manifest entries.
/// Used to skip re-downloading unchanged storages on VM reuse.
///
/// All comparisons use `(vas_storage_name, vas_version_id)` tuples.
/// For regular storages without version fields, the entry is omitted
/// from the map and will always be re-downloaded.
#[derive(Clone, Debug, Default)]
pub struct StorageFingerprints {
    /// mount_path → (vas_storage_name, vas_version_id) for regular storages.
    pub storages: HashMap<String, (String, String)>,
    /// mount_path → (vas_storage_name, vas_version_id) for artifacts.
    pub artifacts: HashMap<String, (String, String)>,
}

impl StorageFingerprints {
    pub fn from_manifest(manifest: &StorageManifest) -> Self {
        let mut storages = HashMap::new();
        for s in &manifest.storages {
            if let (Some(name), Some(ver)) = (&s.vas_storage_name, &s.vas_version_id) {
                storages.insert(s.mount_path.clone(), (name.clone(), ver.clone()));
            }
        }
        let mut artifacts = HashMap::new();
        for a in &manifest.artifacts {
            artifacts.insert(
                a.mount_path.clone(),
                (a.vas_storage_name.clone(), a.vas_version_id.clone()),
            );
        }
        Self {
            storages,
            artifacts,
        }
    }
}

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

/// Lifecycle-owned gate for whether completed jobs may enter the idle pool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ParkingState {
    Open = 0,
    SoftDraining = 1,
    Closed = 2,
}

impl ParkingState {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Open,
            1 => Self::SoftDraining,
            2 => Self::Closed,
            _ => Self::Closed,
        }
    }
}

/// Shared parking permission updated before publishing runner mode transitions.
#[derive(Clone, Debug)]
pub(crate) struct ParkingGate {
    state: Arc<AtomicU8>,
}

impl ParkingGate {
    pub(crate) fn new_open() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(ParkingState::Open as u8)),
        }
    }

    pub(crate) fn state(&self) -> ParkingState {
        ParkingState::from_u8(self.state.load(Ordering::SeqCst))
    }

    pub(crate) fn is_open(&self) -> bool {
        self.state() == ParkingState::Open
    }

    pub(crate) fn soft_drain(&self) -> bool {
        match self.state.compare_exchange(
            ParkingState::Open as u8,
            ParkingState::SoftDraining as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state) => ParkingState::from_u8(state) == ParkingState::SoftDraining,
        }
    }

    pub(crate) fn open_after_soft_drain(&self) -> bool {
        match self.state.compare_exchange(
            ParkingState::SoftDraining as u8,
            ParkingState::Open as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state) => ParkingState::from_u8(state) == ParkingState::Open,
        }
    }

    pub(crate) fn close(&self) {
        self.state
            .store(ParkingState::Closed as u8, Ordering::SeqCst);
    }
}

impl Default for ParkingGate {
    fn default() -> Self {
        Self::new_open()
    }
}

/// A sandbox parked in the idle pool, waiting for reuse.
pub struct IdleEntry {
    pub sandbox: Box<dyn Sandbox>,
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub session_id: String,
    /// Identity of the parked sandbox. Survives reuse (next job's `run_id`
    /// differs, but `sandbox_id` stays the same) and is the join key for
    /// doctor / kill / workspace-dir naming.
    pub sandbox_id: SandboxId,
    pub profile_name: String,
    pub budget_lease: BudgetLease,
    pub source_ip: String,
    pub parked_at: Instant,
    pub idle_timeout: Duration,
    /// Version fingerprints of storages downloaded in the previous turn.
    /// Used to skip re-downloading unchanged entries on reuse.
    pub storage_fingerprints: StorageFingerprints,
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

/// Reusable sandbox state handed to the executor after a successful unpark.
///
/// The budget lease is intentionally not part of this payload. The outer job
/// task owns the active lease so executor panics cannot release capacity before
/// provider completion and post-job cleanup finish.
pub struct ReusableIdleSandbox {
    pub sandbox: Box<dyn Sandbox>,
    pub sandbox_id: SandboxId,
    pub source_ip: String,
    pub storage_fingerprints: StorageFingerprints,
}

/// Physical resources needed to destroy an idle VM, without its budget lease.
pub struct IdleDestroyPayload {
    sandbox: Box<dyn Sandbox>,
    factory: Arc<Box<dyn SandboxFactory>>,
}

impl IdleDestroyPayload {
    /// Stop the sandbox and destroy it via its factory.
    pub async fn stop_and_destroy(self) {
        let mut sandbox = self.sandbox;
        match AssertUnwindSafe(sandbox.stop()).catch_unwind().await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "failed to stop idle sandbox"),
            Err(_) => tracing::warn!("idle sandbox stop panicked"),
        }
        if AssertUnwindSafe(self.factory.destroy(sandbox))
            .catch_unwind()
            .await
            .is_err()
        {
            tracing::warn!("idle sandbox destroy panicked");
        }
    }
}

impl IdleEntry {
    /// Stop the sandbox and destroy it via its factory.
    pub async fn stop_and_destroy(self) {
        let (payload, _lease) = self.into_destroy_parts();
        payload.stop_and_destroy().await;
    }

    pub fn into_reuse_parts(self) -> (ReusableIdleSandbox, BudgetLease) {
        let Self {
            sandbox,
            sandbox_id,
            source_ip,
            storage_fingerprints,
            budget_lease,
            ..
        } = self;

        (
            ReusableIdleSandbox {
                sandbox,
                sandbox_id,
                source_ip,
                storage_fingerprints,
            },
            budget_lease,
        )
    }

    pub fn into_destroy_parts(self) -> (IdleDestroyPayload, BudgetLease) {
        let Self {
            sandbox,
            factory,
            budget_lease,
            ..
        } = self;

        (IdleDestroyPayload { sandbox, factory }, budget_lease)
    }
}

/// Pool of idle sandboxes keyed by session ID.
///
/// After a job completes successfully, its sandbox can be parked here
/// instead of being destroyed. A subsequent job for the same session
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

    /// Park a sandbox in the pool. Returns the previously parked entry
    /// for this session if one existed (caller must destroy it).
    ///
    /// Returns `PoolFull(entry)` if parking is closed/soft-draining or at capacity.
    pub fn park(&mut self, session_id: String, entry: IdleEntry) -> ParkResult {
        if !self.parking_gate.is_open() {
            return ParkResult::PoolFull(entry);
        }
        if self.config.max_idle > 0 && self.entries.len() >= self.config.max_idle {
            // At capacity and this session has no existing entry to replace.
            if !self.entries.contains_key(&session_id) {
                return ParkResult::PoolFull(entry);
            }
        }
        let result = match self.entries.insert(session_id, entry) {
            Some(evicted) => ParkResult::Evicted(evicted),
            None => ParkResult::Parked,
        };
        self.bump_revision();
        result
    }

    /// Take a sandbox from the pool for reuse. Returns `None` if no
    /// sandbox is parked for this session.
    pub fn take(&mut self, session_id: &str) -> Option<IdleEntry> {
        let entry = self.entries.remove(session_id);
        if entry.is_some() {
            self.bump_revision();
        }
        entry
    }

    /// Remove and return all entries that have exceeded their idle timeout.
    pub fn evict_expired(&mut self) -> Vec<IdleEntry> {
        let now = Instant::now();
        let expired_keys: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| now.duration_since(e.parked_at) >= e.idle_timeout)
            .map(|(k, _)| k.clone())
            .collect();

        let expired: Vec<IdleEntry> = expired_keys
            .into_iter()
            .filter_map(|k| self.entries.remove(&k))
            .collect();
        if !expired.is_empty() {
            self.bump_revision();
        }
        expired
    }

    /// Evict the oldest idle entry (by park time). Used for resource
    /// pressure relief.
    pub fn evict_oldest(&mut self) -> Option<IdleEntry> {
        let oldest_key = self
            .entries
            .iter()
            .min_by_key(|(_, e)| e.parked_at)
            .map(|(k, _)| k.clone())?;
        let entry = self.entries.remove(&oldest_key);
        if entry.is_some() {
            self.bump_revision();
        }
        entry
    }

    /// Return a revisioned sorted-by-session_id snapshot suitable for status.json.
    ///
    /// Produced in a single iteration so `session_id` and `sandbox_id` can never
    /// drift out of pairing.
    pub fn status_snapshot(&self) -> IdlePoolSnapshot {
        let mut vms: Vec<IdleVm> = self
            .entries
            .iter()
            .map(|(session_id, entry)| IdleVm {
                session_id: session_id.clone(),
                sandbox_id: entry.sandbox_id,
            })
            .collect();
        vms.sort_unstable_by(|a, b| a.session_id.cmp(&b.session_id));
        IdlePoolSnapshot {
            revision: self.revision,
            idle_vms: vms,
        }
    }

    /// Return a sorted-by-session_id snapshot of the idle pool suitable
    /// for status.json. Produced in a single iteration so `session_id` and
    /// `sandbox_id` can never drift out of pairing.
    #[cfg(test)]
    pub fn held_snapshot(&self) -> Vec<IdleVm> {
        self.status_snapshot().idle_vms
    }

    /// Return the list of session IDs currently held in the pool, sorted
    /// lexicographically for deterministic heartbeat output.
    ///
    /// Prefer [`status_snapshot`](Self::status_snapshot) when pairing with
    /// sandbox IDs — it produces both views from a single iteration.
    pub fn held_sessions(&self) -> Vec<String> {
        let mut sessions: Vec<String> = self.entries.keys().cloned().collect();
        sessions.sort_unstable();
        sessions
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

    /// The default idle timeout.
    pub fn default_timeout(&self) -> Duration {
        self.config.default_timeout
    }

    /// Drain all entries from the pool. Parking permission is controlled by
    /// [`ParkingGate`] so soft-drain resume can reopen parking before
    /// `RunnerMode::Running` becomes visible.
    pub fn drain(&mut self) -> Vec<IdleEntry> {
        let entries: Vec<IdleEntry> = self.entries.drain().map(|(_, v)| v).collect();
        if !entries.is_empty() {
            self.bump_revision();
        }
        entries
    }

    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
}

/// Result of a `park` operation.
#[must_use]
pub enum ParkResult {
    /// Successfully parked; no previous entry for this session.
    Parked,
    /// Successfully parked; the returned entry was evicted (same session).
    Evicted(IdleEntry),
    /// Pool is at max capacity or disabled; the entry could not be parked.
    PoolFull(IdleEntry),
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use crate::resource_budget::ResourceBudget;

    use sandbox_mock::{MockSandbox, MockSandboxFactory};

    fn make_budget_lease(vcpu: u32, memory_mb: u32) -> BudgetLease {
        let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
        ResourceBudget::try_reserve_lease(&budget, vcpu, memory_mb).unwrap()
    }

    fn make_entry(vcpu: u32, memory_mb: u32) -> IdleEntry {
        IdleEntry {
            sandbox: Box::new(MockSandbox::new("test")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            budget_lease: make_budget_lease(vcpu, memory_mb),
            source_ip: "10.0.0.1".into(),
            parked_at: Instant::now(),
            idle_timeout: Duration::from_secs(300),
            storage_fingerprints: StorageFingerprints::default(),
        }
    }

    fn make_entry_with_park_time(
        vcpu: u32,
        memory_mb: u32,
        parked_at: Instant,
        idle_timeout: Duration,
    ) -> IdleEntry {
        IdleEntry {
            sandbox: Box::new(MockSandbox::new("test")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            budget_lease: make_budget_lease(vcpu, memory_mb),
            source_ip: "10.0.0.1".into(),
            parked_at,
            idle_timeout,
            storage_fingerprints: StorageFingerprints::default(),
        }
    }

    fn pool_config(max_idle: usize) -> IdlePoolConfig {
        IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle,
        }
    }

    #[test]
    fn park_and_take() {
        let mut pool = IdlePool::new(pool_config(0));
        assert_eq!(pool.len(), 0);

        let result = pool.park("session-1".into(), make_entry(2, 2048));
        assert!(matches!(result, ParkResult::Parked));
        assert_eq!(pool.len(), 1);

        let entry = pool.take("session-1").unwrap();
        assert_eq!(entry.budget_lease.vcpu(), 2);
        assert_eq!(entry.budget_lease.memory_mb(), 2048);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn take_missing_returns_none() {
        let mut pool = IdlePool::new(pool_config(0));
        assert!(pool.take("nonexistent").is_none());
    }

    #[test]
    fn park_same_session_evicts_previous() {
        let mut pool = IdlePool::new(pool_config(0));

        let _ = pool.park("session-1".into(), make_entry(2, 2048));
        let result = pool.park("session-1".into(), make_entry(4, 4096));

        match result {
            ParkResult::Evicted(evicted) => {
                assert_eq!(evicted.budget_lease.vcpu(), 2);
                assert_eq!(evicted.budget_lease.memory_mb(), 2048);
            }
            _ => panic!("expected Evicted"),
        }

        assert_eq!(pool.len(), 1);
        let entry = pool.take("session-1").unwrap();
        assert_eq!(entry.budget_lease.vcpu(), 4);
    }

    #[test]
    fn park_respects_max_idle() {
        let mut pool = IdlePool::new(pool_config(2));

        let _ = pool.park("s1".into(), make_entry(2, 2048));
        let _ = pool.park("s2".into(), make_entry(2, 2048));

        // Third session should fail
        let result = pool.park("s3".into(), make_entry(2, 2048));
        assert!(matches!(result, ParkResult::PoolFull(_)));
        assert_eq!(pool.len(), 2);

        // But replacing existing session should work
        let result = pool.park("s1".into(), make_entry(4, 4096));
        assert!(matches!(result, ParkResult::Evicted(_)));
        assert_eq!(pool.len(), 2);
    }

    #[test]
    fn evict_expired() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        // Entry expired 10s ago
        let _ = pool.park(
            "expired".into(),
            make_entry_with_park_time(
                2,
                2048,
                now - Duration::from_secs(310),
                Duration::from_secs(300),
            ),
        );
        // Entry still fresh
        let _ = pool.park(
            "fresh".into(),
            make_entry_with_park_time(2, 2048, now, Duration::from_secs(300)),
        );

        let evicted = pool.evict_expired();
        assert_eq!(evicted.len(), 1);
        assert_eq!(pool.len(), 1);
        assert!(pool.take("fresh").is_some());
    }

    #[test]
    fn evict_oldest() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        let _ = pool.park(
            "old".into(),
            make_entry_with_park_time(
                2,
                2048,
                now - Duration::from_secs(100),
                Duration::from_secs(300),
            ),
        );
        let _ = pool.park(
            "new".into(),
            make_entry_with_park_time(4, 4096, now, Duration::from_secs(300)),
        );

        let evicted = pool.evict_oldest().unwrap();
        assert_eq!(evicted.budget_lease.vcpu(), 2); // the old one
        assert_eq!(pool.len(), 1);
        assert!(pool.take("new").is_some());
    }

    #[test]
    fn evict_oldest_empty_returns_none() {
        let mut pool = IdlePool::new(pool_config(0));
        assert!(pool.evict_oldest().is_none());
    }

    #[test]
    fn held_sessions() {
        let mut pool = IdlePool::new(pool_config(0));
        let _ = pool.park("s1".into(), make_entry(2, 2048));
        let _ = pool.park("s2".into(), make_entry(2, 2048));

        let sessions = pool.held_sessions();
        assert_eq!(sessions, vec!["s1", "s2"]);
    }

    #[test]
    fn held_snapshot_pairs_and_sorts() {
        // Park in reverse order to ensure sort kicks in.
        let mut pool = IdlePool::new(pool_config(0));
        let entry_b = make_entry(2, 2048);
        let sid_b = entry_b.sandbox_id;
        let entry_a = make_entry(2, 2048);
        let sid_a = entry_a.sandbox_id;
        let _ = pool.park("sess-b".into(), entry_b);
        let _ = pool.park("sess-a".into(), entry_a);

        let vms = pool.held_snapshot();
        assert_eq!(vms.len(), 2);
        assert_eq!(vms[0].session_id, "sess-a");
        assert_eq!(vms[0].sandbox_id, sid_a);
        assert_eq!(vms[1].session_id, "sess-b");
        assert_eq!(vms[1].sandbox_id, sid_b);
    }

    #[test]
    fn held_snapshot_empty_pool() {
        let pool = IdlePool::new(pool_config(0));
        assert!(pool.held_snapshot().is_empty());
    }

    #[test]
    fn status_snapshot_revision_tracks_idle_vm_mutations() {
        let mut pool = IdlePool::new(pool_config(0));
        assert_eq!(pool.status_snapshot().revision, 0);

        let _ = pool.park("s1".into(), make_entry(2, 2048));
        assert_eq!(pool.status_snapshot().revision, 1);

        assert!(pool.take("s1").is_some());
        assert_eq!(pool.status_snapshot().revision, 2);

        let drained = pool.drain();
        assert!(drained.is_empty());
        assert_eq!(
            pool.status_snapshot().revision,
            2,
            "empty drain must not create a fake idle_vms mutation",
        );

        let _ = pool.park("s2".into(), make_entry(2, 2048));
        assert_eq!(pool.status_snapshot().revision, 3);

        let drained = pool.drain();
        assert_eq!(drained.len(), 1);
        assert_eq!(pool.status_snapshot().revision, 4);
    }

    #[test]
    fn drain() {
        let mut pool = IdlePool::new(pool_config(0));
        let _ = pool.park("s1".into(), make_entry(2, 2048));
        let _ = pool.park("s2".into(), make_entry(4, 4096));

        let drained = pool.drain();
        assert_eq!(drained.len(), 2);
        assert_eq!(pool.len(), 0);
        assert_eq!(pool.parking_state(), ParkingState::Open);
    }

    #[test]
    fn park_rejected_while_soft_draining() {
        let mut pool = IdlePool::new(pool_config(0));
        let gate = pool.parking_gate();
        let _ = pool.park("s1".into(), make_entry(2, 2048));
        gate.soft_drain();
        assert_eq!(pool.parking_state(), ParkingState::SoftDraining);

        let result = pool.park("s2".into(), make_entry(4, 4096));
        assert!(matches!(result, ParkResult::PoolFull(_)));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn park_rejected_when_closed() {
        let mut pool = IdlePool::new(pool_config(0));
        let gate = pool.parking_gate();
        gate.close();

        let result = pool.park("s1".into(), make_entry(2, 2048));
        assert!(matches!(result, ParkResult::PoolFull(_)));
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn soft_drain_can_reopen_parking() {
        let mut pool = IdlePool::new(pool_config(0));
        let gate = pool.parking_gate();
        gate.soft_drain();
        assert!(matches!(
            pool.park("s1".into(), make_entry(2, 2048)),
            ParkResult::PoolFull(_)
        ));

        gate.open_after_soft_drain();
        let result = pool.park("s1".into(), make_entry(2, 2048));
        assert!(matches!(result, ParkResult::Parked));
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn evict_expired_none_expired() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();
        let _ = pool.park(
            "fresh".into(),
            make_entry_with_park_time(2, 2048, now, Duration::from_secs(300)),
        );
        let evicted = pool.evict_expired();
        assert!(evicted.is_empty());
        assert_eq!(pool.len(), 1);
    }

    #[test]
    fn drain_empty_pool() {
        let mut pool = IdlePool::new(pool_config(0));
        let drained = pool.drain();
        assert!(drained.is_empty());
        assert_eq!(pool.parking_state(), ParkingState::Open);
    }

    #[test]
    fn evict_expired_all_entries() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        let _ = pool.park(
            "s1".into(),
            make_entry_with_park_time(
                2,
                2048,
                now - Duration::from_secs(400),
                Duration::from_secs(300),
            ),
        );
        let _ = pool.park(
            "s2".into(),
            make_entry_with_park_time(
                4,
                4096,
                now - Duration::from_secs(310),
                Duration::from_secs(300),
            ),
        );
        assert_eq!(pool.len(), 2);

        let evicted = pool.evict_expired();
        assert_eq!(evicted.len(), 2);
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn evict_expired_respects_per_entry_timeout() {
        let mut pool = IdlePool::new(pool_config(0));
        let now = Instant::now();

        // Short timeout (60s), parked 70s ago → expired
        let _ = pool.park(
            "short".into(),
            make_entry_with_park_time(
                2,
                2048,
                now - Duration::from_secs(70),
                Duration::from_secs(60),
            ),
        );
        // Long timeout (300s), parked 70s ago → NOT expired
        let _ = pool.park(
            "long".into(),
            make_entry_with_park_time(
                4,
                4096,
                now - Duration::from_secs(70),
                Duration::from_secs(300),
            ),
        );

        let evicted = pool.evict_expired();
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].budget_lease.vcpu(), 2); // only the short-timeout entry
        assert_eq!(pool.len(), 1);
        assert!(pool.take("long").is_some());
    }

    #[test]
    fn park_max_idle_one() {
        let mut pool = IdlePool::new(pool_config(1));

        let result = pool.park("s1".into(), make_entry(2, 2048));
        assert!(matches!(result, ParkResult::Parked));

        // Second different session rejected
        let result = pool.park("s2".into(), make_entry(4, 4096));
        assert!(matches!(result, ParkResult::PoolFull(_)));
        assert_eq!(pool.len(), 1);

        // Same session replacement still works
        let result = pool.park("s1".into(), make_entry(8, 8192));
        assert!(matches!(result, ParkResult::Evicted(_)));
        assert_eq!(pool.len(), 1);
        let entry = pool.take("s1").unwrap();
        assert_eq!(entry.budget_lease.vcpu(), 8);
    }
}
