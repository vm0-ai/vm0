//! Active, idle, and orphan ownership transitions for `runner start`.
//!
//! This module owns the ordering of cross-structure transitions. It delegates
//! persisted status to [`StatusTracker`], orphan record storage to
//! [`OrphanedActiveRuns`], and idle-pool mutation to callers that already hold
//! the right pool context. Slow sandbox operations stay outside this module.

use sandbox::SandboxId;

use super::idle_lifecycle::set_idle_status_snapshot;
use super::orphan_reap::OrphanedActiveRuns;
use crate::idle_pool::IdlePoolSnapshot;
use crate::ids::RunId;
use crate::status::StatusTracker;

/// Identity proving which sandbox a run cleanup path is allowed to affect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RunSandbox {
    run_id: RunId,
    sandbox_id: SandboxId,
}

impl RunSandbox {
    pub(super) fn new(run_id: RunId, sandbox_id: SandboxId) -> Self {
        Self { run_id, sandbox_id }
    }

    pub(super) fn run_id(self) -> RunId {
        self.run_id
    }

    pub(super) fn sandbox_id(self) -> SandboxId {
        self.sandbox_id
    }
}

/// Narrow facade for the ownership transitions that touch multiple structures.
pub(super) struct OwnershipTransitions<'a> {
    status: &'a StatusTracker,
}

impl<'a> OwnershipTransitions<'a> {
    pub(super) fn new(status: &'a StatusTracker) -> Self {
        Self { status }
    }

    /// Normal provider completion has been reported; remove matching active status.
    pub(super) async fn active_completed(&self, run: RunSandbox) -> bool {
        self.remove_matching_active(run).await
    }

    /// Active sandbox destruction completed; remove matching active status.
    pub(super) async fn active_destroy_completed(&self, run: RunSandbox) -> bool {
        self.remove_matching_active(run).await
    }

    /// Publish the idle-pool state after a caller transferred sandbox ownership.
    ///
    /// This intentionally does not remove active status; normal completion does
    /// that after `provider.complete`.
    pub(super) async fn publish_idle_status_after_pool_transfer(
        &self,
        idle_snapshot: IdlePoolSnapshot,
    ) {
        set_idle_status_snapshot(self.status, idle_snapshot).await;
    }

    /// Idle pool owns this sandbox; publish idle status before removing active status.
    pub(super) async fn active_idle_pool_owned(
        &self,
        run: RunSandbox,
        idle_snapshot: IdlePoolSnapshot,
    ) -> bool {
        set_idle_status_snapshot(self.status, idle_snapshot).await;
        self.remove_matching_active(run).await
    }

    /// Ownership is uncertain after panic; keep active status visible and track as orphan.
    pub(super) async fn active_ownership_unknown(
        &self,
        orphaned_active_runs: &OrphanedActiveRuns,
        run: RunSandbox,
    ) {
        orphaned_active_runs
            .insert(run.run_id, run.sandbox_id)
            .await;
    }

    /// Idle pool now proves ownership for these orphan records.
    ///
    /// Only runs present in `idle_snapshot` are eligible. The idle snapshot is
    /// published once, before the first matching active removal. Stale orphan
    /// records are skipped by `(run_id, sandbox_id)`.
    pub(super) async fn orphan_reconciled_idle_owned(
        &self,
        orphaned_active_runs: &OrphanedActiveRuns,
        runs: impl IntoIterator<Item = RunSandbox>,
        idle_snapshot: IdlePoolSnapshot,
    ) -> Vec<RunSandbox> {
        let mut reconciled = Vec::new();
        let mut refreshed_idle_status = false;
        for run in runs {
            if !idle_snapshot_contains_sandbox_id(&idle_snapshot, run.sandbox_id) {
                continue;
            }
            if !orphaned_active_runs
                .remove_if_matching(run.run_id, run.sandbox_id)
                .await
            {
                continue;
            }
            if !refreshed_idle_status {
                set_idle_status_snapshot(self.status, idle_snapshot.clone()).await;
                refreshed_idle_status = true;
            }
            self.remove_matching_active(run).await;
            reconciled.push(run);
        }
        reconciled
    }

    /// Process discovery confirmed the orphan sandbox absent; clear orphan state.
    ///
    /// Returns whether matching active status was also removed. A stale orphan
    /// can still be cleared when active status is already gone or points at a
    /// different sandbox.
    pub(super) async fn orphan_confirmed_absent(
        &self,
        orphaned_active_runs: &OrphanedActiveRuns,
        run: RunSandbox,
    ) -> bool {
        if !orphaned_active_runs
            .remove_if_matching(run.run_id, run.sandbox_id)
            .await
        {
            return false;
        }
        self.remove_matching_active(run).await
    }

    async fn remove_matching_active(&self, run: RunSandbox) -> bool {
        self.status
            .remove_run_if_matching(run.run_id, run.sandbox_id)
            .await
    }
}

