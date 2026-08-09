use std::collections::{HashMap, HashSet, hash_map};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{Notify, watch};

use crate::ids::RunId;

#[derive(Clone)]
pub(super) struct ActiveRuns {
    entries: Arc<Mutex<HashMap<RunId, ActiveRunEntry>>>,
    changes: watch::Sender<u64>,
    reuse_state_notify: Arc<Notify>,
}

struct ActiveRunEntry {
    reuse_key: Option<String>,
    profile_name: String,
    phase: watch::Sender<ActiveRunPhase>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ActiveRunPhase {
    Running,
    Finalized,
    Released,
}

pub(super) struct ActiveRunProof {
    phase: watch::Receiver<ActiveRunPhase>,
}

impl ActiveRunProof {
    pub(super) fn phase(&self) -> ActiveRunPhase {
        *self.phase.borrow()
    }

    pub(super) async fn changed(&mut self) -> ActiveRunPhase {
        if self.phase.changed().await.is_err() {
            return ActiveRunPhase::Released;
        }
        self.phase()
    }
}

#[derive(Clone)]
pub(super) struct ActiveRunFinalizationPublisher {
    phase: watch::Sender<ActiveRunPhase>,
    changes: watch::Sender<u64>,
}

impl ActiveRunFinalizationPublisher {
    pub(super) fn mark_finalized(&self) {
        if self.phase.send_if_modified(|phase| {
            if *phase != ActiveRunPhase::Running {
                return false;
            }
            *phase = ActiveRunPhase::Finalized;
            true
        }) {
            bump_changes(&self.changes);
        }
    }
}

pub(super) struct ActiveRunGuard {
    active_runs: ActiveRuns,
    run_id: Option<RunId>,
    has_reuse_key: bool,
    phase: watch::Sender<ActiveRunPhase>,
}

impl ActiveRuns {
    pub(super) fn new(reuse_state_notify: Arc<Notify>) -> Self {
        let (changes, _changes_rx) = watch::channel(0);
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            changes,
            reuse_state_notify,
        }
    }

    pub(super) fn register(
        &self,
        run_id: RunId,
        reuse_key: Option<String>,
        profile_name: String,
    ) -> ActiveRunGuard {
        let (phase, _phase_rx) = watch::channel(ActiveRunPhase::Running);
        let has_reuse_key = reuse_key.is_some();
        let mut entries = lock_entries(&self.entries);
        let entry = entries.entry(run_id);
        assert!(
            matches!(&entry, hash_map::Entry::Vacant(_)),
            "active run registered twice: {run_id}"
        );
        if let hash_map::Entry::Vacant(entry) = entry {
            entry.insert(ActiveRunEntry {
                reuse_key,
                profile_name,
                phase: phase.clone(),
            });
        }
        drop(entries);
        bump_changes(&self.changes);
        ActiveRunGuard {
            active_runs: self.clone(),
            run_id: Some(run_id),
            has_reuse_key,
            phase,
        }
    }

    pub(super) fn finalizing_predecessor(
        &self,
        run_id: RunId,
        reuse_key: &str,
        profile_name: &str,
    ) -> Option<ActiveRunProof> {
        let entries = lock_entries(&self.entries);
        let entry = entries.get(&run_id)?;
        if entry.reuse_key.as_deref() != Some(reuse_key) || entry.profile_name != profile_name {
            return None;
        }
        Some(ActiveRunProof {
            phase: entry.phase.subscribe(),
        })
    }

    pub(super) fn reuse_keys(&self) -> HashSet<String> {
        lock_entries(&self.entries)
            .values()
            .filter_map(|entry| entry.reuse_key.clone())
            .collect()
    }

    pub(super) fn has_reusable_run(&self) -> bool {
        lock_entries(&self.entries)
            .values()
            .any(|entry| entry.reuse_key.is_some())
    }

    #[cfg(test)]
    pub(super) fn contains(&self, run_id: RunId) -> bool {
        lock_entries(&self.entries).contains_key(&run_id)
    }

    pub(super) fn subscribe_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }
}

impl ActiveRunGuard {
    pub(super) fn finalization_publisher(&self) -> ActiveRunFinalizationPublisher {
        ActiveRunFinalizationPublisher {
            phase: self.phase.clone(),
            changes: self.active_runs.changes.clone(),
        }
    }

    pub(super) fn release(mut self) -> bool {
        self.release_inner()
    }

    fn release_inner(&mut self) -> bool {
        let Some(run_id) = self.run_id.take() else {
            return false;
        };
        lock_entries(&self.active_runs.entries).remove(&run_id);
        self.phase.send_replace(ActiveRunPhase::Released);
        bump_changes(&self.active_runs.changes);
        if self.has_reuse_key {
            self.active_runs.reuse_state_notify.notify_one();
        }
        self.has_reuse_key
    }
}

impl Drop for ActiveRunGuard {
    fn drop(&mut self) {
        self.release_inner();
    }
}

fn bump_changes(changes: &watch::Sender<u64>) {
    changes.send_modify(|revision| *revision = revision.wrapping_add(1));
}

fn lock_entries(
    entries: &Mutex<HashMap<RunId, ActiveRunEntry>>,
) -> MutexGuard<'_, HashMap<RunId, ActiveRunEntry>> {
    entries
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn active_runs_prove_exact_predecessor_and_preserve_shared_reuse_key() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let first_run_id = RunId::new_v4();
        let second_run_id = RunId::new_v4();
        let first = active_runs.register(
            first_run_id,
            Some("thread:shared".into()),
            "vm0/default".into(),
        );
        let second = active_runs.register(
            second_run_id,
            Some("thread:shared".into()),
            "vm0/default".into(),
        );

        assert_eq!(
            active_runs.reuse_keys(),
            HashSet::from(["thread:shared".to_string()])
        );
        assert!(active_runs.has_reusable_run());
        assert!(
            active_runs
                .finalizing_predecessor(first_run_id, "thread:shared", "vm0/default")
                .is_some()
        );
        assert!(
            active_runs
                .finalizing_predecessor(first_run_id, "thread:other", "vm0/default")
                .is_none()
        );
        assert!(
            active_runs
                .finalizing_predecessor(first_run_id, "thread:shared", "vm0/large")
                .is_none()
        );

        drop(first);
        assert!(active_runs.reuse_keys().contains("thread:shared"));
        drop(second);
        assert!(active_runs.reuse_keys().is_empty());
        assert!(!active_runs.has_reusable_run());

        let no_reuse = active_runs.register(first_run_id, None, "vm0/default".into());
        assert!(!no_reuse.release());
    }

    #[tokio::test]
    async fn proof_observes_finalization_then_release() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let run_id = RunId::new_v4();
        let guard = active_runs.register(
            run_id,
            Some("thread:finalizing".into()),
            "vm0/default".into(),
        );
        let publisher = guard.finalization_publisher();
        let mut proof = active_runs
            .finalizing_predecessor(run_id, "thread:finalizing", "vm0/default")
            .unwrap();

        publisher.mark_finalized();
        assert_eq!(proof.changed().await, ActiveRunPhase::Finalized);
        drop(guard);
        assert_eq!(proof.changed().await, ActiveRunPhase::Released);
        assert!(!active_runs.contains(run_id));
    }
}
