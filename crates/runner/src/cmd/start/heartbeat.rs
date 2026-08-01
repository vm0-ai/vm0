use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use tracing::{debug, info};

use super::active_reuse_keys::{ActiveReuseKeys, active_reuse_keys};
use crate::config::ProfileConfig;
use crate::error::{RunnerError, RunnerResult};
use crate::idle_pool::IdlePool;
use crate::lifecycle::RunnerMode;
use crate::provider::JobProvider;
use crate::resource_budget::ResourceBudget;
use crate::types::{
    HeartbeatState, HeldSessionState, HeldWorkspaceState, MAX_HELD_SESSION_STATES,
    MAX_WORKSPACE_CACHES_PER_REUSE_KEY,
};
use crate::workspace_image_cache::{WorkspaceImageCache, cap_held_workspace_states};

/// Period between routine heartbeat ticks sent to the server. First tick is
/// deferred by one period via `interval_at`.
pub(super) const HEARTBEAT_PERIOD: Duration = Duration::from_secs(10);

/// References needed to collect and send a heartbeat.
///
/// Avoids passing 8+ arguments through `send_heartbeat`.
#[derive(Clone)]
pub(super) struct HeartbeatContext<'a> {
    idle_pool: &'a Arc<tokio::sync::Mutex<IdlePool>>,
    runner_id: &'a str,
    name: &'a str,
    group: &'a str,
    snapshot_generation: u64,
    profiles: &'a BTreeMap<String, ProfileConfig>,
    budget: &'a ResourceBudget,
    provider: &'a dyn JobProvider,
    workspace_cache: Option<WorkspaceImageCache>,
    active_reuse_keys: &'a ActiveReuseKeys,
    workspace_cache_snapshot: WorkspaceCacheStateSnapshot,
}

pub(super) struct HeartbeatContextInit<'a> {
    pub(super) idle_pool: &'a Arc<tokio::sync::Mutex<IdlePool>>,
    pub(super) runner_id: &'a str,
    pub(super) name: &'a str,
    pub(super) group: &'a str,
    pub(super) snapshot_generation: u64,
    pub(super) profiles: &'a BTreeMap<String, ProfileConfig>,
    pub(super) budget: &'a ResourceBudget,
    pub(super) provider: &'a dyn JobProvider,
    pub(super) workspace_cache: Option<WorkspaceImageCache>,
    pub(super) active_reuse_keys: &'a ActiveReuseKeys,
    pub(super) workspace_cache_snapshot: WorkspaceCacheStateSnapshot,
}

impl<'a> HeartbeatContext<'a> {
    pub(super) fn new(init: HeartbeatContextInit<'a>) -> Self {
        Self {
            idle_pool: init.idle_pool,
            runner_id: init.runner_id,
            name: init.name,
            group: init.group,
            snapshot_generation: init.snapshot_generation,
            profiles: init.profiles,
            budget: init.budget,
            provider: init.provider,
            workspace_cache: init.workspace_cache,
            active_reuse_keys: init.active_reuse_keys,
            workspace_cache_snapshot: init.workspace_cache_snapshot,
        }
    }
}

/// Single-flight heartbeat work polled alongside the main reactor.
///
/// Trigger handlers only call [`request`](Self::request). The active future is
/// kept outside `tokio::select!`, so other ready branches neither await nor
/// cancel it. Any number of triggers during one send collapse into one
/// follow-up built from live state when that send starts.
pub(super) struct HeartbeatController<'a> {
    context: HeartbeatContext<'a>,
    in_flight: Option<BoxFuture<'a, ()>>,
    pending: bool,
    next_snapshot_sequence: u64,
}

impl<'a> HeartbeatController<'a> {
    pub(super) fn new(context: HeartbeatContext<'a>) -> Self {
        Self {
            context,
            in_flight: None,
            pending: false,
            next_snapshot_sequence: 1,
        }
    }

    pub(super) fn request(&mut self, mode: RunnerMode) -> RunnerResult<()> {
        if self.in_flight.is_some() {
            self.pending = true;
        } else {
            self.start(mode)?;
        }
        Ok(())
    }

    pub(super) fn is_sending(&self) -> bool {
        self.in_flight.is_some()
    }

    /// Wait for the stored future from an enabled `tokio::select!` branch.
    pub(super) async fn wait_for_send(&mut self) -> RunnerResult<()> {
        let send = self.in_flight.as_mut().ok_or_else(|| {
            RunnerError::Internal("heartbeat wait requires an active send".to_string())
        })?;
        send.await;
        Ok(())
    }