fn idle_snapshot_contains_sandbox_id(
    idle_snapshot: &IdlePoolSnapshot,
    sandbox_id: SandboxId,
) -> bool {
    idle_snapshot
        .idle_vms
        .iter()
        .any(|idle_vm| idle_vm.sandbox_id == sandbox_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::IdleVm;

    async fn status_idle_sessions_and_active_runs(
        status_path: &std::path::Path,
    ) -> (Vec<String>, Vec<(String, String)>) {
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
        let mut active_runs: Vec<(String, String)> = status["active_runs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| {
                (
                    run["run_id"].as_str().unwrap().to_string(),
                    run["sandbox_id"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        active_runs.sort_unstable();
        (sessions, active_runs)
    }

    fn idle_snapshot(session_id: &str, sandbox_id: SandboxId) -> IdlePoolSnapshot {
        IdlePoolSnapshot {
            revision: 1,
            idle_vms: vec![IdleVm {
                session_id: session_id.to_string(),
                sandbox_id,
            }],
        }
    }

    #[tokio::test]
    async fn active_idle_pool_owned_publishes_idle_status_and_removes_active() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let transitions = OwnershipTransitions::new(&status);
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;

        assert!(
            transitions
                .active_idle_pool_owned(
                    RunSandbox::new(run_id, sandbox_id),
                    idle_snapshot("sess-owned", sandbox_id),
                )
                .await
        );

        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(idle_sessions, vec!["sess-owned"]);
        assert!(active_runs.is_empty());
    }

    #[tokio::test]
    async fn active_idle_pool_owned_preserves_reinserted_active_run() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let transitions = OwnershipTransitions::new(&status);
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, stale_sandbox_id).await;
        status.add_run(run_id, current_sandbox_id).await;

        assert!(
            !transitions
                .active_idle_pool_owned(
                    RunSandbox::new(run_id, stale_sandbox_id),
                    idle_snapshot("sess-stale", stale_sandbox_id),
                )
                .await
        );

        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(idle_sessions, vec!["sess-stale"]);
        assert_eq!(
            active_runs,
            vec![(run_id.to_string(), current_sandbox_id.to_string())]
        );
    }

    #[tokio::test]
    async fn active_ownership_unknown_registers_orphan_and_keeps_active_visible() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let transitions = OwnershipTransitions::new(&status);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;

        transitions
            .active_ownership_unknown(&orphans, RunSandbox::new(run_id, sandbox_id))
            .await;

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(
            active_runs,
            vec![(run_id.to_string(), sandbox_id.to_string())]
        );
        assert_eq!(orphans.len().await, 1);
    }

    #[tokio::test]
    async fn orphan_idle_owned_skips_stale_orphan_record() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let transitions = OwnershipTransitions::new(&status);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, stale_sandbox_id).await;
        orphans.insert(run_id, stale_sandbox_id).await;
        status.add_run(run_id, current_sandbox_id).await;
        orphans.insert(run_id, current_sandbox_id).await;

        let reconciled = transitions
            .orphan_reconciled_idle_owned(
                &orphans,
                [RunSandbox::new(run_id, stale_sandbox_id)],
                idle_snapshot("sess-stale", stale_sandbox_id),
            )
            .await;

        assert!(reconciled.is_empty());
        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&status_path).await;
        assert!(idle_sessions.is_empty());
        assert_eq!(
            active_runs,
            vec![(run_id.to_string(), current_sandbox_id.to_string())]
        );
        assert_eq!(orphans.len().await, 1);
    }

    #[tokio::test]
    async fn orphan_absent_clears_stale_orphan_without_removing_reinserted_active_run() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let transitions = OwnershipTransitions::new(&status);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let stale_sandbox_id = SandboxId::new_v4();
        let current_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, stale_sandbox_id).await;
        orphans.insert(run_id, stale_sandbox_id).await;
        status.add_run(run_id, current_sandbox_id).await;

        assert!(
            !transitions
                .orphan_confirmed_absent(&orphans, RunSandbox::new(run_id, stale_sandbox_id))
                .await
        );

        let (_idle_sessions, active_runs) =
            status_idle_sessions_and_active_runs(&status_path).await;
        assert_eq!(
            active_runs,
            vec![(run_id.to_string(), current_sandbox_id.to_string())]
        );
        assert_eq!(orphans.len().await, 0);
    }

    #[tokio::test]
    async fn orphan_idle_owned_requires_idle_snapshot_membership() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("status.json");
        let status = StatusTracker::new(status_path.clone(), 4, None, None);
        let transitions = OwnershipTransitions::new(&status);
        let orphans = OrphanedActiveRuns::new();
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let idle_sandbox_id = SandboxId::new_v4();
        status.add_run(run_id, sandbox_id).await;
        orphans.insert(run_id, sandbox_id).await;

        let reconciled = transitions
            .orphan_reconciled_idle_owned(
                &orphans,
                [RunSandbox::new(run_id, sandbox_id)],
                idle_snapshot("sess-different", idle_sandbox_id),
            )
            .await;

        assert!(reconciled.is_empty());
        let (idle_sessions, active_runs) = status_idle_sessions_and_active_runs(&status_path).await;
        assert!(idle_sessions.is_empty());
        assert_eq!(
            active_runs,
            vec![(run_id.to_string(), sandbox_id.to_string())]
        );
        assert_eq!(orphans.len().await, 1);
    }
}
