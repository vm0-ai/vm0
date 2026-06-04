use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use tracing::{debug, info};

use super::active_sessions::{ActiveSessions, active_session_ids};
use crate::config::ProfileConfig;
use crate::idle_pool::IdlePool;
use crate::provider::JobProvider;
use crate::resource_budget::ResourceBudget;
use crate::status::RunnerMode;
use crate::types::{HeartbeatState, HeldSessionState, MAX_HELD_SESSION_STATES};
use crate::workspace_image_cache::SessionWorkspaceCache;

/// Period between routine heartbeat ticks sent to the server. First tick is
/// deferred by one period via `interval_at`.
pub(super) const HEARTBEAT_PERIOD: Duration = Duration::from_secs(10);

/// References needed to collect and send a heartbeat.
///
/// Avoids passing 8+ arguments through `send_heartbeat`.
pub(super) struct HeartbeatContext<'a> {
    idle_pool: &'a Arc<tokio::sync::Mutex<IdlePool>>,
    runner_id: &'a str,
    name: &'a str,
    group: &'a str,
    profiles: &'a BTreeMap<String, ProfileConfig>,
    budget: &'a ResourceBudget,
    provider: &'a dyn JobProvider,
    workspace_cache: Option<SessionWorkspaceCache>,
    active_sessions: &'a ActiveSessions,
}

pub(super) struct HeartbeatContextInit<'a> {
    pub(super) idle_pool: &'a Arc<tokio::sync::Mutex<IdlePool>>,
    pub(super) runner_id: &'a str,
    pub(super) name: &'a str,
    pub(super) group: &'a str,
    pub(super) profiles: &'a BTreeMap<String, ProfileConfig>,
    pub(super) budget: &'a ResourceBudget,
    pub(super) provider: &'a dyn JobProvider,
    pub(super) workspace_cache: Option<SessionWorkspaceCache>,
    pub(super) active_sessions: &'a ActiveSessions,
}

impl<'a> HeartbeatContext<'a> {
    pub(super) fn new(init: HeartbeatContextInit<'a>) -> Self {
        Self {
            idle_pool: init.idle_pool,
            runner_id: init.runner_id,
            name: init.name,
            group: init.group,
            profiles: init.profiles,
            budget: init.budget,
            provider: init.provider,
            workspace_cache: init.workspace_cache,
            active_sessions: init.active_sessions,
        }
    }
}

/// Collect current runner state, update the provider's held-sessions cache,
/// and send a heartbeat to the server.
pub(super) async fn send_heartbeat(hb: &HeartbeatContext<'_>, mode: RunnerMode) {
    let pool = hb.idle_pool.lock().await;
    let mut state = collect_heartbeat_state(
        hb.runner_id,
        hb.name,
        hb.group,
        hb.profiles,
        hb.budget,
        &pool,
        mode,
    );
    drop(pool);
    state.held_session_states = current_held_session_states(
        state.held_session_states,
        hb.workspace_cache.as_ref(),
        hb.active_sessions,
        None,
    )
    .await;
    info!(
        mode = ?mode,
        running = state.running_count,
        sessions = state.held_session_states.len(),
        "heartbeat"
    );
    debug!(held_session_states = ?state.held_session_states);
    hb.provider
        .set_held_session_states(state.held_session_states.clone())
        .await;
    hb.provider.heartbeat(&state).await;
}

pub(super) async fn current_held_session_states(
    idle_states: Vec<HeldSessionState>,
    workspace_cache: Option<&SessionWorkspaceCache>,
    active_sessions: &ActiveSessions,
    extra_active_session: Option<&str>,
) -> Vec<HeldSessionState> {
    let Some(cache) = workspace_cache else {
        return idle_states;
    };

    let mut active_sessions = active_session_ids(active_sessions);
    if let Some(session_id) = extra_active_session {
        active_sessions.insert(session_id.to_owned());
    }
    let cache_states = cache.held_session_states().await;
    merge_held_session_states(idle_states, cache_states, &active_sessions)
}