    /// Clear a completed send and start one live-state follow-up when dirty.
    pub(super) fn finish_send(&mut self, live_mode: RunnerMode) -> RunnerResult<()> {
        debug_assert!(self.in_flight.is_some());
        self.in_flight = None;
        if std::mem::take(&mut self.pending) {
            self.start(live_mode)?;
        }
        Ok(())
    }

    /// Finish current work and emit one lifecycle-critical snapshot.
    ///
    /// Natural stopping uses this to replace all ordinary pending work with a
    /// single `Stopping` heartbeat before teardown.
    pub(super) async fn flush(&mut self, mode: RunnerMode) -> RunnerResult<()> {
        self.request(mode)?;
        loop {
            self.wait_for_send().await?;
            self.in_flight = None;
            if std::mem::take(&mut self.pending) {
                self.start(mode)?;
            } else {
                break;
            }
        }
        Ok(())
    }

    /// Finish only the active send and discard ordinary coalesced work.
    ///
    /// Hard stopping calls this before provider shutdown. Awaiting the bounded
    /// request preserves local ordering without assuming that dropping a
    /// client future retracts a request already queued remotely.
    pub(super) async fn drain(&mut self) {
        if let Some(send) = self.in_flight.take() {
            send.await;
        }
        self.pending = false;
    }

    pub(super) fn into_next_snapshot_sequence(self) -> u64 {
        debug_assert!(self.in_flight.is_none());
        self.next_snapshot_sequence
    }

    fn start(&mut self, mode: RunnerMode) -> RunnerResult<()> {
        debug_assert!(self.in_flight.is_none());
        let snapshot_sequence = self.next_snapshot_sequence;
        let next_snapshot_sequence = snapshot_sequence.checked_add(1).ok_or_else(|| {
            RunnerError::Internal("heartbeat snapshot sequence overflow".to_string())
        })?;
        self.next_snapshot_sequence = next_snapshot_sequence;
        let context = self.context.clone();
        self.in_flight = Some(Box::pin(async move {
            send_heartbeat(&context, mode, snapshot_sequence).await;
        }));
        Ok(())
    }
}

/// Shared, bounded view of reusable workspaces backed by the workspace cache.
///
/// A runner shares one snapshot between heartbeat, discovery, and sandbox
/// finalization. Heartbeats refresh it from an asynchronous cache scan, while
/// finalization immediately upserts successful workspace-cache promotions.
/// The refresh token prevents a scan that started earlier from replacing a
/// promotion committed while that scan was in flight.
///
/// The mutex protects only the in-memory states and refresh metadata. Cache
/// scans run without holding it. Stored states retain active reuse keys; active
/// and just-claimed reuse keys are filtered only when a current workspace
/// view is assembled for heartbeat emission or local discovery.
#[derive(Clone, Default)]
pub(super) struct WorkspaceCacheStateSnapshot {
    inner: Arc<Mutex<WorkspaceCacheStateSnapshotInner>>,
}

#[derive(Default)]
struct WorkspaceCacheStateSnapshotInner {
    workspace_cache_states: Vec<HeldWorkspaceState>,
    workspace_cache_loaded: bool,
    workspace_cache_revision: u64,
}

/// Revision captured before a workspace-cache scan.
///
/// This is an opaque marker, not a lock guard. Pass it back to
/// [`WorkspaceCacheStateSnapshot::finish_workspace_cache_refresh`] after the
/// asynchronous scan so the commit can detect intervening snapshot updates.
#[derive(Clone, Copy)]
pub(super) struct WorkspaceCacheSnapshotRefresh {
    revision: u64,
}

impl WorkspaceCacheStateSnapshot {
    /// Creates a snapshot whose workspace-cache contents are not yet known.
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// Returns whether a refresh or promotion upsert has established cache state.
    ///
    /// Runner startup normally completes an initial refresh before discovery.
    /// A completed empty refresh is still loaded because absence is then known.
    pub(super) fn workspace_cache_loaded(&self) -> bool {
        self.lock_inner().workspace_cache_loaded
    }

    /// Captures the revision to pair with a later refresh commit.
    ///
    /// The mutex is released before this method returns and is therefore not
    /// held while the caller scans the workspace cache.
    pub(super) fn begin_workspace_cache_refresh(&self) -> WorkspaceCacheSnapshotRefresh {
        WorkspaceCacheSnapshotRefresh {
            revision: self.lock_inner().workspace_cache_revision,
        }
    }

