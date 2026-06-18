use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

pub(super) type ActiveCliAgentSessions = Arc<Mutex<HashMap<String, usize>>>;

pub(super) fn new_active_cli_agent_sessions() -> ActiveCliAgentSessions {
    Arc::new(Mutex::new(HashMap::new()))
}

pub(super) fn insert_active_cli_agent_session(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
    cli_agent_session_id: &str,
) {
    let mut counts = lock_counts(active_cli_agent_sessions);
    *counts.entry(cli_agent_session_id.to_owned()).or_insert(0) += 1;
}

pub(super) fn remove_active_cli_agent_session(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
    cli_agent_session_id: &str,
) {
    let mut counts = lock_counts(active_cli_agent_sessions);
    let Some(count) = counts.get_mut(cli_agent_session_id) else {
        return;
    };
    *count = count.saturating_sub(1);
    if *count == 0 {
        counts.remove(cli_agent_session_id);
    }
}

pub(super) fn active_cli_agent_session_ids(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
) -> HashSet<String> {
    lock_counts(active_cli_agent_sessions)
        .keys()
        .cloned()
        .collect()
}

pub(super) struct ActiveCliAgentSessionGuard {
    active_cli_agent_sessions: ActiveCliAgentSessions,
    cli_agent_session_id: Option<String>,
}

impl ActiveCliAgentSessionGuard {
    pub(super) fn new(
        active_cli_agent_sessions: ActiveCliAgentSessions,
        cli_agent_session_id: Option<String>,
    ) -> Self {
        if let Some(cli_agent_session_id) = cli_agent_session_id.as_deref() {
            insert_active_cli_agent_session(&active_cli_agent_sessions, cli_agent_session_id);
        }
        Self {
            active_cli_agent_sessions,
            cli_agent_session_id,
        }
    }

    pub(super) fn activate_late(&mut self, discovered_cli_agent_session_id: &str) {
        if self.cli_agent_session_id.is_some() {
            return;
        }
        insert_active_cli_agent_session(
            &self.active_cli_agent_sessions,
            discovered_cli_agent_session_id,
        );
        self.cli_agent_session_id = Some(discovered_cli_agent_session_id.to_owned());
    }
}

impl Drop for ActiveCliAgentSessionGuard {
    fn drop(&mut self) {
        if let Some(cli_agent_session_id) = self.cli_agent_session_id.as_deref() {
            remove_active_cli_agent_session(&self.active_cli_agent_sessions, cli_agent_session_id);
        }
    }
}

fn lock_counts(
    active_cli_agent_sessions: &ActiveCliAgentSessions,
) -> MutexGuard<'_, HashMap<String, usize>> {
    active_cli_agent_sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_sessions_are_ref_counted() {
        let active_sessions = new_active_cli_agent_sessions();
        insert_active_cli_agent_session(&active_sessions, "sess-1");
        insert_active_cli_agent_session(&active_sessions, "sess-1");

        assert!(active_cli_agent_session_ids(&active_sessions).contains("sess-1"));

        remove_active_cli_agent_session(&active_sessions, "sess-1");
        assert!(active_cli_agent_session_ids(&active_sessions).contains("sess-1"));

        remove_active_cli_agent_session(&active_sessions, "sess-1");
        assert!(!active_cli_agent_session_ids(&active_sessions).contains("sess-1"));
    }

    #[test]
    fn active_cli_agent_session_guard_registers_and_unregisters_initial_session() {
        let active_sessions = new_active_cli_agent_sessions();
        let guard =
            ActiveCliAgentSessionGuard::new(Arc::clone(&active_sessions), Some("sess-1".into()));

        assert!(active_cli_agent_session_ids(&active_sessions).contains("sess-1"));

        drop(guard);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains("sess-1"));
    }

    #[test]
    fn active_cli_agent_session_guard_can_mark_late_discovered_session_active() {
        let active_sessions = new_active_cli_agent_sessions();
        let mut guard = ActiveCliAgentSessionGuard::new(Arc::clone(&active_sessions), None);

        guard.activate_late("sess-late");

        assert!(active_cli_agent_session_ids(&active_sessions).contains("sess-late"));
        drop(guard);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains("sess-late"));
    }

    #[test]
    fn active_cli_agent_session_guard_keeps_original_session_when_late_id_is_seen() {
        let active_sessions = new_active_cli_agent_sessions();
        let mut guard = ActiveCliAgentSessionGuard::new(
            Arc::clone(&active_sessions),
            Some("sess-original".into()),
        );

        guard.activate_late("sess-late");

        let ids = active_cli_agent_session_ids(&active_sessions);
        assert!(ids.contains("sess-original"));
        assert!(!ids.contains("sess-late"));
        drop(guard);
        assert!(!active_cli_agent_session_ids(&active_sessions).contains("sess-original"));
    }
}
