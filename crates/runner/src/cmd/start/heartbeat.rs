use std::collections::{BTreeMap, HashSet};
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
    workspace_cache: &'a SessionWorkspaceCache,
    active_sessions: &'a ActiveSessions,
    pub(super) runner: HeartbeatRunnerInfo<'a>,
    provider: &'a dyn JobProvider,
}

pub(super) struct HeartbeatRunnerInfo<'a> {
    runner_id: &'a str,
    name: &'a str,
    group: &'a str,
    profiles: &'a BTreeMap<String, ProfileConfig>,
    budget: &'a ResourceBudget,
}

impl<'a> HeartbeatRunnerInfo<'a> {
    pub(super) fn new(
        runner_id: &'a str,
        name: &'a str,
        group: &'a str,
        profiles: &'a BTreeMap<String, ProfileConfig>,
        budget: &'a ResourceBudget,
    ) -> Self {
        Self {
            runner_id,
            name,
            group,
            profiles,
            budget,
        }
    }
}

impl<'a> HeartbeatContext<'a> {
    pub(super) fn new(
        idle_pool: &'a Arc<tokio::sync::Mutex<IdlePool>>,
        workspace_cache: &'a SessionWorkspaceCache,
        active_sessions: &'a ActiveSessions,
        runner: HeartbeatRunnerInfo<'a>,
        provider: &'a dyn JobProvider,
    ) -> Self {
        Self {
            idle_pool,
            workspace_cache,
            active_sessions,
            runner,
            provider,
        }
    }
}