    /// Commits scanned cache state and returns the bounded committed snapshot.
    ///
    /// When the revision still matches [`Self::begin_workspace_cache_refresh`],
    /// the scan replaces the previous cache view. Otherwise, an update occurred
    /// while the scan was in flight, so the scanned and current states are
    /// merged before applying the existing ordering and limits. In particular,
    /// this prevents an older scan from discarding a newly promoted cache.
    ///
    /// Finishing a refresh marks the snapshot loaded and advances its revision.
    /// Active-key filtering is deferred until a current view is assembled.
    pub(super) fn finish_workspace_cache_refresh(
        &self,
        refresh: WorkspaceCacheSnapshotRefresh,
        states: Vec<HeldWorkspaceState>,
    ) -> Vec<HeldWorkspaceState> {
        let mut inner = self.lock_inner();
        inner.workspace_cache_states = if inner.workspace_cache_revision == refresh.revision {
            states
        } else {
            merge_workspace_cache_snapshot_states(inner.workspace_cache_states.clone(), states)
        };
        cap_workspace_cache_snapshot_states(&mut inner.workspace_cache_states);
        inner.workspace_cache_loaded = true;
        inner.workspace_cache_revision = inner.workspace_cache_revision.wrapping_add(1);
        inner.workspace_cache_states.clone()
    }

    /// Incorporates a successful workspace-cache promotion into the snapshot.
    ///
    /// The promoted state is merged with any existing state for the reuse key,
    /// then the snapshot's deterministic ordering and bounds are reapplied.
    /// Advancing the revision ensures that an in-flight refresh merges this
    /// update instead of replacing it with an older scan result.
    pub(super) fn upsert_workspace_cache_state(&self, state: HeldWorkspaceState) {
        let mut inner = self.lock_inner();
        inner.workspace_cache_loaded = true;
        match inner
            .workspace_cache_states
            .iter_mut()
            .find(|existing| existing.reuse_key == state.reuse_key)
        {
            Some(existing) => merge_held_workspace_state(existing, state),
            None => inner.workspace_cache_states.push(state),
        }
        cap_workspace_cache_snapshot_states(&mut inner.workspace_cache_states);
        inner.workspace_cache_revision = inner.workspace_cache_revision.wrapping_add(1);
    }

    /// Reports whether the workspace-cache snapshot may contain this reuse key.
    ///
    /// Before the first load, absence has not been established, so every
    /// reuse key might be present. Once loaded, this becomes a membership check
    /// against the stored states. Discovery uses a possible match to request an
    /// immediate affinity heartbeat after claiming the key.
    pub(super) fn might_contain_workspace_cache_reuse_key(&self, reuse_key: &str) -> bool {
        let inner = self.lock_inner();
        !inner.workspace_cache_loaded
            || inner
                .workspace_cache_states
                .iter()
                .any(|state| state.reuse_key == reuse_key)
    }

    /// Builds the current workspace-cache view.
    ///
    /// Active reuse keys and `extra_active_reuse_key` are filtered while
    /// assembling this view, without removing them from the stored snapshot.
    /// The shared merge path also applies heartbeat ordering and limits.
    pub(super) fn current_held_workspace_states(
        &self,
        active_reuse_keys: &ActiveReuseKeys,
        extra_active_reuse_key: Option<&str>,
    ) -> Vec<HeldWorkspaceState> {
        let workspace_cache_states = self.lock_inner().workspace_cache_states.clone();
        filter_current_held_workspace_states(
            workspace_cache_states,
            active_reuse_keys,
            extra_active_reuse_key,
        )
    }