fn merge_held_session_states(
    idle_states: Vec<HeldSessionState>,
    cache_states: Vec<HeldSessionState>,
    active_sessions: &std::collections::HashSet<String>,
) -> Vec<HeldSessionState> {
    let mut by_session = std::collections::BTreeMap::<String, HeldSessionState>::new();
    for state in idle_states {
        by_session.insert(state.session_id.clone(), state);
    }
    for state in cache_states {
        if active_sessions.contains(&state.session_id) {
            continue;
        }
        match by_session.get(&state.session_id) {
            Some(existing) if existing.last_completed_at >= state.last_completed_at => {}
            _ => {
                by_session.insert(state.session_id.clone(), state);
            }
        }
    }
    let mut states: Vec<HeldSessionState> = by_session.into_values().collect();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    states.truncate(MAX_HELD_SESSION_STATES);
    states.sort_unstable_by(|a, b| a.session_id.cmp(&b.session_id));
    states
}

/// Collect current runner state for heartbeat reporting.
pub(super) fn collect_heartbeat_state(
    runner_id: &str,
    name: &str,
    group: &str,
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
    idle_pool: &IdlePool,
    mode: RunnerMode,
) -> HeartbeatState {
    // Stopped is set only by `status.set_mode(Stopped)` immediately before
    // `run()` returns, after the last heartbeat has been sent. If a caller
    // reaches here with Stopped it means a new code path was added that
    // heartbeats post-teardown, which breaks the contract that the server
    // never sees mode=stopped on the wire. Debug-only: release still falls
    // through to the defensive "stopping" mapping below.
    debug_assert_ne!(
        mode,
        RunnerMode::Stopped,
        "Stopped is never live-heartbeated",
    );
    let (allocated_vcpu, allocated_memory_mb, budget_running) = budget.allocated();
    // budget.allocated() includes parked (idle) VMs that hold their budget.
    // Report only actively running jobs so the scheduler sees real capacity.
    let idle_count = idle_pool.len();
    let running_count = budget_running.saturating_sub(idle_count);
    HeartbeatState {
        runner_id: runner_id.to_string(),
        runner_name: name.to_string(),
        group: group.to_string(),
        profiles: profiles.keys().cloned().collect(),
        total_vcpu: budget.effective_vcpu(),
        total_memory_mb: budget.effective_memory_mb(),
        max_concurrent: budget.max_concurrent(),
        allocated_vcpu,
        allocated_memory_mb,
        running_count,
        held_session_states: idle_pool.held_session_states(),
        mode: match mode {
            RunnerMode::Running => "running".to_string(),
            RunnerMode::Draining => "draining".to_string(),
            // Stopped caught by the debug_assert above; release falls here.
            RunnerMode::Stopping | RunnerMode::Stopped => "stopping".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use crate::idle_pool::{
        IdlePoolConfig, ParkResult, ParkedIdleCandidate, SyntheticParkedIdleCandidateParts,
    };
    use crate::paths::RunnerPaths;
    use crate::workspace_image_cache::{
        WorkspaceCacheTerminalStatus, WorkspaceImagePrepareRequest,
    };
    use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
    use sandbox::{SandboxFactory, SandboxId};
    use sandbox_mock::{MockSandbox, MockSandboxFactory};

    fn test_profiles() -> BTreeMap<String, config::ProfileConfig> {
        let mut m = BTreeMap::new();
        m.insert(
            "vm0/default".to_string(),
            config::ProfileConfig {
                rootfs_hash: "hash".into(),
                snapshot_hash: "snap".into(),
                vcpu: 2,
                memory_mb: 4096,
                rootfs_disk_mb: 8192,
                workspace_disk_mb: 10240,
            },
        );
        m
    }

    fn make_synthetic_parked_candidate(session_id: &str) -> ParkedIdleCandidate {
        let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
        ParkedIdleCandidate::synthetic_for_test(SyntheticParkedIdleCandidateParts {
            sandbox: Box::new(MockSandbox::new("test")),
            factory: Arc::new(Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>),
            session_id: session_id.into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            device_rate_limits: None,
            budget_lease: ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            source_ip: "10.0.0.1".into(),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        })
    }

    async fn seed_workspace_cache_state(
        cache: &SessionWorkspaceCache,
        paths: &RunnerPaths,
        session_id: &str,
        completed_at: &str,
    ) {
        let run_id = crate::ids::RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                profile_name: "vm0/default",
                session_id: Some(session_id),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: b"image".len() as u64,
                workspace_drive_required: true,
            })
            .await;
        let active_image = paths.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&active_image, b"image").await.unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    None,
                    WorkspaceCacheTerminalStatus::Success,
                    completed_at.into(),
                    &crate::idle_pool::StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        drop(lease);
    }

    #[test]
    fn heartbeat_running_count_no_idle() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let _leases = [
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ];
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 2);
    }

    #[tokio::test]
    async fn current_held_session_states_keeps_cache_sessions_and_filters_claimed_session() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = SessionWorkspaceCache::new(paths.clone());
        seed_workspace_cache_state(&cache, &paths, "sess-cache", "2026-06-01T00:00:00.000Z").await;
        seed_workspace_cache_state(&cache, &paths, "sess-claimed", "2026-06-01T00:00:01.000Z")
            .await;
        let active_sessions = super::super::active_sessions::new_active_sessions();
        let idle = vec![HeldSessionState {
            session_id: "sess-idle".into(),
            last_completed_at: "2026-06-01T00:00:02.000Z".into(),
        }];

        let states =
            current_held_session_states(idle, Some(&cache), &active_sessions, Some("sess-claimed"))
                .await;

        assert!(
            states.iter().any(|state| state.session_id == "sess-idle"),
            "idle session should remain advertised"
        );
        assert!(
            states.iter().any(|state| state.session_id == "sess-cache"),
            "unrelated workspace cache session should remain advertised"
        );
        assert!(
            !states
                .iter()
                .any(|state| state.session_id == "sess-claimed"),
            "currently claimed session should be filtered until the run finishes"
        );
    }

    #[test]
    fn merge_held_session_states_filters_active_cache_sessions() {
        let idle = vec![];
        let cache = vec![HeldSessionState {
            session_id: "sess-active".into(),
            last_completed_at: "2026-06-01T00:00:00.000Z".into(),
        }];
        let active = std::collections::HashSet::from(["sess-active".to_string()]);

        let merged = merge_held_session_states(idle, cache, &active);

        assert!(merged.is_empty());
    }

    #[test]
    fn merge_held_session_states_keeps_newest_duplicate() {
        let idle = vec![HeldSessionState {
            session_id: "sess-1".into(),
            last_completed_at: "2026-06-01T00:00:00.000Z".into(),
        }];
        let cache = vec![HeldSessionState {
            session_id: "sess-1".into(),
            last_completed_at: "2026-06-01T00:00:01.000Z".into(),
        }];

        let merged = merge_held_session_states(idle, cache, &std::collections::HashSet::new());

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].session_id, "sess-1");
        assert_eq!(merged[0].last_completed_at, "2026-06-01T00:00:01.000Z");
    }

    #[test]
    fn merge_held_session_states_prefers_idle_on_equal_timestamp() {
        let idle = vec![HeldSessionState {
            session_id: "sess-1".into(),
            last_completed_at: "2026-06-01T00:00:00.000Z".into(),
        }];
        let cache = vec![HeldSessionState {
            session_id: "sess-1".into(),
            last_completed_at: "2026-06-01T00:00:00.000Z".into(),
        }];

        let merged = merge_held_session_states(idle, cache, &std::collections::HashSet::new());

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].last_completed_at, "2026-06-01T00:00:00.000Z");
    }

    #[test]
    fn heartbeat_running_count_excludes_idle() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let _leases = [
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ];
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(
            pool.park(make_synthetic_parked_candidate("sess-1")),
            ParkResult::Parked,
        ));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 2);
        assert!(state.held_session_states.is_empty());
    }

    #[test]
    fn heartbeat_running_count_all_idle() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let _leases = [
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        ];
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(
            pool.park(make_synthetic_parked_candidate("sess-1")),
            ParkResult::Parked,
        ));
        assert!(matches!(
            pool.park(make_synthetic_parked_candidate("sess-2")),
            ParkResult::Parked,
        ));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 0);
    }

    #[test]
    fn heartbeat_running_count_saturates_on_transient_inconsistency() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(
            pool.park(make_synthetic_parked_candidate("sess-1")),
            ParkResult::Parked,
        ));
        assert_eq!(pool.len(), 1);
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            "r1",
            "runner-1",
            "vm0/test",
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 0);
    }
}
