use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Instant as StdInstant;

use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::{JobCandidate, JobDiscoverySource};
use crate::ids::RunId;

#[derive(Debug)]
pub(super) struct DirectJobCandidate {
    run_id: RunId,
    profile_name: String,
    discovered_at: StdInstant,
    cli_agent_session_id: Option<String>,
    affinity_protected_until: Option<String>,
}

impl DirectJobCandidate {
    #[cfg(test)]
    pub(super) fn new(run_id: RunId, profile_name: String) -> Self {
        Self::new_with_discovered_at(run_id, profile_name, StdInstant::now())
    }

    pub(super) fn new_with_affinity(
        run_id: RunId,
        profile_name: String,
        cli_agent_session_id: Option<String>,
        affinity_protected_until: Option<String>,
    ) -> Self {
        Self::new_with_affinity_metadata(
            run_id,
            profile_name,
            StdInstant::now(),
            cli_agent_session_id,
            affinity_protected_until,
        )
    }

    #[cfg(test)]
    pub(super) fn new_with_discovered_at(
        run_id: RunId,
        profile_name: String,
        discovered_at: StdInstant,
    ) -> Self {
        Self::new_with_affinity_metadata(run_id, profile_name, discovered_at, None, None)
    }

    pub(super) fn new_with_affinity_metadata(
        run_id: RunId,
        profile_name: String,
        discovered_at: StdInstant,
        cli_agent_session_id: Option<String>,
        affinity_protected_until: Option<String>,
    ) -> Self {
        Self {
            run_id,
            profile_name,
            discovered_at,
            cli_agent_session_id,
            affinity_protected_until,
        }
    }

    pub(super) fn run_id(&self) -> RunId {
        self.run_id
    }

    pub(super) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    #[cfg(test)]
    pub(super) fn discovered_at(&self) -> StdInstant {
        self.discovered_at
    }

    pub(super) fn into_job_candidate(self) -> JobCandidate {
        JobCandidate::new_with_discovered_at(self.run_id, self.profile_name, self.discovered_at)
            .with_affinity_metadata(self.cli_agent_session_id, self.affinity_protected_until)
            .with_discovery_source(JobDiscoverySource::Ably)
    }