/// Collect current runner state, update the provider's held-sessions cache,
/// and send a heartbeat to the server.
pub(super) async fn send_heartbeat(hb: &HeartbeatContext<'_>, mode: RunnerMode) {
    let workspace_held_session_states = hb.workspace_cache.held_session_states().await;
    let active_session_ids = active_session_ids(hb.active_sessions);
    let pool = hb.idle_pool.lock().await;
    let state = collect_heartbeat_state(
        &hb.runner,
        &pool,
        workspace_held_session_states,
        &active_session_ids,
        mode,
    );
    drop(pool);
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

/// Collect current runner state for heartbeat reporting.
pub(super) fn collect_heartbeat_state(
    runner: &HeartbeatRunnerInfo<'_>,
    idle_pool: &IdlePool,
    workspace_held_session_states: Vec<HeldSessionState>,
    active_session_ids: &HashSet<String>,
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
    let (allocated_vcpu, allocated_memory_mb, budget_running) = runner.budget.allocated();
    // budget.allocated() includes parked (idle) VMs that hold their budget.
    // Report only actively running jobs so the scheduler sees real capacity.
    let idle_count = idle_pool.len();
    let running_count = budget_running.saturating_sub(idle_count);
    HeartbeatState {
        runner_id: runner.runner_id.to_string(),
        runner_name: runner.name.to_string(),
        group: runner.group.to_string(),
        profiles: runner.profiles.keys().cloned().collect(),
        total_vcpu: runner.budget.effective_vcpu(),
        total_memory_mb: runner.budget.effective_memory_mb(),
        max_concurrent: runner.budget.max_concurrent(),
        allocated_vcpu,
        allocated_memory_mb,
        running_count,
        held_session_states: merge_held_session_states(
            idle_pool.held_session_states(),
            filter_active_held_session_states(workspace_held_session_states, active_session_ids),
        ),
        mode: match mode {
            RunnerMode::Running => "running".to_string(),
            RunnerMode::Draining => "draining".to_string(),
            // Stopped caught by the debug_assert above; release falls here.
            RunnerMode::Stopping | RunnerMode::Stopped => "stopping".to_string(),
        },
    }
}

pub(super) fn filter_active_held_session_states(
    mut states: Vec<HeldSessionState>,
    active_session_ids: &HashSet<String>,
) -> Vec<HeldSessionState> {
    states.retain(|state| !active_session_ids.contains(&state.session_id));
    states
}

pub(super) fn merge_held_session_states(
    primary: Vec<HeldSessionState>,
    secondary: Vec<HeldSessionState>,
) -> Vec<HeldSessionState> {
    let mut merged: Vec<MergedHeldSessionState> = primary
        .into_iter()
        .map(|state| MergedHeldSessionState {
            state,
            from_primary: true,
        })
        .collect();
    for candidate in secondary {
        match merged
            .iter_mut()
            .find(|entry| entry.state.session_id == candidate.session_id)
        {
            Some(existing) if candidate.last_completed_at > existing.state.last_completed_at => {
                existing.state = candidate;
            }
            Some(_) => {}
            None => merged.push(MergedHeldSessionState {
                state: candidate,
                from_primary: false,
            }),
        }
    }
    cap_held_session_states(merged)
}

struct MergedHeldSessionState {
    state: HeldSessionState,
    from_primary: bool,
}

fn cap_held_session_states(mut states: Vec<MergedHeldSessionState>) -> Vec<HeldSessionState> {
    if states.len() > MAX_HELD_SESSION_STATES {
        states.sort_unstable_by(|a, b| {
            b.from_primary
                .cmp(&a.from_primary)
                .then_with(|| b.state.last_completed_at.cmp(&a.state.last_completed_at))
                .then_with(|| a.state.session_id.cmp(&b.state.session_id))
        });
        states.truncate(MAX_HELD_SESSION_STATES);
    }
    states.sort_unstable_by(|a, b| a.state.session_id.cmp(&b.state.session_id));
    states.into_iter().map(|entry| entry.state).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use crate::idle_pool::{
        IdlePoolConfig, ParkResult, ParkedIdleCandidate, SyntheticParkedIdleCandidateParts,
    };
    use crate::ids::RunId;
    use crate::paths::{HomePaths, RunnerPaths};
    use crate::workspace_image_cache::{
        SessionWorkspaceCache, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
        WorkspaceImagePrepareRequest,
    };
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
                disk_mb: 10240,
            },
        );
        m
    }

    fn test_runner_info<'a>(
        profiles: &'a BTreeMap<String, config::ProfileConfig>,
        budget: &'a ResourceBudget,
    ) -> HeartbeatRunnerInfo<'a> {
        HeartbeatRunnerInfo::new("r1", "runner-1", "vm0/test", profiles, budget)
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

        let runner = test_runner_info(&profiles, &budget);
        let state = collect_heartbeat_state(
            &runner,
            &pool,
            Vec::new(),
            &HashSet::new(),
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 2);
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

        let runner = test_runner_info(&profiles, &budget);
        let state = collect_heartbeat_state(
            &runner,
            &pool,
            Vec::new(),
            &HashSet::new(),
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

        let runner = test_runner_info(&profiles, &budget);
        let state = collect_heartbeat_state(
            &runner,
            &pool,
            Vec::new(),
            &HashSet::new(),
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

        let runner = test_runner_info(&profiles, &budget);
        let state = collect_heartbeat_state(
            &runner,
            &pool,
            Vec::new(),
            &HashSet::new(),
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 0);
    }

    #[test]
    fn merge_held_session_states_keeps_newest_and_dedupes() {
        let merged = merge_held_session_states(
            vec![
                HeldSessionState {
                    session_id: "a".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
                HeldSessionState {
                    session_id: "b".into(),
                    last_completed_at: "2026-05-02T00:00:00.000Z".into(),
                },
            ],
            vec![
                HeldSessionState {
                    session_id: "a".into(),
                    last_completed_at: "2026-05-03T00:00:00.000Z".into(),
                },
                HeldSessionState {
                    session_id: "c".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
            ],
        );

        assert_eq!(
            merged,
            vec![
                HeldSessionState {
                    session_id: "a".into(),
                    last_completed_at: "2026-05-03T00:00:00.000Z".into(),
                },
                HeldSessionState {
                    session_id: "b".into(),
                    last_completed_at: "2026-05-02T00:00:00.000Z".into(),
                },
                HeldSessionState {
                    session_id: "c".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
            ]
        );
    }

    #[test]
    fn filter_active_held_session_states_removes_running_sessions() {
        let filtered = filter_active_held_session_states(
            vec![
                HeldSessionState {
                    session_id: "active".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
                HeldSessionState {
                    session_id: "idle".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
            ],
            &HashSet::from(["active".to_string()]),
        );

        assert_eq!(
            filtered,
            vec![HeldSessionState {
                session_id: "idle".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
            }]
        );
    }

    #[test]
    fn collect_heartbeat_caps_held_session_states_to_newest() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let profiles = test_profiles();
        let runner = test_runner_info(&profiles, &budget);
        let workspace_states: Vec<HeldSessionState> = (0..=MAX_HELD_SESSION_STATES)
            .map(|index| HeldSessionState {
                session_id: format!("sess-{index:03}"),
                last_completed_at: format!(
                    "2026-05-01T00:{:02}:{:02}.000Z",
                    index / 60,
                    index % 60
                ),
            })
            .collect();

        let state = collect_heartbeat_state(
            &runner,
            &pool,
            workspace_states,
            &HashSet::new(),
            RunnerMode::Running,
        );

        let newest_session_id = format!("sess-{MAX_HELD_SESSION_STATES:03}");
        assert_eq!(state.held_session_states.len(), MAX_HELD_SESSION_STATES);
        assert!(
            state
                .held_session_states
                .iter()
                .any(|state| state.session_id == newest_session_id)
        );
        assert!(
            !state
                .held_session_states
                .iter()
                .any(|state| state.session_id == "sess-000")
        );
    }

    #[test]
    fn merge_held_session_states_caps_after_prioritizing_primary_sessions() {
        let primary = vec![HeldSessionState {
            session_id: "idle-old".into(),
            last_completed_at: "2026-05-01T00:00:00.000Z".into(),
        }];
        let secondary: Vec<HeldSessionState> = (0..MAX_HELD_SESSION_STATES)
            .map(|index| HeldSessionState {
                session_id: format!("cache-{index:03}"),
                last_completed_at: format!("2026-05-01T00:00:01.{index:03}Z"),
            })
            .collect();

        let merged = merge_held_session_states(primary, secondary);

        assert_eq!(merged.len(), MAX_HELD_SESSION_STATES);
        assert!(
            merged.iter().any(|state| state.session_id == "idle-old"),
            "idle-pool sessions should not be displaced by newer workspace cache entries"
        );
    }

    #[test]
    fn collect_heartbeat_filters_active_workspace_cache_but_keeps_idle_pool_session() {
        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        assert!(matches!(
            pool.park(
                make_synthetic_parked_candidate("active")
                    .with_last_completed_at("2026-05-02T00:00:00.000Z".into())
            ),
            ParkResult::Parked,
        ));
        let profiles = test_profiles();

        let runner = test_runner_info(&profiles, &budget);
        let state = collect_heartbeat_state(
            &runner,
            &pool,
            vec![
                HeldSessionState {
                    session_id: "active".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
                HeldSessionState {
                    session_id: "cache-only".into(),
                    last_completed_at: "2026-05-01T00:00:00.000Z".into(),
                },
            ],
            &HashSet::from(["active".to_string(), "cache-only".to_string()]),
            RunnerMode::Running,
        );

        assert_eq!(
            state.held_session_states,
            vec![HeldSessionState {
                session_id: "active".into(),
                last_completed_at: "2026-05-02T00:00:00.000Z".into(),
            }]
        );
    }

    #[tokio::test]
    async fn collect_heartbeat_hides_late_active_workspace_cache_until_guard_drop() {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("home"));
        let runner_paths = RunnerPaths::new(dir.path().join("runner"));
        let cache = SessionWorkspaceCache::shared(runner_paths.clone(), &home, "test-group");
        let run_id = RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                run_id,
                sandbox_id,
                session_id: None,
                working_dir: "/workspace",
                image_size_bytes: 5,
                workspace_drive_required: false,
            })
            .await;
        assert_eq!(lease.result(), WorkspaceCacheCheckoutResult::NoSession);
        tokio::fs::create_dir_all(runner_paths.workspace_dir(&sandbox_id))
            .await
            .unwrap();
        tokio::fs::write(runner_paths.active_workspace_image(&sandbox_id), b"image")
            .await
            .unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    Some("sess-late"),
                    WorkspaceCacheTerminalStatus::Success,
                    "2026-05-01T00:00:00.000Z".into(),
                    &crate::idle_pool::StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
        assert_eq!(cache.held_session_states().await.len(), 1);

        let active_sessions = super::super::active_sessions::new_active_sessions();
        let mut guard = super::super::active_sessions::ActiveSessionGuard::new(
            Arc::clone(&active_sessions),
            None,
        );
        guard.activate_late("sess-late");

        let budget = Arc::new(ResourceBudget::new(8, 32768, 1.0, 4));
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let profiles = test_profiles();
        let runner = test_runner_info(&profiles, &budget);
        let active_state = collect_heartbeat_state(
            &runner,
            &pool,
            cache.held_session_states().await,
            &super::super::active_sessions::active_session_ids(&active_sessions),
            RunnerMode::Running,
        );
        assert!(active_state.held_session_states.is_empty());

        drop(guard);
        let idle_state = collect_heartbeat_state(
            &runner,
            &pool,
            cache.held_session_states().await,
            &super::super::active_sessions::active_session_ids(&active_sessions),
            RunnerMode::Running,
        );
        assert_eq!(
            idle_state.held_session_states,
            vec![HeldSessionState {
                session_id: "sess-late".into(),
                last_completed_at: "2026-05-01T00:00:00.000Z".into(),
            }]
        );
    }
}
