//! Orphan active-run reconciliation for `runner start`.

use std::collections::BTreeMap;
use std::sync::Arc;

use sandbox::SandboxId;
use tracing::{info, warn};

use super::idle_lifecycle::SharedIdlePool;
use super::ownership::{OwnershipTransitions, RunSandbox};
use crate::ids::RunId;
use crate::process;
use crate::status::StatusTracker;

const ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OrphanedActiveRun {
    run_id: RunId,
    sandbox_id: SandboxId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OrphanedActiveRunState {
    sandbox_id: SandboxId,
    absent_scans: u8,
}

/// Claimed runs whose outer task is gone but whose VM ownership is uncertain.
#[derive(Clone)]
pub(super) struct OrphanedActiveRuns {
    inner: Arc<tokio::sync::Mutex<BTreeMap<RunId, OrphanedActiveRunState>>>,
    len: Arc<std::sync::atomic::AtomicUsize>,
}

impl OrphanedActiveRuns {
    pub(super) fn new() -> Self {
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            len: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.len.load(std::sync::atomic::Ordering::Acquire) == 0
    }

    pub(super) async fn insert(&self, run_id: RunId, sandbox_id: SandboxId) {
        let state = OrphanedActiveRunState {
            sandbox_id,
            absent_scans: 0,
        };
        let mut runs = self.inner.lock().await;
        match runs.entry(run_id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(state);
                self.len.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                entry.insert(state);
            }
        }
    }

    pub(super) async fn remove_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) -> bool {
        let mut runs = self.inner.lock().await;
        let removed =
            matches!(runs.get(&run_id), Some(current) if current.sandbox_id == sandbox_id);
        if removed {
            runs.remove(&run_id);
            self.len.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
        removed
    }

    async fn reset_absent_scans_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) {
        let mut runs = self.inner.lock().await;
        if let Some(current) = runs.get_mut(&run_id)
            && current.sandbox_id == sandbox_id
        {
            current.absent_scans = 0;
        }
    }

    async fn mark_absent_if_matching(&self, run_id: RunId, sandbox_id: SandboxId) -> Option<u8> {
        let mut runs = self.inner.lock().await;
        let current = runs.get_mut(&run_id)?;
        if current.sandbox_id != sandbox_id {
            return None;
        }
        current.absent_scans = current.absent_scans.saturating_add(1);
        Some(current.absent_scans)
    }

    async fn snapshot(&self) -> Vec<OrphanedActiveRun> {
        self.inner
            .lock()
            .await
            .iter()
            .map(|(&run_id, state)| OrphanedActiveRun {
                run_id,
                sandbox_id: state.sandbox_id,
            })
            .collect()
    }

    #[cfg(test)]
    pub(super) async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }
}