    fn merge_metadata_from(&mut self, candidate: Self) {
        if self.profile_name != candidate.profile_name {
            warn!(
                run_id = %self.run_id,
                existing_profile = %self.profile_name,
                candidate_profile = %candidate.profile_name,
                "ably: duplicate direct candidate profile mismatch, keeping first profile"
            );
            return;
        }
        if candidate.cli_agent_session_id.is_some() {
            self.cli_agent_session_id = candidate.cli_agent_session_id;
        }
        if candidate.affinity_protected_until.is_some() {
            self.affinity_protected_until = candidate.affinity_protected_until;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DirectCandidateInsertOutcome {
    Inserted(DirectCandidateInboxSnapshot),
    Updated(DirectCandidateInboxSnapshot),
    Overflow {
        snapshot: DirectCandidateInboxSnapshot,
        coalesced_count: u64,
        should_wake_poll: bool,
    },
}

impl DirectCandidateInsertOutcome {
    #[cfg(test)]
    pub(super) fn snapshot(self) -> DirectCandidateInboxSnapshot {
        match self {
            Self::Inserted(snapshot) | Self::Updated(snapshot) => snapshot,
            Self::Overflow { snapshot, .. } => snapshot,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DirectCandidateInboxSnapshot {
    pub(super) depth: usize,
    pub(super) capacity: usize,
}

#[derive(Debug)]
struct DirectCandidateInboxInner {
    order: VecDeque<RunId>,
    candidates: HashMap<RunId, DirectJobCandidate>,
    overflow_active: bool,
    overflow_count: u64,
}

#[derive(Debug)]
pub(super) struct DirectCandidateInbox {
    capacity: usize,
    inner: Mutex<DirectCandidateInboxInner>,
    notify: Notify,
}

impl DirectCandidateInbox {
    pub(super) fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            capacity,
            inner: Mutex::new(DirectCandidateInboxInner {
                order: VecDeque::new(),
                candidates: HashMap::new(),
                overflow_active: false,
                overflow_count: 0,
            }),
            notify: Notify::new(),
        })
    }

    pub(super) async fn push(&self, candidate: DirectJobCandidate) -> DirectCandidateInsertOutcome {
        let mut inner = self.inner.lock().await;
        let run_id = candidate.run_id();
        if let Some(existing) = inner.candidates.get_mut(&run_id) {
            existing.merge_metadata_from(candidate);
            return DirectCandidateInsertOutcome::Updated(snapshot(
                inner.order.len(),
                self.capacity,
            ));
        }

        if inner.order.len() >= self.capacity {
            inner.overflow_count = inner.overflow_count.saturating_add(1);
            let should_wake_poll = !inner.overflow_active;
            inner.overflow_active = true;
            return DirectCandidateInsertOutcome::Overflow {
                snapshot: snapshot(inner.order.len(), self.capacity),
                coalesced_count: inner.overflow_count,
                should_wake_poll,
            };
        }

        inner.order.push_back(run_id);
        inner.candidates.insert(run_id, candidate);
        let snapshot = snapshot(inner.order.len(), self.capacity);
        drop(inner);
        self.notify.notify_one();
        DirectCandidateInsertOutcome::Inserted(snapshot)
    }

    pub(super) async fn try_pop(&self) -> Option<DirectJobCandidate> {
        let mut inner = self.inner.lock().await;
        let candidate = pop_candidate(&mut inner);
        if candidate.is_some() && inner.order.len() < self.capacity {
            inner.overflow_active = false;
            inner.overflow_count = 0;
        }
        candidate
    }

    pub(super) async fn wait_pop(&self, cancel: &CancellationToken) -> Option<DirectJobCandidate> {
        loop {
            if let Some(candidate) = self.try_pop().await {
                return Some(candidate);
            }

            tokio::select! {
                biased;
                () = cancel.cancelled() => return None,
                () = self.notify.notified() => {}
            }
        }
    }
}

fn pop_candidate(inner: &mut DirectCandidateInboxInner) -> Option<DirectJobCandidate> {
    while let Some(run_id) = inner.order.pop_front() {
        if let Some(candidate) = inner.candidates.remove(&run_id) {
            return Some(candidate);
        }
    }
    None
}

fn snapshot(depth: usize, capacity: usize) -> DirectCandidateInboxSnapshot {
    DirectCandidateInboxSnapshot { depth, capacity }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn run_id(value: u128) -> RunId {
        RunId::from(uuid::Uuid::from_u128(value))
    }

    #[tokio::test]
    async fn duplicate_run_id_occupies_one_slot_and_preserves_first_discovery_time() {
        let inbox = DirectCandidateInbox::new(4);
        let first_discovered_at = StdInstant::now() - Duration::from_secs(5);
        let second_discovered_at = StdInstant::now();
        let run_id = run_id(1);

        let inserted = inbox
            .push(DirectJobCandidate::new_with_affinity_metadata(
                run_id,
                "vm0/default".to_string(),
                first_discovered_at,
                Some("sess-1".to_string()),
                None,
            ))
            .await;
        assert_eq!(
            inserted.snapshot(),
            DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 4,
            }
        );

        let updated = inbox
            .push(DirectJobCandidate::new_with_affinity_metadata(
                run_id,
                "vm0/default".to_string(),
                second_discovered_at,
                None,
                Some("2999-01-01T00:00:00.000Z".to_string()),
            ))
            .await;
        assert!(matches!(
            updated,
            DirectCandidateInsertOutcome::Updated(DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 4,
            })
        ));

        let candidate = inbox.try_pop().await.expect("direct candidate");
        assert_eq!(candidate.discovered_at(), first_discovered_at);
        let candidate = candidate.into_job_candidate();
        assert_eq!(candidate.cli_agent_session_id(), Some("sess-1"));
        assert!(candidate.is_affinity_protected());
        assert!(inbox.try_pop().await.is_none());
    }

    #[tokio::test]
    async fn overflow_is_coalesced_until_capacity_makes_progress() {
        let inbox = DirectCandidateInbox::new(1);
        let _ = inbox
            .push(DirectJobCandidate::new(
                run_id(1),
                "vm0/default".to_string(),
            ))
            .await;

        let first_overflow = inbox
            .push(DirectJobCandidate::new(
                run_id(2),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            first_overflow,
            DirectCandidateInsertOutcome::Overflow {
                snapshot: DirectCandidateInboxSnapshot {
                    depth: 1,
                    capacity: 1,
                },
                coalesced_count: 1,
                should_wake_poll: true,
            }
        ));

        let second_overflow = inbox
            .push(DirectJobCandidate::new(
                run_id(3),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            second_overflow,
            DirectCandidateInsertOutcome::Overflow {
                snapshot: DirectCandidateInboxSnapshot {
                    depth: 1,
                    capacity: 1,
                },
                coalesced_count: 2,
                should_wake_poll: false,
            }
        ));

        assert_eq!(
            inbox.try_pop().await.expect("first candidate").run_id(),
            run_id(1)
        );
        let _ = inbox
            .push(DirectJobCandidate::new(
                run_id(4),
                "vm0/default".to_string(),
            ))
            .await;
        let reset_overflow = inbox
            .push(DirectJobCandidate::new(
                run_id(5),
                "vm0/default".to_string(),
            ))
            .await;
        assert!(matches!(
            reset_overflow,
            DirectCandidateInsertOutcome::Overflow {
                coalesced_count: 1,
                should_wake_poll: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn wait_pop_exits_on_cancel() {
        let inbox = DirectCandidateInbox::new(1);
        let cancel = CancellationToken::new();
        cancel.cancel();

        assert!(inbox.wait_pop(&cancel).await.is_none());
    }
}