    fn lock_inner(&self) -> MutexGuard<'_, WorkspaceCacheStateSnapshotInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Collect current runner state, refresh the local workspace-cache snapshot, and
/// send a heartbeat to the server.
pub(super) async fn send_heartbeat(
    hb: &HeartbeatContext<'_>,
    mode: RunnerMode,
    snapshot_sequence: u64,
) {
    let pool = hb.idle_pool.lock().await;
    let mut state = collect_heartbeat_state(
        HeartbeatSnapshotMetadata {
            runner_id: hb.runner_id,
            runner_name: hb.name,
            group: hb.group,
            generation: hb.snapshot_generation,
            sequence: snapshot_sequence,
        },
        hb.profiles,
        hb.budget,
        &pool,
        mode,
    );
    drop(pool);
    let workspace_cache_states = refresh_workspace_cache_snapshot(
        &hb.workspace_cache_snapshot,
        hb.workspace_cache.as_ref(),
        hb.profiles,
    )
    .await;
    state.held_session_states =
        filter_current_held_session_states(state.held_session_states, hb.active_reuse_keys, None);
    state.held_workspace_states =
        filter_current_held_workspace_states(workspace_cache_states, hb.active_reuse_keys, None);
    info!(
        mode = ?mode,
        running = state.running_count,
        sessions = state.held_session_states.len(),
        workspace_states = state.held_workspace_states.len(),
        "heartbeat"
    );
    debug!(
        sessions = state.held_session_states.len(),
        workspace_states = state.held_workspace_states.len(),
        "heartbeat held reusable states"
    );
    hb.provider.heartbeat(&state).await;
}

/// Scans the workspace cache and commits the result to the shared snapshot.
///
/// The revision is captured before the asynchronous scan, and no snapshot
/// mutex is held across the await. The returned value is the committed
/// snapshot, which may also contain updates merged from concurrent promotions.
pub(super) async fn refresh_workspace_cache_snapshot(
    snapshot: &WorkspaceCacheStateSnapshot,
    workspace_cache: Option<&WorkspaceImageCache>,
    profiles: &BTreeMap<String, ProfileConfig>,
) -> Vec<HeldWorkspaceState> {
    let refresh = snapshot.begin_workspace_cache_refresh();
    let states = workspace_cache_states(workspace_cache, profiles).await;
    snapshot.finish_workspace_cache_refresh(refresh, states)
}

async fn workspace_cache_states(
    workspace_cache: Option<&WorkspaceImageCache>,
    profiles: &BTreeMap<String, ProfileConfig>,
) -> Vec<HeldWorkspaceState> {
    let Some(cache) = workspace_cache else {
        return Vec::new();
    };

    let profile_image_sizes_bytes = profiles
        .iter()
        .map(|(name, profile)| {
            (
                name.as_str(),
                u64::from(profile.workspace_disk_mb) * 1024 * 1024,
            )
        })
        .collect::<BTreeMap<_, _>>();
    cache
        .held_workspace_states_for_profiles(&profile_image_sizes_bytes)
        .await
}

fn filter_current_held_session_states(
    states: Vec<HeldSessionState>,
    active_reuse_key_registry: &ActiveReuseKeys,
    extra_active_reuse_key: Option<&str>,
) -> Vec<HeldSessionState> {
    let mut active_reuse_keys = active_reuse_keys(active_reuse_key_registry);
    if let Some(reuse_key) = extra_active_reuse_key {
        active_reuse_keys.insert(reuse_key.to_owned());
    }
    let mut states = states
        .into_iter()
        .filter(|state| !active_reuse_keys.contains(&state.reuse_key))
        .collect::<Vec<_>>();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });
    states.truncate(MAX_HELD_SESSION_STATES);
    states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    states
}

fn filter_current_held_workspace_states(
    states: Vec<HeldWorkspaceState>,
    active_reuse_key_registry: &ActiveReuseKeys,
    extra_active_reuse_key: Option<&str>,
) -> Vec<HeldWorkspaceState> {
    let mut active_reuse_keys = active_reuse_keys(active_reuse_key_registry);
    if let Some(reuse_key) = extra_active_reuse_key {
        active_reuse_keys.insert(reuse_key.to_owned());
    }
    let mut states = states
        .into_iter()
        .filter(|state| !active_reuse_keys.contains(&state.reuse_key))
        .collect::<Vec<_>>();
    let observed_workspace_states = states.len();
    let observed_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    states.sort_unstable_by(|a, b| {
        b.last_completed_at
            .cmp(&a.last_completed_at)
            .then_with(|| a.reuse_key.cmp(&b.reuse_key))
    });
    states = cap_held_workspace_states(states);
    let retained_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    if states.len() < observed_workspace_states
        || retained_workspace_caches < observed_workspace_caches
    {
        info!(
            observed_workspace_states,
            retained_workspace_states = states.len(),
            observed_workspace_caches,
            retained_workspace_caches,
            "heartbeat held workspace state truncated"
        );
    }
    states.sort_unstable_by(|a, b| a.reuse_key.cmp(&b.reuse_key));
    states
}

fn merge_held_workspace_state(existing: &mut HeldWorkspaceState, mut incoming: HeldWorkspaceState) {
    if incoming.last_completed_at > existing.last_completed_at {
        existing.last_completed_at = incoming.last_completed_at;
    }
    for incoming_workspace in incoming.workspace_caches.drain(..) {
        match existing
            .workspace_caches
            .iter_mut()
            .find(|workspace| workspace.profile == incoming_workspace.profile)
        {
            Some(existing_workspace)
                if incoming_workspace.workspace_affinity_version
                    >= existing_workspace.workspace_affinity_version =>
            {
                *existing_workspace = incoming_workspace;
            }
            Some(_) => {}
            None => existing.workspace_caches.push(incoming_workspace),
        }
    }
    existing
        .workspace_caches
        .sort_unstable_by(|a, b| a.profile.cmp(&b.profile));
    existing
        .workspace_caches
        .truncate(MAX_WORKSPACE_CACHES_PER_REUSE_KEY);
}

