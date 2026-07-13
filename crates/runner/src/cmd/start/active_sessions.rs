use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::sandbox_reuse_identity::{SandboxReuseIdentity, SandboxReuseScope};

pub(super) type ActiveCliAgentSessions = Arc<Mutex<HashMap<SandboxReuseIdentity, usize>>>;

pub(super) fn new_active_cli_agent_sessions() -> ActiveCliAgentSessions {
    Arc::new(Mutex::new(HashMap::new()))
}

pub(super) fn insert_active_cli_agent_session(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
    identity: &SandboxReuseIdentity,
) {
    let mut counts = lock_counts(active_cli_agent_sessions);
    *counts.entry(identity.clone()).or_insert(0) += 1;
}

pub(super) fn remove_active_cli_agent_session(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
    identity: &SandboxReuseIdentity,
) {
    let mut counts = lock_counts(active_cli_agent_sessions);
    let Some(count) = counts.get_mut(identity) else {
        return;
    };
    *count = count.saturating_sub(1);
    if *count == 0 {
        counts.remove(identity);
    }
}

pub(super) fn active_cli_agent_session_ids(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
) -> HashSet<SandboxReuseIdentity> {
    lock_counts(active_cli_agent_sessions)
        .keys()
        .cloned()
        .collect()
}

pub(super) struct ActiveCliAgentSessionGuard {
    active_cli_agent_sessions: ActiveCliAgentSessions,
    sandbox_reuse_scope: Option<SandboxReuseScope>,
    sandbox_reuse_identity: Option<SandboxReuseIdentity>,
}

impl ActiveCliAgentSessionGuard {
    pub(super) fn new(
        active_cli_agent_sessions: ActiveCliAgentSessions,
        sandbox_reuse_scope: Option<SandboxReuseScope>,
        cli_agent_session_id: Option<String>,
    ) -> Self {
        let sandbox_reuse_identity = sandbox_reuse_scope
            .and_then(|scope| scope.with_cli_agent_session_id(cli_agent_session_id.as_deref()?));
        if let Some(identity) = sandbox_reuse_identity.as_ref() {
            insert_active_cli_agent_session(&active_cli_agent_sessions, identity);
        }
        Self {
            active_cli_agent_sessions,
            sandbox_reuse_scope,
            sandbox_reuse_identity,
        }
    }

    pub(super) fn activate_late(&mut self, discovered_cli_agent_session_id: &str) {
        if self.sandbox_reuse_identity.is_some() {
            return;
        }
        let Some(identity) = self
            .sandbox_reuse_scope
            .and_then(|scope| scope.with_cli_agent_session_id(discovered_cli_agent_session_id))
        else {
            return;
        };
        insert_active_cli_agent_session(&self.active_cli_agent_sessions, &identity);
        self.sandbox_reuse_identity = Some(identity);
    }
}

impl Drop for ActiveCliAgentSessionGuard {
    fn drop(&mut self) {
        if let Some(identity) = self.sandbox_reuse_identity.as_ref() {
            remove_active_cli_agent_session(&self.active_cli_agent_sessions, identity);
        }
    }
}

fn lock_counts(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
) -> MutexGuard<'_, HashMap<SandboxReuseIdentity, usize>> {
    active_cli_agent_sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::sandbox_reuse_identity_for_test;

    #[test]
    fn active_sessions_are_ref_counted() {
        let active_sessions = new_active_cli_agent_sessions();
        let identity = sandbox_reuse_identity_for_test("sess-1");
        insert_active_cli_agent_session(&active_sessions, &identity);
        insert_active_cli_agent_session(&active_sessions, &identity);

        assert!(active_cli_agent_session_ids(&active_sessions).contains(&identity));

        remove_active_cli_agent_session(&active_sessions, &identity);
        assert!(active_cli_agent_session_ids(&active_sessions).contains(&identity));

        remove_active_cli_agent_session(&active_sessions, &identity);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains(&identity));
    }

    #[test]
    fn active_cli_agent_session_guard_registers_and_unregisters_initial_session() {
        let active_sessions = new_active_cli_agent_sessions();
        let identity = sandbox_reuse_identity_for_test("sess-1");
        let guard = ActiveCliAgentSessionGuard::new(
            Arc::clone(&active_sessions),
            Some(identity.scope()),
            Some("sess-1".into()),
        );

        assert!(active_cli_agent_session_ids(&active_sessions).contains(&identity));

        drop(guard);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains(&identity));
    }

    #[test]
    fn active_cli_agent_session_guard_can_mark_late_discovered_session_active() {
        let active_sessions = new_active_cli_agent_sessions();
        let identity = sandbox_reuse_identity_for_test("sess-late");
        let mut guard = ActiveCliAgentSessionGuard::new(
            Arc::clone(&active_sessions),
            Some(identity.scope()),
            None,
        );

        guard.activate_late("sess-late");

        assert!(active_cli_agent_session_ids(&active_sessions).contains(&identity));
        drop(guard);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains(&identity));
    }

    #[test]
    fn active_cli_agent_session_guard_keeps_original_session_when_late_id_is_seen() {
        let active_sessions = new_active_cli_agent_sessions();
        let original = sandbox_reuse_identity_for_test("sess-original");
        let late = sandbox_reuse_identity_for_test("sess-late");
        let mut guard = ActiveCliAgentSessionGuard::new(
            Arc::clone(&active_sessions),
            Some(original.scope()),
            Some("sess-original".into()),
        );

        guard.activate_late("sess-late");

        let ids = active_cli_agent_session_ids(&active_sessions);
        assert!(ids.contains(&original));
        assert!(!ids.contains(&late));
        drop(guard);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains(&original));
    }
}