#[derive(Clone)]
pub(super) struct OrphanReapProcessDiscovery {
    pub(super) firecrackers: Arc<Vec<process::FirecrackerProcessInfo>>,
    pub(super) incomplete_for_current_runner: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OrphanReapMode {
    /// Fast path after a job task is reaped. Only reconciles ownership that is
    /// already proven by in-memory runner state.
    Immediate,
    /// Periodic path allowed to advance `/proc` absence confirmation.
    ConfirmAbsent,
    /// Shutdown path: no future periodic tick is guaranteed, so a single
    /// conclusive absent scan is enough to clear stale active status.
    ShutdownFinal,
}

pub(super) async fn reap_orphaned_active_runs(
    orphaned_active_runs: &OrphanedActiveRuns,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    mode: OrphanReapMode,
    process_discovery_override: Option<&OrphanReapProcessDiscovery>,
) {
    let records = orphaned_active_runs.snapshot().await;
    if records.is_empty() {
        return;
    }

    reap_orphaned_active_run_records(
        orphaned_active_runs,
        idle_pool,
        status,
        records,
        mode,
        process_discovery_override,
    )
    .await;
}

async fn reap_orphaned_active_run_records(
    orphaned_active_runs: &OrphanedActiveRuns,
    idle_pool: &SharedIdlePool,
    status: &StatusTracker,
    records: Vec<OrphanedActiveRun>,
    mode: OrphanReapMode,
    process_discovery_override: Option<&OrphanReapProcessDiscovery>,
) {
    if records.is_empty() {
        return;
    }

    let pool = idle_pool.lock().await;
    let idle_snapshot = pool.status_snapshot();
    let idle_owned_records: Vec<OrphanedActiveRun> = records
        .iter()
        .copied()
        .filter(|record| pool.contains_sandbox_id(record.sandbox_id))
        .collect();
    drop(pool);
    let mut non_idle_records = Vec::new();
    let ownership = OwnershipTransitions::new(status);
    let idle_owned_runs = idle_owned_records
        .iter()
        .copied()
        .map(|record| RunSandbox::new(record.run_id, record.sandbox_id));
    let reconciled_idle_runs = ownership
        .orphan_reconciled_idle_owned(orphaned_active_runs, idle_owned_runs, idle_snapshot)
        .await;
    for run in reconciled_idle_runs {
        info!(
            run_id = %run.run_id(),
            sandbox_id = %run.sandbox_id(),
            "orphaned active run reconciled as idle-pool owned"
        );
    }
    for record in records {
        if idle_owned_records.contains(&record) {
            continue;
        } else {
            non_idle_records.push(record);
        }
    }

    if non_idle_records.is_empty() {
        return;
    }

    if mode == OrphanReapMode::Immediate {
        return;
    }

    let discovered;
    let (firecrackers, discovery_incomplete_for_current_runner) =
        if let Some(discovery) = process_discovery_override {
            (
                discovery.firecrackers.as_slice(),
                discovery.incomplete_for_current_runner,
            )
        } else {
            discovered = process::discover_all().await;
            (
                discovered.firecrackers.as_slice(),
                firecracker_discovery_incomplete_for_current_runner(&discovered.firecrackers).await,
            )
        };
    reap_orphaned_active_runs_with_firecrackers(
        orphaned_active_runs,
        status,
        non_idle_records,
        firecrackers,
        discovery_incomplete_for_current_runner,
        mode.absent_scans_before_remove(),
    )
    .await;
}

impl OrphanReapMode {
    fn absent_scans_before_remove(self) -> u8 {
        match self {
            Self::Immediate => ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            Self::ConfirmAbsent => ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
            Self::ShutdownFinal => 1,
        }
    }
}

async fn firecracker_discovery_incomplete_for_current_runner(
    firecrackers: &[process::FirecrackerProcessInfo],
) -> bool {
    let current_runner_pid = std::process::id();
    for firecracker in firecrackers
        .iter()
        .filter(|firecracker| firecracker.base_dir.is_none())
    {
        match process::process_has_ancestor(firecracker.pid, &[current_runner_pid]).await {
            Some(false) => {}
            Some(true) | None => return true,
        }
    }
    false
}

async fn reap_orphaned_active_runs_with_firecrackers(
    orphaned_active_runs: &OrphanedActiveRuns,
    status: &StatusTracker,
    records: Vec<OrphanedActiveRun>,
    firecrackers: &[process::FirecrackerProcessInfo],
    discovery_incomplete_for_current_runner: bool,
    absent_scans_before_remove: u8,
) {
    for record in records {
        let sandbox_id = record.sandbox_id.to_string();
        if process::firecracker_process_exists_for_sandbox_id(firecrackers, &sandbox_id) {
            orphaned_active_runs
                .reset_absent_scans_if_matching(record.run_id, record.sandbox_id)
                .await;
            warn!(
                run_id = %record.run_id,
                sandbox_id = %record.sandbox_id,
                "orphaned active run still has a live non-idle Firecracker process; keeping active status visible"
            );
            continue;
        }

        if discovery_incomplete_for_current_runner {
            warn!(
                run_id = %record.run_id,
                sandbox_id = %record.sandbox_id,
                "Firecracker discovery was incomplete; keeping orphaned active run visible"
            );
            continue;
        }

        let Some(absent_scans) = orphaned_active_runs
            .mark_absent_if_matching(record.run_id, record.sandbox_id)
            .await
        else {
            continue;
        };
        if absent_scans < absent_scans_before_remove {
            warn!(
                run_id = %record.run_id,
                sandbox_id = %record.sandbox_id,
                absent_scans,
                required_absent_scans = absent_scans_before_remove,
                "orphaned active run Firecracker absent; waiting for confirmation before removing active status"
            );
            continue;
        }

        let ownership = OwnershipTransitions::new(status);
        if !ownership
            .orphan_confirmed_absent(
                orphaned_active_runs,
                RunSandbox::new(record.run_id, record.sandbox_id),
            )
            .await
        {
            continue;
        }
        info!(
            run_id = %record.run_id,
            sandbox_id = %record.sandbox_id,
            absent_scans,
            "orphaned active run removed after Firecracker process was absent"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idle_pool::{
        IdlePool, IdlePoolConfig, ParkResult, ParkedIdleCandidate, StorageFingerprints,
        SyntheticParkedIdleCandidateParts,
    };
    use crate::resource_budget::ResourceBudget;
    use sandbox::SandboxFactory;
    use sandbox_mock::{MockSandbox, MockSandboxFactory};
    use std::time::Duration;

    async fn status_idle_sessions_and_active_runs(
        status_path: &std::path::Path,
    ) -> (Vec<String>, Vec<String>) {
        let raw = tokio::fs::read_to_string(status_path).await.unwrap();
        let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut sessions: Vec<String> = status
            .get("idle_vms")
            .and_then(|v| v.as_array())
            .map(|idle_vms| {
                idle_vms
                    .iter()
                    .filter_map(|vm| {
                        vm.get("session_id")
                            .and_then(|session| session.as_str())
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();
        sessions.sort_unstable();
        let mut run_ids: Vec<String> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|run| {
                run.get("run_id")
                    .and_then(|run_id| run_id.as_str())
                    .map(str::to_string)
            })
            .collect();
        run_ids.sort_unstable();
        (sessions, run_ids)
    }

    #[tokio::test]
    async fn orphan_reaper_stale_snapshot_does_not_remove_reinserted_active_run() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, stale_sandbox_id).await;
        orphans.insert(run_id, stale_sandbox_id).await;
        let stale_records = orphans.snapshot().await;

        status.add_run(run_id, current_sandbox_id).await;
        orphans.insert(run_id, current_sandbox_id).await;

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            stale_records,
            &[],
            false,
            OrphanReapMode::ShutdownFinal.absent_scans_before_remove(),
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        let remaining = orphans.snapshot().await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].run_id, run_id);
        assert_eq!(remaining[0].sandbox_id, current_sandbox_id);
    }

    #[tokio::test]
    async fn orphan_reaper_stale_idle_owned_snapshot_does_not_remove_reinserted_active_run() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let idle_pool: SharedIdlePool =
            Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                default_timeout: Duration::from_secs(300),
                max_idle: 10,
            })));
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox: Box::new(MockSandbox::new("stale-idle-owned-reaper")),
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                session_id: "sess-stale-idle-owned-reaper".into(),
                sandbox_id: stale_sandbox_id,
                profile_name: "vm0/default".into(),
                budget_lease: lease,
                source_ip: "10.0.0.1".into(),
                storage_fingerprints: StorageFingerprints::default(),
            });
        assert!(matches!(
            idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        status.add_run(run_id, stale_sandbox_id).await;
        orphans.insert(run_id, stale_sandbox_id).await;
        let stale_records = orphans.snapshot().await;

        status.add_run(run_id, current_sandbox_id).await;
        orphans.insert(run_id, current_sandbox_id).await;

        reap_orphaned_active_run_records(
            &orphans,
            &idle_pool,
            &status,
            stale_records,
            OrphanReapMode::Immediate,
            None,
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        let remaining = orphans.snapshot().await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].run_id, run_id);
        assert_eq!(remaining[0].sandbox_id, current_sandbox_id);
    }

    #[tokio::test]
    async fn orphan_reaper_removes_active_run_when_idle_pool_owns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let idle_pool: SharedIdlePool =
            Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                default_timeout: Duration::from_secs(300),
                max_idle: 10,
            })));
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let candidate =
            ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
                sandbox: Box::new(MockSandbox::new("idle-owned-reaper")),
                factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
                session_id: "sess-idle-owned-reaper".into(),
                sandbox_id,
                profile_name: "vm0/default".into(),
                budget_lease: lease,
                source_ip: "10.0.0.1".into(),
                storage_fingerprints: StorageFingerprints::default(),
            });
        assert!(matches!(
            idle_pool.lock().await.park(candidate),
            ParkResult::Parked
        ));
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;

        reap_orphaned_active_runs(
            &orphans,
            &idle_pool,
            &status,
            OrphanReapMode::Immediate,
            None,
        )
        .await;

        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(idle_sessions, vec!["sess-idle-owned-reaper"]);
        assert!(active_runs.is_empty());
        assert_eq!(orphans.len().await, 0);
    }

    #[tokio::test]
    async fn orphan_reaper_immediate_mode_does_not_count_absent_scan() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let idle_pool: SharedIdlePool =
            Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                default_timeout: Duration::from_secs(300),
                max_idle: 10,
            })));
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;

        reap_orphaned_active_runs(
            &orphans,
            &idle_pool,
            &status,
            OrphanReapMode::Immediate,
            None,
        )
        .await;
        reap_orphaned_active_runs(
            &orphans,
            &idle_pool,
            &status,
            OrphanReapMode::ConfirmAbsent,
            None,
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        assert_eq!(orphans.len().await, 1);
    }

    #[tokio::test]
    async fn orphan_reaper_removes_active_run_after_two_absent_scans() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[],
            false,
            ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        assert_eq!(orphans.len().await, 1);

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[],
            false,
            ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert!(active_runs.is_empty());
        assert_eq!(orphans.len().await, 0);
    }

    #[tokio::test]
    async fn orphan_reaper_shutdown_final_removes_active_run_after_one_absent_scan() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[],
            false,
            OrphanReapMode::ShutdownFinal.absent_scans_before_remove(),
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert!(active_runs.is_empty());
        assert_eq!(orphans.len().await, 0);
    }

    #[tokio::test]
    async fn orphan_reaper_defers_incomplete_discovery_without_resetting_absent_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[],
            false,
            ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
        )
        .await;
        let unresolved_firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: "pid-1234".to_string(),
            base_dir: None,
        };
        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[unresolved_firecracker],
            true,
            ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        assert_eq!(orphans.len().await, 1);

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[],
            false,
            ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
        )
        .await;
        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert!(
            active_runs.is_empty(),
            "incomplete discovery should not count as absent, but should not globally reset prior conclusive absence"
        );
        assert_eq!(orphans.len().await, 0);
    }

    #[tokio::test]
    async fn orphan_reaper_preserves_active_run_when_firecracker_live() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;
        let firecracker = process::FirecrackerProcessInfo {
            pid: 1234,
            ppid: Some(1),
            sandbox_id: sandbox_id.to_string(),
            base_dir: None,
        };

        reap_orphaned_active_runs_with_firecrackers(
            &orphans,
            &status,
            orphans.snapshot().await,
            &[firecracker],
            false,
            ORPHANED_ACTIVE_RUN_ABSENT_SCANS_BEFORE_REMOVE,
        )
        .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(active_runs, vec![run_id.to_string()]);
        assert_eq!(orphans.len().await, 1);
    }
}