fn merge_workspace_cache_snapshot_states(
    existing_states: Vec<HeldWorkspaceState>,
    refreshed_states: Vec<HeldWorkspaceState>,
) -> Vec<HeldWorkspaceState> {
    let mut by_reuse_key = std::collections::BTreeMap::<String, HeldWorkspaceState>::new();
    for state in refreshed_states.into_iter().chain(existing_states) {
        match by_reuse_key.get_mut(&state.reuse_key) {
            Some(existing) => merge_held_workspace_state(existing, state),
            None => {
                by_reuse_key.insert(state.reuse_key.clone(), state);
            }
        }
    }
    by_reuse_key.into_values().collect()
}

fn cap_workspace_cache_snapshot_states(states: &mut Vec<HeldWorkspaceState>) {
    let observed_workspace_states = states.len();
    let observed_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    *states = cap_held_workspace_states(std::mem::take(states));
    let retained_workspace_caches = states
        .iter()
        .map(|state| state.workspace_caches.len())
        .sum::<usize>();
    if states.len() < observed_workspace_states
        || retained_workspace_caches < observed_workspace_caches
    {
        info!(
            observed_workspace_states,
            retained_workspace_states = states.len(),
            observed_workspace_caches,
            retained_workspace_caches,
            "workspace cache snapshot truncated"
        );
    }
}

fn admittable_profiles_for_heartbeat(
    profiles: &BTreeMap<String, ProfileConfig>,
    budget: &ResourceBudget,
    mode: RunnerMode,
) -> Vec<String> {
    if mode != RunnerMode::Running {
        return Vec::new();
    }

    profiles
        .iter()
        .filter(|(_, profile)| budget.can_afford(profile.vcpu, profile.memory_mb))
        .map(|(name, _)| name.clone())
        .collect()
}

/// Collect current runner state for heartbeat reporting.
pub(super) struct HeartbeatSnapshotMetadata<'a> {
    pub(super) runner_id: &'a str,
    pub(super) runner_name: &'a str,
    pub(super) group: &'a str,
    pub(super) generation: u64,
    pub(super) sequence: u64,
}

