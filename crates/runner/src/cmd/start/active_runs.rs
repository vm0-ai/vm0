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
    reuse_state: watch::Sender<ActiveRunReuseState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ActiveRunReuseState {
    Pending,
    ExactSandboxPublished,
    NoExactSandbox,
    Released,
}

pub(super) struct ActiveRunReuseProof {
    reuse_state: watch::Receiver<ActiveRunReuseState>,
}

impl ActiveRunReuseProof {
    pub(super) fn state(&self) -> ActiveRunReuseState {
        *self.reuse_state.borrow()
    }

    pub(super) async fn changed(&mut self) -> ActiveRunReuseState {
        if self.reuse_state.changed().await.is_err() {
            return ActiveRunReuseState::Released;
        }
        self.state()
    }
}

#[derive(Clone)]
pub(super) struct ActiveRunReusePublisher {
    reuse_state: watch::Sender<ActiveRunReuseState>,
    changes: watch::Sender<u64>,
}

impl ActiveRunReusePublisher {
    pub(super) fn publish_exact_sandbox(&self) -> bool {
        self.resolve_pending(ActiveRunReuseState::ExactSandboxPublished)
    }

    pub(super) fn publish_no_exact_sandbox(&self) -> bool {
        self.resolve_pending(ActiveRunReuseState::NoExactSandbox)
    }

    fn resolve_pending(&self, next: ActiveRunReuseState) -> bool {
        let changed = self.reuse_state.send_if_modified(|state| {
            if *state != ActiveRunReuseState::Pending {
                return false;
            }
            *state = next;
            true
        });
        if changed {
            bump_changes(&self.changes);
        }
        changed
    }

    #[cfg(test)]
    pub(super) fn detached() -> Self {
        let (reuse_state, _reuse_state_rx) = watch::channel(ActiveRunReuseState::Pending);
        let (changes, _changes_rx) = watch::channel(0);
        Self {
            reuse_state,
            changes,
        }
    }
}

pub(super) struct ActiveRunGuard {
    active_runs: ActiveRuns,
    run_id: Option<RunId>,
    has_reuse_key: bool,
    reuse_state: watch::Sender<ActiveRunReuseState>,
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
        let (reuse_state, _reuse_state_rx) = watch::channel(ActiveRunReuseState::Pending);
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
                reuse_state: reuse_state.clone(),
            });
        }
        drop(entries);
        bump_changes(&self.changes);
        ActiveRunGuard {
            active_runs: self.clone(),
            run_id: Some(run_id),
            has_reuse_key,
            reuse_state,
        }
    }

    pub(super) fn finalizing_predecessor(
        &self,
        run_id: RunId,
        reuse_key: &str,
        profile_name: &str,
    ) -> Option<ActiveRunReuseProof> {
        let entries = lock_entries(&self.entries);
        let entry = entries.get(&run_id)?;
        if entry.reuse_key.as_deref() != Some(reuse_key) || entry.profile_name != profile_name {
            return None;
        }
        let proof = ActiveRunReuseProof {
            reuse_state: entry.reuse_state.subscribe(),
        };
        (proof.state() == ActiveRunReuseState::Pending).then_some(proof)
    }

    pub(super) fn reuse_keys(&self) -> HashSet<String> {
        lock_entries(&self.entries)
            .values()
            .filter(|entry| *entry.reuse_state.borrow() == ActiveRunReuseState::Pending)
            .filter_map(|entry| entry.reuse_key.clone())
            .collect()
    }

    pub(super) fn has_reusable_run(&self) -> bool {
        lock_entries(&self.entries).values().any(|entry| {
            entry.reuse_key.is_some() && *entry.reuse_state.borrow() == ActiveRunReuseState::Pending
        })
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
    pub(super) fn reuse_publisher(&self) -> ActiveRunReusePublisher {
        ActiveRunReusePublisher {
            reuse_state: self.reuse_state.clone(),
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
        let was_pending = self.reuse_state.send_replace(ActiveRunReuseState::Released)
            == ActiveRunReuseState::Pending;
        bump_changes(&self.active_runs.changes);
        if self.has_reuse_key && was_pending {
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
    async fn proof_observes_exact_publication_then_release() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let run_id = RunId::new_v4();
        let guard = active_runs.register(
            run_id,
            Some("thread:finalizing".into()),
            "vm0/default".into(),
        );
        let publisher = guard.reuse_publisher();
        let mut proof = active_runs
            .finalizing_predecessor(run_id, "thread:finalizing", "vm0/default")
            .unwrap();

        assert!(publisher.publish_exact_sandbox());
        assert_eq!(
            proof.changed().await,
            ActiveRunReuseState::ExactSandboxPublished
        );
        assert!(active_runs.reuse_keys().is_empty());
        assert!(!active_runs.has_reusable_run());
        assert!(
            active_runs
                .finalizing_predecessor(run_id, "thread:finalizing", "vm0/default")
                .is_none()
        );
        drop(guard);
        assert_eq!(proof.changed().await, ActiveRunReuseState::Released);
        assert!(!active_runs.contains(run_id));
    }

    #[tokio::test]
    async fn proof_observes_no_exact_and_direct_release_outcomes() {
        let active_runs = ActiveRuns::new(Arc::new(Notify::new()));
        let no_exact_run_id = RunId::new_v4();
        let no_exact_guard = active_runs.register(
            no_exact_run_id,
            Some("thread:no-exact".into()),
            "vm0/default".into(),
        );
        let no_exact_publisher = no_exact_guard.reuse_publisher();
        let mut no_exact_proof = active_runs
            .finalizing_predecessor(no_exact_run_id, "thread:no-exact", "vm0/default")
            .unwrap();

        assert!(no_exact_publisher.publish_no_exact_sandbox());
        assert_eq!(
            no_exact_proof.changed().await,
            ActiveRunReuseState::NoExactSandbox
        );
        assert!(!no_exact_publisher.publish_exact_sandbox());
        drop(no_exact_guard);
        assert_eq!(
            no_exact_proof.changed().await,
            ActiveRunReuseState::Released
        );

        let released_run_id = RunId::new_v4();
        let released_guard = active_runs.register(
            released_run_id,
            Some("thread:released".into()),
            "vm0/default".into(),
        );
        let mut released_proof = active_runs
            .finalizing_predecessor(released_run_id, "thread:released", "vm0/default")
            .unwrap();
        drop(released_guard);
        assert_eq!(
            released_proof.changed().await,
            ActiveRunReuseState::Released
        );
    }
}