pub(super) fn collect_heartbeat_state(
    snapshot: HeartbeatSnapshotMetadata<'_>,
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
    let admittable_profiles = admittable_profiles_for_heartbeat(profiles, budget, mode);
    HeartbeatState {
        runner_id: snapshot.runner_id.to_string(),
        runner_name: snapshot.runner_name.to_string(),
        group: snapshot.group.to_string(),
        snapshot_generation: snapshot.generation,
        snapshot_sequence: snapshot.sequence,
        total_vcpu: budget.effective_vcpu(),
        total_memory_mb: budget.effective_memory_mb(),
        max_concurrent: budget.max_concurrent(),
        allocated_vcpu,
        allocated_memory_mb,
        running_count,
        admittable_profiles,
        held_session_states: idle_pool.held_session_states(),
        held_workspace_states: Vec::new(),
        mode: match mode {
            RunnerMode::Starting => "starting".to_string(),
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
        IdlePoolConfig, ParkResult, ParkedIdleCandidate, test_support::ParkedIdleCandidateBuilder,
    };
    use crate::paths::RunnerPaths;
    use crate::provider::mock::MockJobProvider;
    use crate::types::{MAX_HELD_WORKSPACE_STATES, ReusableSandboxState, WorkspaceCacheCapability};
    use crate::workspace_image_cache::{
        WorkspaceCacheTerminalStatus, WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
    };
    use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
    use sandbox::SandboxId;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

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
                workspace_disk_mb: 1,
            },
        );
        m
    }

    fn test_snapshot_metadata() -> HeartbeatSnapshotMetadata<'static> {
        HeartbeatSnapshotMetadata {
            runner_id: "r1",
            runner_name: "runner-1",
            group: "vm0/test",
            generation: 7,
            sequence: 42,
        }
    }

    fn make_synthetic_parked_candidate(session_id: &str) -> ParkedIdleCandidate {
        let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
        ParkedIdleCandidateBuilder::new(
            session_id,
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        )
        .with_mock_sandbox_name("test")
        .build()
    }

    fn refresh_snapshot(snapshot: &WorkspaceCacheStateSnapshot, states: Vec<HeldWorkspaceState>) {
        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.finish_workspace_cache_refresh(refresh, states);
    }

    fn workspace_cache(profile: &str) -> WorkspaceCacheCapability {
        WorkspaceCacheCapability {
            profile: profile.to_owned(),
            workspace_affinity_version: crate::types::WORKSPACE_AFFINITY_VERSION,
        }
    }

    fn held_workspace_state(
        reuse_key: &str,
        last_completed_at: &str,
        profiles: &[&str],
    ) -> HeldWorkspaceState {
        HeldWorkspaceState {
            reuse_key: reuse_key.to_owned(),
            last_completed_at: last_completed_at.to_owned(),
            workspace_caches: profiles
                .iter()
                .map(|profile| workspace_cache(profile))
                .collect(),
        }
    }

    async fn seed_workspace_cache_state(
        cache: &WorkspaceImageCache,
        paths: &RunnerPaths,
        reuse_key: &str,
        completed_at: &str,
    ) {
        let run_id = crate::ids::RunId::new_v4();
        let sandbox_id = SandboxId::new_v4();
        let lease = cache
            .prepare(WorkspaceImagePrepareRequest {
                identity: WorkspaceImageLeaseIdentity {
                    run_id,
                    sandbox_id,
                    profile_name: "vm0/default",
                    reuse_key: Some(reuse_key),
                    working_dir: CANONICAL_WORKING_DIR,
                    image_size_bytes: 1024 * 1024,
                },
                workspace_drive_required: true,
            })
            .await;
        let active_image = paths.active_workspace_image(&sandbox_id);
        tokio::fs::create_dir_all(active_image.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::File::create(&active_image)
            .await
            .unwrap()
            .set_len(1024 * 1024)
            .await
            .unwrap();
        assert!(
            lease
                .promote(
                    run_id,
                    WorkspaceCacheTerminalStatus::Success,
                    completed_at.into(),
                    &crate::storage_fingerprints::StorageFingerprints::default(),
                )
                .await
                .unwrap()
        );
    }

    async fn capture_heartbeat_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let guard = tracing::subscriber::set_default(subscriber);
        tracing::callsite::rebuild_interest_cache();
        let output = future.await;
        drop(guard);
        (output, captured.entries())
    }

    fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
        events
            .iter()
            .find(|event| {
                event
                    .fields
                    .get("message")
                    .is_some_and(|actual| actual == message)
            })
            .unwrap_or_else(|| panic!("missing event {message:?}; captured={events:#?}"))
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
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 2);
    }

    #[test]
    fn heartbeat_admittable_profiles_match_current_budget() {
        let budget = Arc::new(ResourceBudget::new(4, 8192, 1.0, 2));
        let _lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
        let mut profiles = test_profiles();
        profiles.insert(
            "vm0/large".to_string(),
            config::ProfileConfig {
                rootfs_hash: "hash".into(),
                snapshot_hash: "snap".into(),
                vcpu: 4,
                memory_mb: 8192,
                rootfs_disk_mb: 8192,
                workspace_disk_mb: 10240,
            },
        );
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );

        assert_eq!(state.admittable_profiles, vec!["vm0/default"]);
    }

    #[test]
    fn heartbeat_admittable_profiles_exclude_unaffordable_parked_profiles() {
        let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 1));
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let candidate = ParkedIdleCandidateBuilder::new(
            "sess-idle",
            ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap(),
        )
        .with_last_completed_at("2026-06-01T00:00:00.000Z")
        .build();
        assert!(matches!(pool.park(candidate), ParkResult::Parked));
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );

        assert!(state.admittable_profiles.is_empty());
    }

    #[test]
    fn heartbeat_admittable_profiles_empty_when_not_running() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Draining,
        );

        assert!(state.admittable_profiles.is_empty());
    }

    #[test]
    fn heartbeat_starting_reports_no_admittable_profiles() {
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let pool = IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 0,
        });
        let profiles = test_profiles();

        let state = collect_heartbeat_state(
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Starting,
        );

        assert_eq!(state.mode, "starting");
        assert!(state.admittable_profiles.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_heartbeat_logs_state_counts_without_raw_reuse_state() {
        let reuse_key = "thread:sensitive-heartbeat-17975";
        let idle_pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            default_timeout: Duration::from_secs(300),
            max_idle: 1,
        })));
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        seed_workspace_cache_state(&cache, &paths, reuse_key, "2026-06-01T00:00:00.000Z").await;
        let profiles = test_profiles();
        let budget = ResourceBudget::new(8, 32768, 1.0, 4);
        let active_reuse_keys = super::super::active_reuse_keys::new_active_reuse_keys();
        let (provider, _) = MockJobProvider::new(tokio_util::sync::CancellationToken::new());
        let workspace_cache_snapshot = WorkspaceCacheStateSnapshot::new();
        let hb = HeartbeatContext::new(HeartbeatContextInit {
            idle_pool: &idle_pool,
            runner_id: "runner-1",
            name: "test-runner",
            group: "vm0/test",
            snapshot_generation: 7,
            profiles: &profiles,
            budget: &budget,
            provider: provider.as_ref(),
            workspace_cache: Some(cache),
            active_reuse_keys: &active_reuse_keys,
            workspace_cache_snapshot: workspace_cache_snapshot.clone(),
        });

        let ((), events) =
            capture_heartbeat_events(send_heartbeat(&hb, RunnerMode::Running, 42)).await;

        let debug_event = captured_event(&events, "heartbeat held reusable states");
        assert_eq!(
            debug_event.fields.get("sessions").map(String::as_str),
            Some("0")
        );
        assert_eq!(
            debug_event
                .fields
                .get("workspace_states")
                .map(String::as_str),
            Some("1")
        );
        for event in &events {
            for (field, value) in &event.fields {
                assert!(
                    !value.contains(reuse_key),
                    "captured field {field} leaked raw reuse key {reuse_key:?}: {event:#?}"
                );
            }
        }
        let cached_states =
            workspace_cache_snapshot.current_held_workspace_states(&active_reuse_keys, None);
        assert_eq!(cached_states.len(), 1);
        assert_eq!(cached_states[0].reuse_key, reuse_key);
        assert_eq!(
            cached_states[0].workspace_caches,
            vec![workspace_cache("vm0/default")]
        );
    }

    #[tokio::test]
    async fn workspace_cache_states_filter_claimed_reuse_key() {
        let dir = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(dir.path().join("runner"));
        tokio::fs::create_dir_all(paths.base_dir()).await.unwrap();
        let cache = WorkspaceImageCache::new(paths.clone());
        seed_workspace_cache_state(&cache, &paths, "sess-cache", "2026-06-01T00:00:00.000Z").await;
        seed_workspace_cache_state(&cache, &paths, "sess-claimed", "2026-06-01T00:00:01.000Z")
            .await;
        let active_reuse_keys = super::super::active_reuse_keys::new_active_reuse_keys();
        let profiles = test_profiles();
        let cache_states = workspace_cache_states(Some(&cache), &profiles).await;
        let states = filter_current_held_workspace_states(
            cache_states,
            &active_reuse_keys,
            Some("sess-claimed"),
        );

        assert!(
            states.iter().any(|state| state.reuse_key == "sess-cache"),
            "unrelated workspace cache should remain advertised"
        );
        assert!(
            !states.iter().any(|state| state.reuse_key == "sess-claimed"),
            "currently claimed reuse key should be filtered until the run finishes"
        );
    }

    #[tokio::test]
    async fn workspace_cache_snapshot_filters_active_reuse_keys() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        refresh_snapshot(
            &snapshot,
            vec![
                held_workspace_state("sess-cache", "2026-06-01T00:00:02.000Z", &["vm0/default"]),
                held_workspace_state("sess-claimed", "2026-06-01T00:00:03.000Z", &["vm0/default"]),
                held_workspace_state("sess-active", "2026-06-01T00:00:04.000Z", &["vm0/default"]),
            ],
        );
        let active_reuse_keys = super::super::active_reuse_keys::new_active_reuse_keys();
        super::super::active_reuse_keys::insert_active_reuse_key(&active_reuse_keys, "sess-active");
        let states =
            snapshot.current_held_workspace_states(&active_reuse_keys, Some("sess-claimed"));

        assert_eq!(
            states,
            vec![held_workspace_state(
                "sess-cache",
                "2026-06-01T00:00:02.000Z",
                &["vm0/default"],
            )]
        );
    }

    #[test]
    fn workspace_cache_snapshot_treats_unloaded_cache_as_unknown() {
        let snapshot = WorkspaceCacheStateSnapshot::new();

        assert!(
            !snapshot.workspace_cache_loaded(),
            "new snapshot should start with unknown workspace-cache state"
        );
        assert!(
            snapshot.might_contain_workspace_cache_reuse_key("sess-cache"),
            "unloaded snapshot should trigger one refresh for cache-enabled runners"
        );

        refresh_snapshot(&snapshot, Vec::new());
        assert!(
            snapshot.workspace_cache_loaded(),
            "refresh should mark workspace-cache state loaded even when empty"
        );
        assert!(
            !snapshot.might_contain_workspace_cache_reuse_key("sess-cache"),
            "loaded empty snapshot should not keep triggering cache refreshes"
        );

        refresh_snapshot(
            &snapshot,
            vec![held_workspace_state(
                "sess-cache",
                "2026-06-01T00:00:02.000Z",
                &["vm0/default"],
            )],
        );
        assert!(
            snapshot.might_contain_workspace_cache_reuse_key("sess-cache"),
            "loaded matching snapshot should trigger refresh when that reuse key is claimed"
        );
    }

    #[test]
    fn workspace_cache_snapshot_upsert_caps_states() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        for index in 0..=MAX_HELD_WORKSPACE_STATES {
            snapshot.upsert_workspace_cache_state(HeldWorkspaceState {
                reuse_key: format!("sess-{index:04}"),
                last_completed_at: timestamp_for_index(index),
                workspace_caches: vec![workspace_cache("vm0/default")],
            });
        }

        let active_reuse_keys = super::super::active_reuse_keys::new_active_reuse_keys();
        let states = snapshot.current_held_workspace_states(&active_reuse_keys, None);

        assert_eq!(states.len(), MAX_HELD_WORKSPACE_STATES);
        assert!(
            !states.iter().any(|state| state.reuse_key == "sess-0000"),
            "oldest upserted workspace-cache state should be dropped at the cap"
        );
        assert!(
            states
                .iter()
                .any(|state| state.reuse_key == format!("sess-{MAX_HELD_WORKSPACE_STATES:04}")),
            "newest upserted workspace-cache state should be retained at the cap"
        );
    }

    #[test]
    fn workspace_cache_snapshot_refresh_preserves_concurrent_upsert() {
        let snapshot = WorkspaceCacheStateSnapshot::new();
        let original =
            held_workspace_state("sess-shared", "2026-06-01T00:00:01.000Z", &["vm0/default"]);
        let promoted =
            held_workspace_state("sess-shared", "2026-06-01T00:00:02.000Z", &["vm0/large"]);
        refresh_snapshot(&snapshot, vec![original.clone()]);

        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.upsert_workspace_cache_state(promoted.clone());
        let refreshed = snapshot.finish_workspace_cache_refresh(refresh, vec![original.clone()]);
        let merged = held_workspace_state(
            "sess-shared",
            "2026-06-01T00:00:02.000Z",
            &["vm0/default", "vm0/large"],
        );
        assert_eq!(refreshed, vec![merged.clone()]);

        let active_reuse_keys = super::super::active_reuse_keys::new_active_reuse_keys();
        let states = snapshot.current_held_workspace_states(&active_reuse_keys, None);
        assert_eq!(states, vec![merged]);

        let refresh = snapshot.begin_workspace_cache_refresh();
        snapshot.finish_workspace_cache_refresh(refresh, vec![original.clone()]);

        let states = snapshot.current_held_workspace_states(&active_reuse_keys, None);
        assert_eq!(states, vec![original]);
    }

    fn timestamp_for_index(index: usize) -> String {
        format!("2026-06-01T00:{:02}:{:02}.000Z", index / 60, index % 60)
    }

    #[test]
    fn held_session_states_filter_active_reuse_keys() {
        let active_reuse_keys = super::super::active_reuse_keys::new_active_reuse_keys();
        super::super::active_reuse_keys::insert_active_reuse_key(
            &active_reuse_keys,
            "thread-active",
        );
        let states = vec![
            HeldSessionState {
                session_id: "provider-session-active".into(),
                reuse_key: "thread-active".into(),
                last_completed_at: "2026-06-01T00:00:01.000Z".into(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".into(),
                    history_generation_run_id: None,
                },
            },
            HeldSessionState {
                session_id: "provider-session-held".into(),
                reuse_key: "thread-held".into(),
                last_completed_at: "2026-06-01T00:00:02.000Z".into(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".into(),
                    history_generation_run_id: None,
                },
            },
        ];

        let filtered =
            filter_current_held_session_states(states, &active_reuse_keys, Some("thread-claimed"));

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].session_id, "provider-session-held");
    }

    #[test]
    fn merge_held_workspace_state_keeps_newest_timestamp_and_merges_profiles() {
        let mut existing =
            held_workspace_state("thread-1", "2026-06-01T00:00:02.000Z", &["vm0/default"]);
        let incoming = held_workspace_state(
            "thread-1",
            "2026-06-01T00:00:01.000Z",
            &["vm0/default", "vm0/large"],
        );

        merge_held_workspace_state(&mut existing, incoming);

        assert_eq!(existing.last_completed_at, "2026-06-01T00:00:02.000Z");
        assert_eq!(
            existing.workspace_caches,
            vec![workspace_cache("vm0/default"), workspace_cache("vm0/large")]
        );
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
            test_snapshot_metadata(),
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
            test_snapshot_metadata(),
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
            test_snapshot_metadata(),
            &profiles,
            &budget,
            &pool,
            RunnerMode::Running,
        );
        assert_eq!(state.running_count, 0);
    }
}
