//! Connector runtime synchronization for active API-backed runs.
//!
//! Tagged builtin and custom connector targets share one scheduler, bounded
//! queue, generation model, retry policy, and registry publication boundary.
//! Realtime notifications advance a target generation and schedule immediate
//! work; API deadlines and retries continue the generation they belong to.
//! Nearby due targets for one run are coalesced and split to the shared API
//! contract limit. Untagged execution contexts continue through the legacy
//! builtin network-policy endpoint during rolling deployment.
//!
//! A tagged sync response must contain each requested target exactly
//! once. Available builtin results patch only their existing network policy;
//! available custom results atomically replace their firewall and policy.
//! Authoritative custom absence removes both while builtin unresolved results
//! retain last-known-good state and retry. Transport, validation, queue, and
//! registry publication failures also retain last-known-good state and install
//! a capped, jittered retry. Older queued or in-flight work cannot clear a newer
//! realtime trigger.
//!
//! A typed terminal-run response removes the entire run from tracking, cancels
//! scheduled work, and fail-closes every still-matching target. Registry writes
//! always re-check source IP and run id so stale work cannot patch a later run
//! that reused the same source IP. A first transport failure is retried once
//! before entering the scheduled retry path.
//!
//! Unregister and shutdown remove active run state, cancel per-run tokens, and
//! abort scheduled task handles. Dropping the worker cancels the global token
//! and aborts the worker task, preventing orphaned scheduled tasks from
//! enqueueing stale registry refreshes.
//!
use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use api_contracts::generated::constants::runners::{
    CONNECTOR_RUNTIME_SYNC_TARGETS_MAX, NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX,
};
use chrono::{DateTime, Utc};
use tokio::sync::{
    Mutex, mpsc,
    mpsc::error::{TrySendError, TrySendError::Closed, TrySendError::Full},
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::api::{ApiClient, ConnectorRuntimeSyncOutcome, NetworkPolicyRefreshOutcome};
use crate::error::RunnerError;
use crate::ids::RunId;
use crate::proxy::{CustomConnectorRuntimeRegistryState, ProxyRegistryHandle};
use crate::types::{
    ConnectorRuntimeSyncBatchResponse, ConnectorRuntimeSyncState, ConnectorRuntimeTarget,
    ConnectorRuntimeTargetRegistration, ConnectorRuntimeUnresolvedReason, FirewallEntry,
    NetworkPolicy, NetworkPolicyRefresh,
};

const REFRESH_REQUEST_QUEUE_CAPACITY: usize = 256;
const NETWORK_POLICY_REFRESH_BATCH_MAX: usize = NETWORK_POLICY_REFRESH_CONNECTOR_SLUGS_MAX as usize;
const CONNECTOR_RUNTIME_SYNC_BATCH_MAX: usize = CONNECTOR_RUNTIME_SYNC_TARGETS_MAX as usize;
const EXPIRED_REFRESH_DEADLINE_RETRY_DELAY: Duration = Duration::from_millis(250);
const SCHEDULED_REFRESH_COALESCE_WINDOW: Duration = Duration::from_millis(100);
const REFRESH_RETRY_INITIAL_DELAY: Duration = Duration::from_secs(1);
const REFRESH_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
const REFRESH_RETRY_JITTER_MIN_PER_MILLE: u64 = 800;
const REFRESH_RETRY_JITTER_SPAN_PER_MILLE: u64 = 201;

#[derive(Clone)]
pub(crate) struct NetworkPolicyRefreshHandle {
    core: NetworkPolicyRefreshCore,
    worker: Arc<NetworkPolicyRefreshWorker>,
}

struct NetworkPolicyRefreshWorker {
    core: NetworkPolicyRefreshCore,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
struct NetworkPolicyRefreshCore {
    inner: Arc<NetworkPolicyRefreshState>,
    request_tx: mpsc::Sender<RefreshRequest>,
}

struct NetworkPolicyRefreshState {
    api: ApiClient,
    active_runs: Mutex<HashMap<RunId, ActiveRunNetworkPolicyState>>,
    cancel: CancellationToken,
}

struct ActiveRunNetworkPolicyState {
    source_ip: String,
    registry: ProxyRegistryHandle,
    connectors: HashMap<ConnectorRuntimeTarget, ActiveConnectorRefreshState>,
    tagged: bool,
    cancel: CancellationToken,
    refresh_tasks: HashMap<ConnectorRuntimeTarget, ScheduledRefreshTask>,
    next_refresh_task_id: u64,
}

struct ActiveConnectorRefreshState {
    generation: u64,
    consecutive_failures: u32,
    // Custom-only routing inputs pinned for this run. They are not target identity.
    pinned_base_url_vars: Option<HashMap<String, String>>,
}

struct ScheduledRefreshTask {
    id: u64,
    generation: u64,
    deadline: tokio::time::Instant,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct ActiveRunNetworkPolicySnapshot {
    source_ip: String,
    registry: ProxyRegistryHandle,
}

pub(crate) struct NetworkPolicyRefreshRegistration<'a> {
    pub(crate) run_id: RunId,
    pub(crate) source_ip: &'a str,
    pub(crate) registry: ProxyRegistryHandle,
    pub(crate) connector_slugs: HashSet<String>,
    pub(crate) targets: Option<&'a [ConnectorRuntimeTargetRegistration]>,
    pub(crate) refreshes: Option<&'a HashMap<String, NetworkPolicyRefresh>>,
}

struct RefreshRequest {
    run_id: RunId,
    targets: Vec<ConnectorRefreshTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConnectorRefreshTarget {
    target: ConnectorRuntimeTarget,
    generation: u64,
}

impl NetworkPolicyRefreshHandle {
    pub(super) fn new(api: ApiClient) -> Self {
        let (request_tx, request_rx) = mpsc::channel(REFRESH_REQUEST_QUEUE_CAPACITY);
        let core = NetworkPolicyRefreshCore {
            inner: Arc::new(NetworkPolicyRefreshState {
                api,
                active_runs: Mutex::new(HashMap::new()),
                cancel: CancellationToken::new(),
            }),
            request_tx,
        };
        let worker_task = tokio::spawn(run_refresh_worker(core.clone(), request_rx));
        Self {
            core: core.clone(),
            worker: Arc::new(NetworkPolicyRefreshWorker {
                core,
                task: StdMutex::new(Some(worker_task)),
            }),
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.core.shutdown_active_runs().await;
        let worker_task = self.take_worker_task();
        if let Some(worker_task) = worker_task
            && let Err(error) = worker_task.await
        {
            warn!(error = %error, "network policy refresh worker failed during shutdown");
        }
    }

    pub(crate) async fn register_run(&self, registration: NetworkPolicyRefreshRegistration<'_>) {
        self.core.register_run(registration).await;
    }

    pub(crate) async fn unregister_run(&self, run_id: RunId) {
        self.core.unregister_run(run_id).await;
    }

    pub(crate) async fn notify_network_policy_refresh(
        &self,
        run_id: RunId,
        connector_slug: String,
    ) {
        self.core
            .notify_connector_runtime_sync(
                run_id,
                ConnectorRuntimeTarget::Builtin { connector_slug },
            )
            .await;
    }

    pub(crate) async fn notify_network_policy_refresh_until_cancelled(
        &self,
        run_id: RunId,
        connector_slug: String,
        cancel: &CancellationToken,
    ) {
        self.core
            .notify_connector_runtime_sync_until_cancelled(
                run_id,
                ConnectorRuntimeTarget::Builtin { connector_slug },
                cancel,
            )
            .await;
    }

    pub(crate) async fn notify_connector_runtime_sync(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
    ) {
        self.core
            .notify_connector_runtime_sync(run_id, target)
            .await;
    }

    pub(crate) async fn notify_connector_runtime_sync_until_cancelled(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: &CancellationToken,
    ) {
        self.core
            .notify_connector_runtime_sync_until_cancelled(run_id, target, cancel)
            .await;
    }

    fn take_worker_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.worker.take_task()
    }
}

impl NetworkPolicyRefreshWorker {
    fn take_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for NetworkPolicyRefreshWorker {
    fn drop(&mut self) {
        self.core.inner.cancel.cancel();
        if let Some(worker_task) = self.take_task() {
            worker_task.abort();
        }
    }
}

impl NetworkPolicyRefreshCore {
    async fn shutdown_active_runs(&self) {
        self.inner.cancel.cancel();
        let old_runs = std::mem::take(&mut *self.inner.active_runs.lock().await);
        for old in old_runs.into_values() {
            old.cancel.cancel();
            abort_tasks(old.refresh_tasks.into_values().map(|task| task.handle));
        }
    }

    async fn register_run(&self, registration: NetworkPolicyRefreshRegistration<'_>) {
        if self.inner.cancel.is_cancelled() {
            return;
        }
        let tagged = registration.targets.is_some();
        let runtime_targets = match registration.targets {
            Some(targets) => targets.to_vec(),
            None => registration
                .connector_slugs
                .iter()
                .cloned()
                .map(
                    |connector_slug| ConnectorRuntimeTargetRegistration::Builtin { connector_slug },
                )
                .collect(),
        };
        if runtime_targets.is_empty() {
            self.unregister_run(registration.run_id).await;
            return;
        }
        let run_cancel = CancellationToken::new();
        let mut old_tasks = Vec::new();
        {
            let mut active_runs = self.inner.active_runs.lock().await;
            if self.inner.cancel.is_cancelled() {
                return;
            }
            if let Some(old) = active_runs.remove(&registration.run_id) {
                old.cancel.cancel();
                old_tasks.extend(old.refresh_tasks.into_values().map(|task| task.handle));
            }

            let connectors = runtime_targets
                .iter()
                .map(|registration| {
                    (
                        registration.target(),
                        ActiveConnectorRefreshState {
                            generation: 0,
                            consecutive_failures: 0,
                            pinned_base_url_vars: registration.custom_base_url_vars().cloned(),
                        },
                    )
                })
                .collect();
            active_runs.insert(
                registration.run_id,
                ActiveRunNetworkPolicyState {
                    source_ip: registration.source_ip.to_string(),
                    registry: registration.registry,
                    connectors,
                    tagged,
                    cancel: run_cancel.clone(),
                    refresh_tasks: HashMap::new(),
                    next_refresh_task_id: 0,
                },
            );
        }
        abort_tasks(old_tasks);

        if tagged {
            for target in runtime_targets
                .iter()
                .map(ConnectorRuntimeTargetRegistration::target)
                .filter(|target| matches!(target, ConnectorRuntimeTarget::Custom { .. }))
            {
                self.replace_schedule_deadline_if_current(
                    registration.run_id,
                    &ConnectorRefreshTarget {
                        target,
                        generation: 0,
                    },
                    Some(tokio::time::Instant::now()),
                )
                .await;
            }
        }

        if let Some(refreshes) = registration.refreshes {
            let mut invalid_targets = Vec::new();
            for (connector_slug, refresh) in refreshes {
                let target = ConnectorRefreshTarget {
                    target: ConnectorRuntimeTarget::Builtin {
                        connector_slug: connector_slug.clone(),
                    },
                    generation: 0,
                };
                match parse_refresh_deadline(&refresh.next_refresh_at) {
                    Ok(deadline) => {
                        self.replace_schedule_deadline_if_current(
                            registration.run_id,
                            &target,
                            Some(deadline),
                        )
                        .await;
                    }
                    Err(()) => invalid_targets.push(target),
                }
            }
            self.schedule_refresh_retries(
                registration.run_id,
                &invalid_targets,
                "invalid_initial_deadline",
            )
            .await;
        }
    }

    async fn unregister_run(&self, run_id: RunId) {
        let _ = self.take_active_run(run_id).await;
    }

    async fn take_active_run(&self, run_id: RunId) -> Option<ActiveRunNetworkPolicyState> {
        let mut old = self.inner.active_runs.lock().await.remove(&run_id)?;
        old.cancel.cancel();
        abort_tasks(
            std::mem::take(&mut old.refresh_tasks)
                .into_values()
                .map(|task| task.handle),
        );
        Some(old)
    }

    #[cfg(test)]
    async fn notify_network_policy_refresh(&self, run_id: RunId, connector_slug: String) {
        self.notify_connector_runtime_sync(
            run_id,
            ConnectorRuntimeTarget::Builtin { connector_slug },
        )
        .await;
    }

    #[cfg(test)]
    async fn notify_network_policy_refresh_until_cancelled(
        &self,
        run_id: RunId,
        connector_slug: String,
        cancel: &CancellationToken,
    ) {
        self.notify_connector_runtime_sync_until_cancelled(
            run_id,
            ConnectorRuntimeTarget::Builtin { connector_slug },
            cancel,
        )
        .await;
    }

    async fn notify_connector_runtime_sync(&self, run_id: RunId, target: ConnectorRuntimeTarget) {
        self.notify_connector_runtime_sync_inner(run_id, target, None)
            .await;
    }

    async fn notify_connector_runtime_sync_until_cancelled(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: &CancellationToken,
    ) {
        self.notify_connector_runtime_sync_inner(run_id, target, Some(cancel))
            .await;
    }

    async fn notify_connector_runtime_sync_inner(
        &self,
        run_id: RunId,
        target: ConnectorRuntimeTarget,
        cancel: Option<&CancellationToken>,
    ) {
        if self.inner.cancel.is_cancelled() || cancel.is_some_and(CancellationToken::is_cancelled) {
            return;
        }
        let mut active_runs = self.inner.active_runs.lock().await;
        if self.inner.cancel.is_cancelled() || cancel.is_some_and(CancellationToken::is_cancelled) {
            return;
        }
        let Some(active) = active_runs.get_mut(&run_id) else {
            return;
        };
        if active.cancel.is_cancelled() {
            return;
        }
        let Some(connector) = active.connectors.get_mut(&target) else {
            return;
        };
        connector.generation += 1;
        let target = ConnectorRefreshTarget {
            target,
            generation: connector.generation,
        };
        self.replace_schedule_locked(active, run_id, &target, Some(tokio::time::Instant::now()));
    }

    async fn enqueue_scheduled_refresh(&self, request: RefreshRequest, cancel: &CancellationToken) {
        if self.inner.cancel.is_cancelled() || cancel.is_cancelled() {
            return;
        }

        if let Err(error) = self.request_tx.try_send(request) {
            self.handle_scheduled_enqueue_error(error).await;
        }
    }

    async fn handle_scheduled_enqueue_error(&self, error: TrySendError<RefreshRequest>) {
        match error {
            Full(request) => {
                let connector_slugs = target_connector_slugs(&request.targets);
                warn!(
                    run_id = %request.run_id,
                    connector_count = request.targets.len(),
                    connector_slugs = ?connector_slugs,
                    "network policy refresh queue full; retaining last-known-good network policies"
                );
                self.schedule_refresh_retries(request.run_id, &request.targets, "queue_full")
                    .await;
            }
            Closed(error) => {
                let connector_slugs = target_connector_slugs(&error.targets);
                warn!(
                    run_id = %error.run_id,
                    connector_count = error.targets.len(),
                    connector_slugs = ?connector_slugs,
                    "network policy refresh queue closed"
                );
            }
        }
    }

    #[cfg(test)]
    async fn refresh_network_policies_now(&self, run_id: RunId, connector_slugs: Vec<String>) {
        let targets = self.current_refresh_targets(run_id, connector_slugs).await;
        self.refresh_network_policy_targets_now(run_id, targets)
            .await;
    }

    async fn refresh_network_policy_targets_now(
        &self,
        run_id: RunId,
        targets: Vec<ConnectorRefreshTarget>,
    ) {
        let active_targets = self.active_refresh_targets(run_id, targets).await;
        if active_targets.is_empty() {
            return;
        }

        let batch_max = if self.run_is_tagged(run_id).await {
            CONNECTOR_RUNTIME_SYNC_BATCH_MAX
        } else {
            NETWORK_POLICY_REFRESH_BATCH_MAX
        };
        for targets in active_targets.chunks(batch_max) {
            let current_targets = self.active_refresh_targets(run_id, targets.to_vec()).await;
            if current_targets.is_empty() {
                continue;
            }
            if !self
                .refresh_network_policy_batch_now(run_id, &current_targets)
                .await
            {
                return;
            }
        }
    }

    async fn refresh_network_policy_batch_now(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorRefreshTarget],
    ) -> bool {
        if self.run_is_tagged(run_id).await {
            return self
                .sync_connector_runtime_batch_now(run_id, active_targets)
                .await;
        }
        self.refresh_legacy_network_policy_batch_now(run_id, active_targets)
            .await
    }

    async fn refresh_legacy_network_policy_batch_now(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorRefreshTarget],
    ) -> bool {
        let active_connector_slugs = active_targets
            .iter()
            .filter_map(|target| {
                target
                    .target
                    .builtin_connector_slug()
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();
        if active_connector_slugs.len() != active_targets.len() {
            self.schedule_refresh_retries(run_id, active_targets, "legacy_custom_target")
                .await;
            return true;
        }
        let mut transport_retry_attempted = false;
        let response = loop {
            let response = self
                .inner
                .api
                .refresh_network_policies(run_id, &active_connector_slugs)
                .await;
            if !transport_retry_attempted && let Err(RunnerError::ApiTransport(error)) = &response {
                transport_retry_attempted = true;
                let request = &error.request;
                warn!(
                    run_id = %run_id,
                    connector_count = active_connector_slugs.len(),
                    connector_slugs = ?active_connector_slugs,
                    error = %error,
                    endpoint = request.endpoint_label,
                    method = %request.method,
                    host = %request.host,
                    path = %request.path,
                    client_request_id = %request.client_request_id,
                    client_session_id = %request.client_session_id,
                    client_version = %request.client_version,
                    failure_kind = error.failure_kind.as_str(),
                    error_summary = %error.summary,
                    attempt = 1,
                    max_attempts = 2,
                    will_retry = true,
                    "network policy refresh transport failed, retrying"
                );
                continue;
            }
            break response;
        };
        let response = match response {
            Ok(NetworkPolicyRefreshOutcome::Refreshed(response)) => response,
            Ok(NetworkPolicyRefreshOutcome::RunTerminal) => {
                self.reconcile_terminal_run(run_id).await;
                return false;
            }
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    connector_count = active_connector_slugs.len(),
                    connector_slugs = ?active_connector_slugs,
                    error = %error,
                    transport_retry_attempted,
                    "network policy refresh failed; retaining last-known-good network policies"
                );
                self.schedule_refresh_retries(run_id, active_targets, "api_error")
                    .await;
                return true;
            }
        };

        let requested_connector_slugs: HashSet<String> =
            active_connector_slugs.iter().cloned().collect();
        let mut responses_by_connector = HashMap::new();
        let mut duplicate_connector_slugs = HashSet::new();
        for refresh in response.refreshes {
            let response_connector_slug = refresh.connector_slug.clone();
            if !requested_connector_slugs.contains(response_connector_slug.as_str()) {
                warn!(
                    run_id = %run_id,
                    response_connector_slug = response_connector_slug,
                    requested_connector_slugs = ?active_connector_slugs,
                    "network policy refresh returned unexpected connector"
                );
                continue;
            }
            if responses_by_connector
                .insert(response_connector_slug.clone(), refresh)
                .is_some()
            {
                warn!(
                    run_id = %run_id,
                    connector_slug = response_connector_slug,
                    "network policy refresh returned duplicate connector"
                );
                duplicate_connector_slugs.insert(response_connector_slug);
            }
        }

        let mut retry_targets = Vec::new();
        for target in active_targets {
            let Some(connector_slug) = target.target.builtin_connector_slug() else {
                retry_targets.push(target.clone());
                continue;
            };
            if duplicate_connector_slugs.contains(connector_slug) {
                retry_targets.push(target.clone());
                continue;
            }
            let Some(response) = responses_by_connector.remove(connector_slug) else {
                warn!(
                    run_id = %run_id,
                    connector_slug = connector_slug,
                    "network policy refresh response omitted requested connector"
                );
                retry_targets.push(target.clone());
                continue;
            };

            let deadline =
                match parse_optional_refresh_deadline(response.next_refresh_at.as_deref()) {
                    Ok(deadline) => deadline,
                    Err(()) => {
                        retry_targets.push(target.clone());
                        continue;
                    }
                };
            let Some(snapshot) = self.active_snapshot_for_target(run_id, target).await else {
                continue;
            };
            match patch_network_policy(run_id, connector_slug, snapshot, response.network_policy)
                .await
            {
                Ok(true) => {
                    if self
                        .complete_successful_refresh(run_id, target, deadline, None)
                        .await
                    {
                        info!(
                            run_id = %run_id,
                            connector_slug = connector_slug,
                            generation = target.generation,
                            "refreshed network policy"
                        );
                    } else {
                        info!(
                            run_id = %run_id,
                            connector_slug = connector_slug,
                            generation = target.generation,
                            "published superseded network policy refresh; newer reconciliation remains pending"
                        );
                    }
                }
                Ok(false) => {
                    self.unregister_run(run_id).await;
                    return false;
                }
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        connector_slug = connector_slug,
                        error = %error,
                        "failed to patch refreshed network policy; retaining last-known-good policy"
                    );
                    retry_targets.push(target.clone());
                }
            }
        }
        self.schedule_refresh_retries(run_id, &retry_targets, "invalid_or_unpublished_response")
            .await;
        true
    }

    async fn sync_connector_runtime_batch_now(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorRefreshTarget],
    ) -> bool {
        let current_targets = self
            .current_connector_runtime_sync_targets(run_id, active_targets)
            .await;
        if current_targets.is_empty() {
            return true;
        }
        let (active_targets, requested_targets): (Vec<_>, Vec<_>) =
            current_targets.into_iter().unzip();
        let mut transport_retry_attempted = false;
        let response = loop {
            let response = self
                .inner
                .api
                .sync_connector_runtime(run_id, &requested_targets)
                .await;
            if !transport_retry_attempted && let Err(RunnerError::ApiTransport(error)) = &response {
                transport_retry_attempted = true;
                warn!(
                    run_id = %run_id,
                    targets = ?target_identities(&active_targets),
                    error = %error,
                    attempt = 1,
                    max_attempts = 2,
                    will_retry = true,
                    "connector runtime sync transport failed, retrying"
                );
                continue;
            }
            break response;
        };

        let response = match response {
            Ok(ConnectorRuntimeSyncOutcome::Synced(response)) => response,
            Ok(ConnectorRuntimeSyncOutcome::RunTerminal) => {
                self.reconcile_terminal_run(run_id).await;
                return false;
            }
            Ok(ConnectorRuntimeSyncOutcome::RouteUnavailable) => {
                let builtin_targets = active_targets
                    .iter()
                    .filter(|target| target.target.builtin_connector_slug().is_some())
                    .cloned()
                    .collect::<Vec<_>>();
                if !builtin_targets.is_empty()
                    && !self
                        .refresh_legacy_network_policy_batch_now(run_id, &builtin_targets)
                        .await
                {
                    return false;
                }
                let custom_targets = active_targets
                    .iter()
                    .filter(|target| target.target.builtin_connector_slug().is_none())
                    .cloned()
                    .collect::<Vec<_>>();
                self.schedule_refresh_retries(
                    run_id,
                    &custom_targets,
                    "connector_runtime_route_unavailable",
                )
                .await;
                return true;
            }
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    targets = ?target_identities(&active_targets),
                    error = %error,
                    transport_retry_attempted,
                    "connector runtime sync failed; retaining last-known-good state"
                );
                self.schedule_refresh_retries(run_id, &active_targets, "api_error")
                    .await;
                return true;
            }
        };

        self.publish_connector_runtime_response(run_id, &active_targets, response)
            .await
    }

    async fn publish_connector_runtime_response(
        &self,
        run_id: RunId,
        active_targets: &[ConnectorRefreshTarget],
        response: ConnectorRuntimeSyncBatchResponse,
    ) -> bool {
        let requested_targets = active_targets
            .iter()
            .map(|target| target.target.clone())
            .collect::<HashSet<_>>();
        let mut responses_by_target = HashMap::new();
        let mut duplicate_targets = HashSet::new();
        for result in response.results {
            if !requested_targets.contains(&result.target) {
                warn!(
                    run_id = %run_id,
                    target = %result.target.log_identity(),
                    "connector runtime sync returned unexpected target"
                );
                continue;
            }
            let target = result.target.clone();
            if responses_by_target.insert(target.clone(), result).is_some() {
                duplicate_targets.insert(target.clone());
                warn!(
                    run_id = %run_id,
                    target = %target.log_identity(),
                    "connector runtime sync returned duplicate target"
                );
            }
        }

        let mut retry_targets = Vec::new();
        for target in active_targets {
            if duplicate_targets.contains(&target.target) {
                retry_targets.push(target.clone());
                continue;
            }
            let Some(result) = responses_by_target.remove(&target.target) else {
                warn!(
                    run_id = %run_id,
                    target = %target.target.log_identity(),
                    "connector runtime sync response omitted requested target"
                );
                retry_targets.push(target.clone());
                continue;
            };
            let candidate_base_url_vars = match (&target.target, &result.state) {
                (
                    ConnectorRuntimeTarget::Custom { .. },
                    ConnectorRuntimeSyncState::Available { .. },
                ) => result.base_url_vars.clone(),
                _ if result.base_url_vars.is_some() => {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        "connector runtime sync returned base URL variables for an invalid target state"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
                _ => None,
            };
            if let ConnectorRuntimeSyncState::Unresolved { reason } = &result.state {
                if !connector_runtime_unresolved_reason_is_valid(&target.target, reason) {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        reason = ?reason,
                        "invalid connector runtime sync result; retaining last-known-good state"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
                warn!(
                    run_id = %run_id,
                    target = %target.target.log_identity(),
                    reason = ?reason,
                    "connector runtime sync is unresolved; retaining last-known-good state"
                );
                retry_targets.push(target.clone());
                continue;
            }
            let deadline = match parse_optional_refresh_deadline(result.next_sync_at.as_deref()) {
                Ok(deadline) => deadline,
                Err(()) => {
                    retry_targets.push(target.clone());
                    continue;
                }
            };
            let Some(snapshot) = self.active_snapshot_for_target(run_id, target).await else {
                continue;
            };
            // Missing metadata is the old-API compatibility shape. #25351
            // removes this acceptance after the producer and old APIs drain.
            if let Some(candidate) = &candidate_base_url_vars {
                let Some(matches_pinned_values) = self
                    .custom_base_url_vars_match(run_id, target, candidate)
                    .await
                else {
                    continue;
                };
                if !matches_pinned_values {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        "connector runtime sync tried to replace run-pinned base URL variables"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
            }
            let publication = match (&target.target, &result.state) {
                (
                    ConnectorRuntimeTarget::Builtin { connector_slug },
                    ConnectorRuntimeSyncState::Available {
                        network_policy,
                        firewall,
                    },
                ) => {
                    if firewall.is_some() {
                        Err("builtin available result must not include an inline firewall")
                    } else if let Err(error) =
                        validate_connector_runtime_network_policy(network_policy)
                    {
                        Err(error)
                    } else {
                        match patch_network_policy(
                            run_id,
                            connector_slug,
                            snapshot.clone(),
                            network_policy.clone(),
                        )
                        .await
                        {
                            Ok(published) => Ok(published),
                            Err(error) => {
                                warn!(
                                    run_id = %run_id,
                                    target = %target.target.log_identity(),
                                    error = %error,
                                    "failed to publish connector runtime target; retaining last-known-good state"
                                );
                                retry_targets.push(target.clone());
                                continue;
                            }
                        }
                    }
                }
                (
                    ConnectorRuntimeTarget::Custom {
                        custom_connector_id,
                    },
                    state,
                ) => {
                    let Some(routing_variables) = self
                        .custom_base_url_vars_for_publication(
                            run_id,
                            target,
                            candidate_base_url_vars.as_ref(),
                        )
                        .await
                    else {
                        continue;
                    };
                    let registry_state = match custom_connector_runtime_registry_state(
                        custom_connector_id,
                        state,
                        routing_variables,
                    ) {
                        Ok(state) => state,
                        Err(error) => {
                            warn!(
                                run_id = %run_id,
                                target = %target.target.log_identity(),
                                error,
                                "invalid connector runtime sync result; retaining last-known-good state"
                            );
                            retry_targets.push(target.clone());
                            continue;
                        }
                    };
                    if let ConnectorRuntimeSyncState::Absent { reason } = state {
                        info!(
                            run_id = %run_id,
                            target = %target.target.log_identity(),
                            reason = ?reason,
                            "custom connector runtime target is authoritatively absent"
                        );
                    }
                    match snapshot
                        .registry
                        .replace_custom_connector_runtime_target_if_run_matches(
                            &snapshot.source_ip,
                            &run_id.to_string(),
                            custom_connector_id,
                            registry_state,
                        )
                        .await
                    {
                        Ok(published) => Ok(published),
                        Err(error) => {
                            warn!(
                                run_id = %run_id,
                                target = %target.target.log_identity(),
                                error = %error,
                                "failed to publish connector runtime target; retaining last-known-good state"
                            );
                            retry_targets.push(target.clone());
                            continue;
                        }
                    }
                }
                (ConnectorRuntimeTarget::Builtin { .. }, _) => {
                    Err("builtin connector runtime result has an invalid state")
                }
            };
            let published = match publication {
                Ok(published) => published,
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        target = %target.target.log_identity(),
                        error,
                        "invalid connector runtime sync result; retaining last-known-good state"
                    );
                    retry_targets.push(target.clone());
                    continue;
                }
            };
            match published {
                true => {
                    if self
                        .complete_successful_refresh(
                            run_id,
                            target,
                            deadline,
                            candidate_base_url_vars.as_ref(),
                        )
                        .await
                    {
                        info!(
                            run_id = %run_id,
                            target = %target.target.log_identity(),
                            generation = target.generation,
                            "synced connector runtime target"
                        );
                    }
                }
                false => {
                    self.unregister_run(run_id).await;
                    return false;
                }
            }
        }
        self.schedule_refresh_retries(run_id, &retry_targets, "invalid_or_unpublished_response")
            .await;
        true
    }

    async fn reconcile_terminal_run(&self, run_id: RunId) {
        let Some(active) = self.take_active_run(run_id).await else {
            return;
        };
        let connector_count = active.connectors.len();
        let snapshot = ActiveRunNetworkPolicySnapshot {
            source_ip: active.source_ip,
            registry: active.registry,
        };
        for target in active.connectors.into_keys() {
            let result = match &target {
                ConnectorRuntimeTarget::Builtin { connector_slug } => {
                    snapshot
                        .registry
                        .fail_closed_network_policy_if_run_matches(
                            &snapshot.source_ip,
                            &run_id.to_string(),
                            connector_slug,
                        )
                        .await
                }
                ConnectorRuntimeTarget::Custom {
                    custom_connector_id,
                } => {
                    snapshot
                        .registry
                        .fail_closed_custom_connector_runtime_target_if_run_matches(
                            &snapshot.source_ip,
                            &run_id.to_string(),
                            custom_connector_id,
                        )
                        .await
                }
            };
            if let Err(error) = result {
                warn!(
                    run_id = %run_id,
                    target = %target.log_identity(),
                    error = %error,
                    "failed to close terminal run connector runtime target"
                );
            }
        }
        info!(
            run_id = %run_id,
            connector_count,
            "reconciled terminal run network policies"
        );
    }

    #[cfg(test)]
    async fn current_refresh_target(
        &self,
        run_id: RunId,
        connector_slug: &str,
    ) -> Option<ConnectorRefreshTarget> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        let runtime_target = ConnectorRuntimeTarget::Builtin {
            connector_slug: connector_slug.to_string(),
        };
        let connector = active.connectors.get(&runtime_target)?;
        Some(ConnectorRefreshTarget {
            target: runtime_target,
            generation: connector.generation,
        })
    }

    #[cfg(test)]
    async fn current_refresh_targets(
        &self,
        run_id: RunId,
        connector_slugs: Vec<String>,
    ) -> Vec<ConnectorRefreshTarget> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        connector_slugs
            .into_iter()
            .filter_map(|connector_slug| {
                if !seen.insert(connector_slug.clone()) {
                    return None;
                }
                let runtime_target = ConnectorRuntimeTarget::Builtin { connector_slug };
                let connector = active.connectors.get(&runtime_target)?;
                Some(ConnectorRefreshTarget {
                    target: runtime_target,
                    generation: connector.generation,
                })
            })
            .collect()
    }

    async fn active_refresh_targets(
        &self,
        run_id: RunId,
        targets: Vec<ConnectorRefreshTarget>,
    ) -> Vec<ConnectorRefreshTarget> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        let mut seen = HashSet::new();
        targets
            .into_iter()
            .filter(|target| {
                active
                    .connectors
                    .get(&target.target)
                    .is_some_and(|connector| connector.generation == target.generation)
                    && seen.insert(target.target.clone())
            })
            .collect()
    }

    async fn current_connector_runtime_sync_targets(
        &self,
        run_id: RunId,
        targets: &[ConnectorRefreshTarget],
    ) -> Vec<(ConnectorRefreshTarget, ConnectorRuntimeTargetRegistration)> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        targets
            .iter()
            .filter_map(|target| {
                let connector = active.connectors.get(&target.target)?;
                if connector.generation != target.generation {
                    return None;
                }
                let registration = match &target.target {
                    ConnectorRuntimeTarget::Builtin { connector_slug } => {
                        ConnectorRuntimeTargetRegistration::Builtin {
                            connector_slug: connector_slug.clone(),
                        }
                    }
                    ConnectorRuntimeTarget::Custom {
                        custom_connector_id,
                    } => ConnectorRuntimeTargetRegistration::Custom {
                        custom_connector_id: custom_connector_id.clone(),
                        base_url_vars: connector.pinned_base_url_vars.clone(),
                    },
                };
                Some((target.clone(), registration))
            })
            .collect()
    }

    async fn run_is_tagged(&self, run_id: RunId) -> bool {
        self.inner
            .active_runs
            .lock()
            .await
            .get(&run_id)
            .is_some_and(|active| active.tagged)
    }

    async fn active_snapshot_for_target(
        &self,
        run_id: RunId,
        target: &ConnectorRefreshTarget,
    ) -> Option<ActiveRunNetworkPolicySnapshot> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        if active
            .connectors
            .get(&target.target)
            .is_none_or(|connector| connector.generation != target.generation)
        {
            return None;
        }
        Some(ActiveRunNetworkPolicySnapshot {
            source_ip: active.source_ip.clone(),
            registry: active.registry.clone(),
        })
    }

    async fn custom_base_url_vars_match(
        &self,
        run_id: RunId,
        target: &ConnectorRefreshTarget,
        candidate: &HashMap<String, String>,
    ) -> Option<bool> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        let connector = active.connectors.get(&target.target)?;
        Some(
            connector
                .pinned_base_url_vars
                .as_ref()
                .is_none_or(|pinned| pinned == candidate),
        )
    }

    async fn custom_base_url_vars_for_publication(
        &self,
        run_id: RunId,
        target: &ConnectorRefreshTarget,
        candidate: Option<&HashMap<String, String>>,
    ) -> Option<Option<HashMap<String, String>>> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        let connector = active.connectors.get(&target.target)?;
        if connector.generation != target.generation {
            return None;
        }
        Some(
            connector
                .pinned_base_url_vars
                .clone()
                .or_else(|| candidate.cloned()),
        )
    }

    async fn complete_successful_refresh(
        &self,
        run_id: RunId,
        target: &ConnectorRefreshTarget,
        deadline: Option<tokio::time::Instant>,
        candidate_base_url_vars: Option<&HashMap<String, String>>,
    ) -> bool {
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return false;
        };
        let Some(connector) = active.connectors.get_mut(&target.target) else {
            return false;
        };
        if connector.generation != target.generation {
            return false;
        }
        if let Some(candidate) = candidate_base_url_vars {
            match &connector.pinned_base_url_vars {
                Some(pinned) if pinned != candidate => return false,
                Some(_) => {}
                None => connector.pinned_base_url_vars = Some(candidate.clone()),
            }
        }
        connector.consecutive_failures = 0;
        self.replace_schedule_locked(active, run_id, target, deadline)
    }

    async fn schedule_refresh_retries(
        &self,
        run_id: RunId,
        targets: &[ConnectorRefreshTarget],
        reason: &'static str,
    ) {
        if targets.is_empty() {
            return;
        }

        let scheduling_base = tokio::time::Instant::now();
        let mut scheduled = Vec::new();
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return;
        };

        let mut seen = HashSet::new();
        for target in targets {
            if !seen.insert(&target.target) {
                continue;
            }
            let Some(connector) = active.connectors.get_mut(&target.target) else {
                continue;
            };
            if connector.generation != target.generation {
                continue;
            }
            connector.consecutive_failures = connector.consecutive_failures.saturating_add(1);
            let attempt = connector.consecutive_failures;
            let delay = refresh_retry_delay(run_id, attempt);
            let deadline = scheduling_base + delay;
            if self.replace_schedule_locked(active, run_id, target, Some(deadline)) {
                scheduled.push((target.clone(), attempt, delay));
            }
        }
        drop(active_runs);

        for (target, attempt, delay) in scheduled {
            warn!(
                run_id = %run_id,
                target = %target.target.log_identity(),
                generation = target.generation,
                attempt,
                retry_delay_ms = delay.as_millis() as u64,
                will_retry = true,
                reason,
                "retained last-known-good network policy; scheduled refresh retry"
            );
        }
    }

    async fn replace_schedule_deadline_if_current(
        &self,
        run_id: RunId,
        target: &ConnectorRefreshTarget,
        deadline: Option<tokio::time::Instant>,
    ) -> bool {
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return false;
        };
        self.replace_schedule_locked(active, run_id, target, deadline)
    }

    fn replace_schedule_locked(
        &self,
        active: &mut ActiveRunNetworkPolicyState,
        run_id: RunId,
        target: &ConnectorRefreshTarget,
        deadline: Option<tokio::time::Instant>,
    ) -> bool {
        if active
            .connectors
            .get(&target.target)
            .is_none_or(|connector| connector.generation != target.generation)
        {
            return false;
        }

        if let Some(old) = active.refresh_tasks.remove(&target.target) {
            old.handle.abort();
        }
        let Some(deadline) = deadline else {
            return true;
        };

        let task_id = active.next_refresh_task_id;
        active.next_refresh_task_id += 1;
        let cancel = active.cancel.clone();
        let global_cancel = self.inner.cancel.clone();
        let runtime_target = target.target.clone();
        let generation = target.generation;
        let handle = self.clone();
        let task_target = runtime_target.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                () = global_cancel.cancelled() => {}
                () = cancel.cancelled() => {}
                () = tokio::time::sleep_until(deadline) => {
                    if let Some((targets, enqueue_cancel)) = handle
                        .take_due_scheduled_refreshes(run_id, &task_target, task_id)
                        .await
                    {
                        handle
                            .enqueue_scheduled_refresh(
                                RefreshRequest {
                                    run_id,
                                    targets,
                                },
                                &enqueue_cancel,
                            )
                            .await;
                    }
                }
            }
        });
        active.refresh_tasks.insert(
            runtime_target,
            ScheduledRefreshTask {
                id: task_id,
                generation,
                deadline,
                handle: task,
            },
        );
        true
    }

    async fn take_due_scheduled_refreshes(
        &self,
        run_id: RunId,
        target: &ConnectorRuntimeTarget,
        task_id: u64,
    ) -> Option<(Vec<ConnectorRefreshTarget>, CancellationToken)> {
        let mut handles_to_abort = Vec::new();
        let (targets, cancel) = {
            let mut active_runs = self.inner.active_runs.lock().await;
            let active = active_runs.get_mut(&run_id)?;
            if active
                .refresh_tasks
                .get(target)
                .is_none_or(|task| task.id != task_id)
            {
                return None;
            }

            let coalesce_deadline = tokio::time::Instant::now() + SCHEDULED_REFRESH_COALESCE_WINDOW;
            let mut due_targets = active
                .refresh_tasks
                .iter()
                .filter(|(_, task)| task.deadline <= coalesce_deadline)
                .map(|(target, _)| target.clone())
                .collect::<Vec<_>>();
            due_targets.sort_by_key(ConnectorRuntimeTarget::log_identity);

            let mut targets = Vec::with_capacity(due_targets.len());
            for due_target in due_targets {
                if let Some(task) = active.refresh_tasks.remove(&due_target) {
                    if due_target != *target {
                        handles_to_abort.push(task.handle);
                    }
                    targets.push(ConnectorRefreshTarget {
                        target: due_target,
                        generation: task.generation,
                    });
                }
            }

            (targets, active.cancel.clone())
        };

        abort_tasks(handles_to_abort);
        (!targets.is_empty()).then_some((targets, cancel))
    }
}

async fn run_refresh_worker(
    handle: NetworkPolicyRefreshCore,
    mut request_rx: mpsc::Receiver<RefreshRequest>,
) {
    loop {
        tokio::select! {
            () = handle.inner.cancel.cancelled() => {
                break;
            }
            request = request_rx.recv() => {
                let Some(request) = request else {
                    break;
                };
                let RefreshRequest {
                    run_id,
                    targets,
                } = request;
                let completed = tokio::select! {
                    () = handle.inner.cancel.cancelled() => {
                        false
                    }
                    () = handle.refresh_network_policy_targets_now(
                        run_id,
                        targets,
                    ) => {
                        true
                    }
                };
                if !completed {
                    break;
                }
            }
        }
    }
}

async fn patch_network_policy(
    run_id: RunId,
    connector_slug: &str,
    snapshot: ActiveRunNetworkPolicySnapshot,
    policy: NetworkPolicy,
) -> crate::error::RunnerResult<bool> {
    snapshot
        .registry
        .patch_network_policy_if_run_matches(
            &snapshot.source_ip,
            &run_id.to_string(),
            connector_slug,
            policy,
        )
        .await
}

fn connector_runtime_unresolved_reason_is_valid(
    target: &ConnectorRuntimeTarget,
    reason: &ConnectorRuntimeUnresolvedReason,
) -> bool {
    matches!(target, ConnectorRuntimeTarget::Custom { .. })
        || matches!(reason, ConnectorRuntimeUnresolvedReason::Connector)
}

fn custom_connector_runtime_registry_state(
    custom_connector_id: &str,
    state: &ConnectorRuntimeSyncState,
    routing_variables: Option<HashMap<String, String>>,
) -> Result<CustomConnectorRuntimeRegistryState, &'static str> {
    match state {
        ConnectorRuntimeSyncState::Absent { .. } => Ok(CustomConnectorRuntimeRegistryState::Absent),
        ConnectorRuntimeSyncState::Available {
            network_policy,
            firewall:
                Some(
                    firewall @ FirewallEntry::Inline {
                        firewall: inline_firewall,
                        custom_connector_id: Some(entry_connector_id),
                    },
                ),
            ..
        } => {
            validate_connector_runtime_network_policy(network_policy)?;
            if entry_connector_id != custom_connector_id {
                return Err("custom available result has a mismatched connector id");
            }
            inline_firewall
                .validate_for_connector_runtime()
                .map_err(|_| "custom available result has an invalid inline firewall")?;
            Ok(CustomConnectorRuntimeRegistryState::Available {
                firewall: firewall.clone(),
                network_policy: Box::new(network_policy.clone()),
                routing_variables,
            })
        }
        ConnectorRuntimeSyncState::Available { network_policy, .. } => {
            validate_connector_runtime_network_policy(network_policy)?;
            Err("custom available result must include an inline firewall")
        }
        ConnectorRuntimeSyncState::Unresolved { .. } => {
            Err("unresolved custom runtime result reached registry publication")
        }
    }
}

fn validate_connector_runtime_network_policy(policy: &NetworkPolicy) -> Result<(), &'static str> {
    if !matches!(policy.unknown_policy.as_str(), "allow" | "deny" | "ask") {
        return Err("connector runtime network policy has an invalid unknown policy");
    }
    let mut permission_names = HashSet::new();
    for permission_name in policy.allow.iter().chain(&policy.deny).chain(&policy.ask) {
        if permission_name.is_empty() || !permission_names.insert(permission_name) {
            return Err("connector runtime network policy has invalid permission names");
        }
    }
    Ok(())
}

fn parse_optional_refresh_deadline(
    value: Option<&str>,
) -> Result<Option<tokio::time::Instant>, ()> {
    value.map(parse_refresh_deadline).transpose()
}

fn parse_refresh_deadline(value: &str) -> Result<tokio::time::Instant, ()> {
    let deadline = match DateTime::parse_from_rfc3339(value) {
        Ok(deadline) => deadline.with_timezone(&Utc),
        Err(error) => {
            warn!(
                next_refresh_at = value,
                error = %error,
                "invalid network policy refresh deadline"
            );
            return Err(());
        }
    };
    let delay = deadline
        .signed_duration_since(Utc::now())
        .to_std()
        .unwrap_or(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY);
    Ok(tokio::time::Instant::now() + delay)
}

fn refresh_retry_delay(run_id: RunId, attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    let base = REFRESH_RETRY_INITIAL_DELAY
        .saturating_mul(1_u32 << exponent)
        .min(REFRESH_RETRY_MAX_DELAY);
    let mut hasher = DefaultHasher::new();
    run_id.hash(&mut hasher);
    attempt.hash(&mut hasher);
    let jitter_per_mille =
        REFRESH_RETRY_JITTER_MIN_PER_MILLE + hasher.finish() % REFRESH_RETRY_JITTER_SPAN_PER_MILLE;
    Duration::from_millis((base.as_millis() as u64).saturating_mul(jitter_per_mille) / 1_000)
}

fn target_connector_slugs(targets: &[ConnectorRefreshTarget]) -> Vec<&str> {
    targets
        .iter()
        .filter_map(|target| target.target.builtin_connector_slug())
        .collect()
}

fn target_identities(targets: &[ConnectorRefreshTarget]) -> Vec<String> {
    targets
        .iter()
        .map(|target| target.target.log_identity())
        .collect()
}

fn abort_tasks(tasks: impl IntoIterator<Item = tokio::task::JoinHandle<()>>) {
    for task in tasks {
        task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use httpmock::{Method::POST, MockServer};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    use crate::http::{HttpClient, HttpClientConfig};
    use crate::proxy::{ProxyRegistryHandle, VmRegistration};
    use crate::types::{Firewall, FirewallApi, FirewallAuth, FirewallEntry};

    fn api_client_for_url(api_url: String) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url,
                vercel_bypass: None,
                client_session_id: "runner-session-test".to_string(),
            })
            .expect("test API URL should be valid"),
            "runner-token".to_string(),
        )
    }

    fn builtin_target(connector_slug: &str) -> ConnectorRuntimeTarget {
        ConnectorRuntimeTarget::Builtin {
            connector_slug: connector_slug.to_string(),
        }
    }

    fn custom_target(custom_connector_id: &str) -> ConnectorRuntimeTarget {
        ConnectorRuntimeTarget::Custom {
            custom_connector_id: custom_connector_id.to_string(),
        }
    }

    fn runtime_target_registration(
        target: &ConnectorRuntimeTarget,
    ) -> ConnectorRuntimeTargetRegistration {
        target.clone().into()
    }

    fn custom_runtime_firewall(custom_connector_id: &str) -> FirewallEntry {
        FirewallEntry::Inline {
            firewall: Firewall {
                name: format!("custom_connector_{}", custom_connector_id.replace('-', "")),
                apis: vec![FirewallApi {
                    id: "custom-api:0".to_string(),
                    base: "https://custom.example.test/api/".to_string(),
                    auth: FirewallAuth {
                        headers: HashMap::from([(
                            "Authorization".to_string(),
                            "Bearer ${{ secrets.CUSTOM_TOKEN }}".to_string(),
                        )]),
                        base: None,
                        query: None,
                        aws_sigv4: None,
                    },
                    host_policy: None,
                    permissions: None,
                }],
            },
            custom_connector_id: Some(custom_connector_id.to_string()),
        }
    }

    fn api_client_for_server(server: &MockServer) -> ApiClient {
        api_client_for_url(server.base_url())
    }

    async fn accept_http_request(listener: &TcpListener) -> (tokio::net::TcpStream, String) {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buf = [0_u8; 1024];
        let header_end = loop {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break request.len();
            }
            request.extend_from_slice(&buf[..n]);
            if let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
            {
                break header_end;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("content-length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .expect("request should include a valid Content-Length header");
        let request_len = header_end + content_length;
        while request.len() < request_len {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            request.extend_from_slice(&buf[..n]);
        }
        (socket, String::from_utf8_lossy(&request).into_owned())
    }

    fn assert_network_policy_refresh_request(request: &str, run_id: &RunId) {
        let expected = format!("POST /api/runners/runs/{run_id}/network-policy-refresh HTTP/1.1");
        assert_eq!(request.lines().next(), Some(expected.as_str()));
        assert!(
            request.ends_with(r#"{"connectorSlugs":["slack"]}"#),
            "unexpected network policy refresh request: {request}"
        );
    }

    fn core_without_worker(
        server: &MockServer,
    ) -> (
        NetworkPolicyRefreshCore,
        tokio::sync::mpsc::Receiver<RefreshRequest>,
    ) {
        let (request_tx, request_rx) = mpsc::channel(REFRESH_REQUEST_QUEUE_CAPACITY);
        (
            NetworkPolicyRefreshCore {
                inner: Arc::new(NetworkPolicyRefreshState {
                    api: api_client_for_server(server),
                    active_runs: Mutex::new(HashMap::new()),
                    cancel: CancellationToken::new(),
                }),
                request_tx,
            },
            request_rx,
        )
    }

    async fn recv_refresh_request(
        requests: &mut tokio::sync::mpsc::Receiver<RefreshRequest>,
    ) -> RefreshRequest {
        tokio::time::timeout(Duration::from_secs(1), requests.recv())
            .await
            .expect("refresh request should arrive before timeout")
            .expect("refresh queue should stay open")
    }

    async fn wait_until_scheduled_refresh_task_clears(
        core: &NetworkPolicyRefreshCore,
        run_id: RunId,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| active.refresh_tasks.is_empty())
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("scheduled refresh task should clear itself before timeout");
    }

    struct NetworkPolicyRefreshHarness {
        _dir: tempfile::TempDir,
        handle: NetworkPolicyRefreshHandle,
        registry_path: std::path::PathBuf,
        run_id: RunId,
        source_ip: String,
    }

    impl NetworkPolicyRefreshHarness {
        async fn new(server: &MockServer, run_id: RunId) -> Self {
            Self::new_with_connectors(server, run_id, &["slack"]).await
        }

        async fn new_with_connectors(
            server: &MockServer,
            run_id: RunId,
            connector_slugs: &[&str],
        ) -> Self {
            Self::new_with_api(api_client_for_server(server), run_id, connector_slugs).await
        }

        async fn new_with_api(api: ApiClient, run_id: RunId, connector_slugs: &[&str]) -> Self {
            let dir = tempfile::tempdir().expect("tempdir should be created");
            let registry_path = dir.path().join("proxy-registry.json");
            tokio::fs::write(&registry_path, br#"{"vms":{},"updatedAt":0}"#)
                .await
                .expect("empty registry should be written");
            let registry =
                ProxyRegistryHandle::new(registry_path.clone(), dir.path().join("registry.lock"));
            let source_ip = "10.200.0.2";
            let connector_slugs = connector_slugs
                .iter()
                .map(|connector_slug| (*connector_slug).to_string())
                .collect::<HashSet<_>>();
            let firewalls = connector_slugs
                .iter()
                .map(|connector_slug| FirewallEntry::Builtin {
                    name: connector_slug.clone(),
                    base_url_vars: None,
                })
                .collect::<Vec<_>>();
            let network_policies = connector_slugs
                .iter()
                .map(|connector_slug| {
                    (
                        connector_slug.clone(),
                        NetworkPolicy {
                            allow: vec!["chat:write".to_string()],
                            deny: vec!["files:write".to_string()],
                            ask: vec!["channels:read".to_string()],
                            unknown_policy: "allow".to_string(),
                        },
                    )
                })
                .collect::<HashMap<_, _>>();
            let billable_firewalls = Vec::new();
            let run_id_string = run_id.to_string();
            let network_log_path = dir.path().join("network.jsonl");
            let proxy_log_path = dir.path().join("proxy.log");
            registry
                .register_vm(
                    source_ip,
                    &VmRegistration {
                        run_id: &run_id_string,
                        cli_agent_type: "codex",
                        sandbox_token: "sandbox-token",
                        network_log_path: &network_log_path,
                        proxy_log_path: &proxy_log_path,
                        firewalls: Some(&firewalls),
                        network_policies: Some(&network_policies),
                        connector_runtime_targets: None,
                        encrypted_secrets: None,
                        secret_connector_map: None,
                        secret_connector_metadata_map: None,
                        vars: None,
                        capture_network_bodies: false,
                        billable_firewalls: &billable_firewalls,
                        model_usage_provider: None,
                    },
                )
                .await
                .expect("vm should be registered");

            let handle = NetworkPolicyRefreshHandle::new(api);
            handle
                .core
                .register_run(NetworkPolicyRefreshRegistration {
                    run_id,
                    source_ip,
                    registry: registry.clone(),
                    connector_slugs,
                    targets: None,
                    refreshes: None,
                })
                .await;

            Self {
                _dir: dir,
                handle,
                registry_path,
                run_id,
                source_ip: source_ip.to_string(),
            }
        }

        async fn refresh_slack(&self) {
            self.handle
                .core
                .refresh_network_policies_now(self.run_id, vec!["slack".to_string()])
                .await;
        }

        async fn slack_policy(&self) -> serde_json::Value {
            self.policy("slack").await
        }

        async fn policy(&self, connector_slug: &str) -> serde_json::Value {
            let registry_json: serde_json::Value = serde_json::from_str(
                &tokio::fs::read_to_string(&self.registry_path)
                    .await
                    .expect("registry should be readable"),
            )
            .expect("registry should be valid JSON");
            registry_json["vms"][&self.source_ip]["networkPolicies"][connector_slug].clone()
        }

        async fn shutdown(self) {
            self.handle.shutdown().await;
        }
    }

    fn assert_fail_closed_policy(policy: &serde_json::Value) {
        assert_eq!(policy["allow"], json!([]));
        assert_eq!(
            policy["deny"],
            json!(["channels:read", "chat:write", "files:write"])
        );
        assert_eq!(policy["ask"], json!([]));
        assert_eq!(policy["unknownPolicy"], json!("deny"));
    }

    fn assert_last_known_good_policy(policy: &serde_json::Value) {
        assert_eq!(
            policy,
            &json!({
                "allow": ["chat:write"],
                "deny": ["files:write"],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
    }

    async fn assert_retry_scheduled(
        core: &NetworkPolicyRefreshCore,
        run_id: RunId,
        connector_slug: &str,
        expected_attempt: u32,
    ) {
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active while refresh retries");
        let connector = active
            .connectors
            .get(&ConnectorRuntimeTarget::Builtin {
                connector_slug: connector_slug.to_string(),
            })
            .expect("connector should remain active while refresh retries");
        assert_eq!(connector.consecutive_failures, expected_attempt);
        let task = active
            .refresh_tasks
            .get(&ConnectorRuntimeTarget::Builtin {
                connector_slug: connector_slug.to_string(),
            })
            .expect("connector should retain a scheduled refresh retry");
        assert_eq!(task.generation, connector.generation);
        assert!(task.deadline > tokio::time::Instant::now());
    }

    fn network_policy_refresh_response(mut identity: serde_json::Value) -> serde_json::Value {
        let refresh = identity
            .as_object_mut()
            .expect("network policy refresh identity fixture should be an object");
        refresh.insert(
            "networkPolicy".to_string(),
            json!({
                "allow": ["chat:write", "files:write"],
                "deny": [],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            }),
        );
        refresh.insert("nextRefreshAt".to_string(), serde_json::Value::Null);
        json!({ "refreshes": [identity] })
    }

    async fn capture_network_policy_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
    where
        F: std::future::Future,
    {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        let output = future.with_subscriber(subscriber).await;
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
            .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
    }

    fn assert_connector_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(actual, expected, "event={event:#?}");
    }

    fn active_run_network_policy_state(
        registry: ProxyRegistryHandle,
    ) -> ActiveRunNetworkPolicyState {
        active_run_network_policy_state_with_connectors(registry, ["slack"])
    }

    fn active_run_network_policy_state_with_connectors<I, S>(
        registry: ProxyRegistryHandle,
        connector_slugs: I,
    ) -> ActiveRunNetworkPolicyState
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        ActiveRunNetworkPolicyState {
            source_ip: "10.200.0.2".to_string(),
            registry,
            connectors: connector_slugs
                .into_iter()
                .map(|connector_slug| {
                    (
                        ConnectorRuntimeTarget::Builtin {
                            connector_slug: connector_slug.into(),
                        },
                        ActiveConnectorRefreshState {
                            generation: 0,
                            consecutive_failures: 0,
                            pinned_base_url_vars: None,
                        },
                    )
                })
                .collect(),
            tagged: false,
            cancel: CancellationToken::new(),
            refresh_tasks: HashMap::new(),
            next_refresh_task_id: 0,
        }
    }

    fn refresh_request(run_id: RunId, connector_slug: &str) -> RefreshRequest {
        RefreshRequest {
            run_id,
            targets: vec![ConnectorRefreshTarget {
                target: ConnectorRuntimeTarget::Builtin {
                    connector_slug: connector_slug.to_string(),
                },
                generation: 0,
            }],
        }
    }

    async fn replace_schedule(
        core: &NetworkPolicyRefreshCore,
        run_id: RunId,
        connector_slug: &str,
        next_refresh_at: &str,
    ) {
        let target = core
            .current_refresh_target(run_id, connector_slug)
            .await
            .expect("active connector should have a refresh target");
        let deadline =
            parse_refresh_deadline(next_refresh_at).expect("valid refresh deadline should parse");
        assert!(
            core.replace_schedule_deadline_if_current(run_id, &target, Some(deadline))
                .await,
            "active connector should accept refresh schedule"
        );
    }

    async fn registered_slack_registry(
        run_id: RunId,
    ) -> (
        tempfile::TempDir,
        ProxyRegistryHandle,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"vms":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let lock_path = dir.path().join("registry.lock");
        let registry = ProxyRegistryHandle::new(registry_path.clone(), lock_path.clone());
        let firewalls = vec![FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
        }];
        let mut network_policies = HashMap::new();
        network_policies.insert(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec!["files:write".to_string()],
                ask: vec!["channels:read".to_string()],
                unknown_policy: "allow".to_string(),
            },
        );
        let run_id_string = run_id.to_string();
        let network_log_path = dir.path().join("network.jsonl");
        let proxy_log_path = dir.path().join("proxy.log");
        registry
            .register_vm(
                "10.200.0.2",
                &VmRegistration {
                    run_id: &run_id_string,
                    cli_agent_type: "codex",
                    sandbox_token: "sandbox-token",
                    network_log_path: &network_log_path,
                    proxy_log_path: &proxy_log_path,
                    firewalls: Some(&firewalls),
                    network_policies: Some(&network_policies),
                    connector_runtime_targets: None,
                    encrypted_secrets: None,
                    secret_connector_map: None,
                    secret_connector_metadata_map: None,
                    vars: None,
                    capture_network_bodies: false,
                    billable_firewalls: &[],
                    model_usage_provider: None,
                },
            )
            .await
            .expect("vm should be registered");
        (dir, registry, registry_path, lock_path)
    }

    async fn registered_runtime_registry(
        run_id: RunId,
        firewalls: &[FirewallEntry],
        network_policies: &HashMap<String, NetworkPolicy>,
    ) -> (tempfile::TempDir, ProxyRegistryHandle, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"vms":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let registry = ProxyRegistryHandle::new(
            registry_path.clone(),
            dir.path().join("proxy-registry.lock"),
        );
        let run_id = run_id.to_string();
        let network_log_path = dir.path().join("network.jsonl");
        let proxy_log_path = dir.path().join("proxy.log");
        registry
            .register_vm(
                "10.200.0.2",
                &VmRegistration {
                    run_id: &run_id,
                    cli_agent_type: "codex",
                    sandbox_token: "sandbox-token",
                    network_log_path: &network_log_path,
                    proxy_log_path: &proxy_log_path,
                    firewalls: Some(firewalls),
                    network_policies: Some(network_policies),
                    connector_runtime_targets: None,
                    encrypted_secrets: None,
                    secret_connector_map: None,
                    secret_connector_metadata_map: None,
                    vars: None,
                    capture_network_bodies: false,
                    billable_firewalls: &[],
                    model_usage_provider: None,
                },
            )
            .await
            .expect("vm should be registered");
        (dir, registry, registry_path)
    }

    async fn register_tagged_builtin_runtime(
        core: &NetworkPolicyRefreshCore,
        run_id: RunId,
        connector_slugs: &[&str],
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        Vec<ConnectorRuntimeTarget>,
    ) {
        let targets = connector_slugs
            .iter()
            .map(|connector_slug| builtin_target(connector_slug))
            .collect::<Vec<_>>();
        let registrations = targets
            .iter()
            .map(runtime_target_registration)
            .collect::<Vec<_>>();
        let firewalls = connector_slugs
            .iter()
            .map(|connector_slug| FirewallEntry::Builtin {
                name: (*connector_slug).to_string(),
                base_url_vars: None,
            })
            .collect::<Vec<_>>();
        let policies = connector_slugs
            .iter()
            .map(|connector_slug| {
                (
                    (*connector_slug).to_string(),
                    NetworkPolicy {
                        allow: vec!["last-known-good".to_string()],
                        deny: vec![],
                        ask: vec![],
                        unknown_policy: "allow".to_string(),
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let (dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: connector_slugs
                .iter()
                .map(|connector_slug| (*connector_slug).to_string())
                .collect(),
            targets: Some(&registrations),
            refreshes: None,
        })
        .await;
        (dir, registry_path, targets)
    }

    async fn wait_until_slack_policy(
        registry_path: &std::path::Path,
        predicate: impl Fn(&serde_json::Value) -> bool,
    ) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let registry_json: serde_json::Value = serde_json::from_str(
                    &tokio::fs::read_to_string(registry_path)
                        .await
                        .expect("registry should be readable"),
                )
                .expect("registry should be valid JSON");
                let policy = registry_json["vms"]["10.200.0.2"]["networkPolicies"]["slack"].clone();
                if predicate(&policy) {
                    return policy;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("slack policy should match before timeout")
    }

    #[tokio::test]
    async fn shutdown_awaits_refresh_worker_task() {
        let server = MockServer::start();
        let handle = NetworkPolicyRefreshHandle::new(api_client_for_server(&server));

        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .expect("network policy refresh shutdown timed out");

        let worker_task = handle
            .worker
            .task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(worker_task.is_none());
    }

    #[tokio::test]
    async fn shutdown_cancels_stalled_in_flight_refresh() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let run_id = RunId::nil();
        let harness = NetworkPolicyRefreshHarness::new_with_api(
            api_client_for_url(api_url),
            run_id,
            &["slack"],
        )
        .await;
        let policy_before_shutdown = harness.slack_policy().await;
        let (request_received_tx, request_received_rx) = tokio::sync::oneshot::channel();
        let (verify_shutdown_tx, verify_shutdown_rx) = tokio::sync::oneshot::channel();
        let mut server_tasks = tokio::task::JoinSet::new();
        server_tasks.spawn(async move {
            let (mut socket, request) = accept_http_request(&listener).await;
            request_received_tx
                .send(())
                .expect("request receiver should remain available");

            if verify_shutdown_rx.await.is_err() {
                let body = network_policy_refresh_response(json!({
                    "connectorSlug": "slack",
                }))
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                return (request, None);
            }

            let mut byte = [0_u8; 1];
            let closed = socket.read(&mut byte).await.unwrap();
            let listener = listener
                .into_std()
                .expect("listener should convert to a nonblocking standard socket");
            let retry_connection_queued = match listener.accept() {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
                Err(error) => panic!("failed to inspect retry connection: {error}"),
            };
            (request, Some((closed, retry_connection_queued)))
        });

        harness
            .handle
            .notify_network_policy_refresh(run_id, "slack".to_string())
            .await;
        tokio::time::timeout(Duration::from_secs(1), request_received_rx)
            .await
            .expect("refresh request should reach the server before shutdown")
            .expect("refresh request sender should remain available");

        let shutdown = harness.handle.shutdown();
        tokio::pin!(shutdown);
        let shutdown_completed_promptly =
            tokio::time::timeout(Duration::from_secs(1), shutdown.as_mut())
                .await
                .is_ok();
        if shutdown_completed_promptly {
            verify_shutdown_tx
                .send(())
                .expect("server should remain available for shutdown verification");
        } else {
            drop(verify_shutdown_tx);
        }

        let (request, server_verification) =
            tokio::time::timeout(Duration::from_secs(1), server_tasks.join_next())
                .await
                .expect("refresh server should finish before timeout")
                .expect("refresh server task should be present")
                .expect("refresh server task should succeed");
        assert!(server_tasks.is_empty());

        if !shutdown_completed_promptly {
            tokio::time::timeout(Duration::from_secs(1), shutdown.as_mut())
                .await
                .expect("network policy refresh shutdown cleanup timed out");
            panic!("network policy refresh shutdown waited for the HTTP request timeout");
        }

        assert_network_policy_refresh_request(&request, &run_id);
        let (closed, retry_connection_queued) =
            server_verification.expect("server should verify prompt shutdown");
        assert_eq!(closed, 0, "shutdown should drop the in-flight request");
        assert!(
            !retry_connection_queued,
            "shutdown should not retry the cancelled refresh request"
        );
        assert!(
            harness
                .handle
                .worker
                .task
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .is_none(),
            "shutdown should reap the refresh worker task"
        );
        assert!(
            harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .is_empty(),
            "shutdown should clear active refresh state"
        );
        assert_eq!(
            harness.slack_policy().await,
            policy_before_shutdown,
            "shutdown should not mutate the network policy"
        );
    }

    #[tokio::test]
    async fn drop_last_handle_cancels_refresh_worker_task() {
        let server = MockServer::start();
        let handle = NetworkPolicyRefreshHandle::new(api_client_for_server(&server));
        let worker_task = handle
            .take_worker_task()
            .expect("refresh worker task should be running");

        drop(handle);

        tokio::time::timeout(Duration::from_secs(1), worker_task)
            .await
            .expect("dropping the last handle should cancel the worker task")
            .expect("worker task should not panic");
    }

    #[tokio::test]
    async fn dropping_concurrent_last_handles_releases_refresh_state() {
        let server = MockServer::start();
        let handle = NetworkPolicyRefreshHandle::new(api_client_for_server(&server));
        let other_handle = handle.clone();
        let weak_state = Arc::downgrade(&handle.core.inner);
        let barrier = Arc::new(tokio::sync::Barrier::new(3));
        let first_drop = {
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                drop(handle);
            })
        };
        let second_drop = {
            let barrier = Arc::clone(&barrier);
            tokio::spawn(async move {
                barrier.wait().await;
                drop(other_handle);
            })
        };

        barrier.wait().await;
        first_drop
            .await
            .expect("first concurrent drop task should finish");
        second_drop
            .await
            .expect("second concurrent drop task should finish");

        tokio::time::timeout(Duration::from_secs(1), async {
            while weak_state.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("concurrent last handle drops should release refresh state");
    }

    #[tokio::test]
    async fn drop_last_handle_releases_refresh_state_with_scheduled_task() {
        let server = MockServer::start();
        let handle = NetworkPolicyRefreshHandle::new(api_client_for_server(&server));
        let weak_state = Arc::downgrade(&handle.core.inner);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        let refreshes = HashMap::from([(
            "slack".to_string(),
            NetworkPolicyRefresh {
                next_refresh_at: "2999-01-01T00:00:00Z".to_string(),
            },
        )]);
        handle
            .core
            .register_run(NetworkPolicyRefreshRegistration {
                run_id,
                source_ip: "10.200.0.2",
                registry,
                connector_slugs: HashSet::from(["slack".to_string()]),
                targets: None,
                refreshes: Some(&refreshes),
            })
            .await;

        drop(handle);

        tokio::time::timeout(Duration::from_secs(1), async {
            while weak_state.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropping the last handle should release refresh state");
    }

    #[tokio::test]
    async fn register_after_shutdown_is_ignored() {
        let server = MockServer::start();
        let handle = NetworkPolicyRefreshHandle::new(api_client_for_server(&server));
        handle.shutdown().await;
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );

        handle
            .core
            .register_run(NetworkPolicyRefreshRegistration {
                run_id: RunId::nil(),
                source_ip: "10.200.0.2",
                registry,
                connector_slugs: HashSet::from(["slack".to_string()]),
                targets: None,
                refreshes: None,
            })
            .await;

        assert!(handle.core.inner.active_runs.lock().await.is_empty());
    }

    #[tokio::test]
    async fn tagged_builtin_target_retains_last_known_good_until_runtime_sync_recovers() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let target = builtin_target("slack");
        let unresolved_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "unresolved",
                        "reason": "connector-unavailable",
                    }],
                }));
        });
        let firewalls = vec![FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: Some(HashMap::from([(
                "workspace".to_string(),
                "acme".to_string(),
            )])),
        }];
        let policies = HashMap::from([(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec!["files:write".to_string()],
                ask: vec![],
                unknown_policy: "allow".to_string(),
            },
        )]);
        let refreshes = HashMap::from([(
            "slack".to_string(),
            NetworkPolicyRefresh {
                next_refresh_at: "2999-01-01T00:00:00Z".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::from(["slack".to_string()]),
            targets: Some(std::slice::from_ref(&runtime_target_registration(&target))),
            refreshes: Some(&refreshes),
        })
        .await;

        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert!(
            core.inner.active_runs.lock().await[&run_id]
                .refresh_tasks
                .contains_key(&target)
        );

        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        unresolved_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        assert_eq!(
            active_runs[&run_id].connectors[&target].consecutive_failures,
            1
        );
        assert!(active_runs[&run_id].refresh_tasks.contains_key(&target));
        drop(active_runs);

        unresolved_sync.delete_async().await;
        let available_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "networkPolicy": {
                            "allow": ["chat:write", "files:write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                        "nextSyncAt": "2999-01-01T00:00:00Z",
                    }],
                }));
        });
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        available_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let vm = &registry_json["vms"]["10.200.0.2"];
        assert_eq!(
            vm["firewalls"],
            json!([{
                "kind": "builtin",
                "name": "slack",
                "baseUrlVars": {"workspace": "acme"},
            }])
        );
        assert_eq!(
            vm["networkPolicies"]["slack"]["allow"],
            json!(["chat:write", "files:write"])
        );
        assert!(vm.get("omittedBuiltinFirewalls").is_none());
        let active_runs = core.inner.active_runs.lock().await;
        assert_eq!(
            active_runs[&run_id].connectors[&target].consecutive_failures,
            0
        );
        assert!(active_runs[&run_id].refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_builtin_batch_isolates_invalid_result_identities() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry_path, targets) =
            register_tagged_builtin_runtime(&core, run_id, &["slack", "github", "linear"]).await;
        let unexpected_target = builtin_target("notion");
        let runtime_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": targets }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [
                        {
                            "target": targets[0],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["chat:write", "files:write"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                            "nextSyncAt": "2999-01-01T00:00:00Z",
                        },
                        {
                            "target": targets[1],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["first:result"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                        {
                            "target": targets[1],
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["duplicate:result"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                        {
                            "target": unexpected_target,
                            "state": "available",
                            "networkPolicy": {
                                "allow": ["unexpected:result"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                        },
                    ],
                }));
        });
        let active_targets = targets
            .iter()
            .cloned()
            .map(|target| ConnectorRefreshTarget {
                target,
                generation: 0,
            })
            .collect::<Vec<_>>();

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &active_targets)
                .await
        );

        runtime_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let policies = &registry_json["vms"]["10.200.0.2"]["networkPolicies"];
        assert_eq!(
            policies["slack"]["allow"],
            json!(["chat:write", "files:write"])
        );
        assert_eq!(policies["github"]["allow"], json!(["last-known-good"]));
        assert_eq!(policies["linear"]["allow"], json!(["last-known-good"]));

        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&targets[0]].consecutive_failures, 0);
        assert_eq!(active.connectors[&targets[1]].consecutive_failures, 1);
        assert_eq!(active.connectors[&targets[2]].consecutive_failures, 1);
        assert!(active.refresh_tasks.contains_key(&targets[0]));
        assert!(active.refresh_tasks.contains_key(&targets[1]));
        assert!(active.refresh_tasks.contains_key(&targets[2]));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_batch_keeps_current_target_when_another_generation_is_superseded() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry_path, targets) =
            register_tagged_builtin_runtime(&core, run_id, &["slack", "github"]).await;
        let stale_batch = targets
            .iter()
            .cloned()
            .map(|target| ConnectorRefreshTarget {
                target,
                generation: 0,
            })
            .collect::<Vec<_>>();
        let github_target = targets[1].clone();
        let runtime_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [github_target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": github_target,
                        "state": "available",
                        "networkPolicy": {
                            "allow": ["issues:write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                    }],
                }));
        });

        core.notify_connector_runtime_sync(run_id, targets[0].clone())
            .await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &stale_batch)
                .await
        );

        runtime_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        assert_eq!(
            registry_json["vms"]["10.200.0.2"]["networkPolicies"]["github"]["allow"],
            json!(["issues:write"])
        );
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_custom_target_registers_while_absent_and_restores_from_sync() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let absent_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "absent",
                        "reason": "grant-unavailable",
                    }],
                }));
        });
        let firewall = custom_runtime_firewall(custom_connector_id);
        let empty_firewalls = Vec::new();
        let empty_policies = HashMap::new();
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &empty_firewalls, &empty_policies).await;

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::new(),
            targets: Some(std::slice::from_ref(&runtime_target_registration(&target))),
            refreshes: None,
        })
        .await;
        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.targets[0].target, target);

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );
        absent_sync.assert_calls(1);
        let absent_registry: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        assert_eq!(
            absent_registry["vms"]["10.200.0.2"]["omittedCustomConnectorIds"],
            json!([custom_connector_id])
        );
        assert!(
            !core.inner.active_runs.lock().await[&run_id]
                .refresh_tasks
                .contains_key(&target)
        );

        absent_sync.delete_async().await;
        let available_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.read"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                        "nextSyncAt": "2999-01-01T00:00:00Z",
                    }],
                }));
        });
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        available_sync.assert_calls(1);
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        let vm = &registry_json["vms"]["10.200.0.2"];
        assert_eq!(
            vm["firewalls"][0]["customConnectorId"],
            json!(custom_connector_id)
        );
        assert_eq!(
            vm["networkPolicies"]["custom_connector_550e8400e29b41d4a716446655440000"]["allow"],
            json!(["custom.read"])
        );
        assert!(vm.get("omittedCustomConnectorIds").is_none());
        assert!(
            core.inner.active_runs.lock().await[&run_id]
                .refresh_tasks
                .contains_key(&target)
        );
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_custom_target_pins_first_routing_values_and_forwards_them_after_wakeup() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let registration = runtime_target_registration(&target);
        let firewall = custom_runtime_firewall(custom_connector_id);
        let base_url_vars = HashMap::from([("subdomain".to_string(), "acme".to_string())]);
        let first_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": [target.clone()] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.read"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                        "baseUrlVars": base_url_vars,
                    }],
                }));
        });
        let empty_firewalls = Vec::new();
        let empty_policies = HashMap::new();
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &empty_firewalls, &empty_policies).await;

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::new(),
            targets: Some(std::slice::from_ref(&registration)),
            refreshes: None,
        })
        .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        first_sync.assert_calls(1);
        assert_eq!(
            core.inner.active_runs.lock().await[&run_id].connectors[&target].pinned_base_url_vars,
            Some(base_url_vars.clone())
        );
        let registry_after_available = tokio::fs::read(&registry_path).await.unwrap();
        let registry_json: serde_json::Value =
            serde_json::from_slice(&registry_after_available).unwrap();
        assert_eq!(
            registry_json["vms"]["10.200.0.2"]["connectorRoutingVariables"]
                [format!("custom:{custom_connector_id}")],
            json!(base_url_vars)
        );

        first_sync.delete_async().await;
        let unresolved_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{
                        "kind": "custom",
                        "customConnectorId": custom_connector_id,
                        "baseUrlVars": base_url_vars,
                    }],
                }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "unresolved",
                        "reason": "runtime-configuration-unavailable",
                    }],
                }));
        });
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        unresolved_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_after_available
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(
            active.connectors[&target].pinned_base_url_vars,
            Some(base_url_vars)
        );
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_custom_target_accepts_old_api_result_without_routing_metadata() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let pinned_base_url_vars = HashMap::from([("subdomain".to_string(), "acme".to_string())]);
        let registration = ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: Some(pinned_base_url_vars.clone()),
        };
        let firewall = custom_runtime_firewall(custom_connector_id);
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{
                        "kind": "custom",
                        "customConnectorId": custom_connector_id,
                        "baseUrlVars": pinned_base_url_vars,
                    }],
                }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "deny",
                        },
                    }],
                }));
        });
        let initial_firewall = custom_runtime_firewall(custom_connector_id);
        let firewall_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let initial_policies = HashMap::from([(
            firewall_name.clone(),
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let firewalls = vec![initial_firewall];
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &initial_policies).await;

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::new(),
            targets: Some(std::slice::from_ref(&registration)),
            refreshes: None,
        })
        .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        let registry_json: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(registry_path).await.unwrap()).unwrap();
        assert_eq!(
            registry_json["vms"]["10.200.0.2"]["networkPolicies"][firewall_name]["allow"],
            json!(["custom.write"])
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(
            active.connectors[&target].pinned_base_url_vars,
            Some(pinned_base_url_vars)
        );
        assert_eq!(active.connectors[&target].consecutive_failures, 0);
        assert!(!active.refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_custom_target_rejects_routing_value_replacement() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let pinned_base_url_vars = HashMap::from([("subdomain".to_string(), "acme".to_string())]);
        let replacement_base_url_vars =
            HashMap::from([("subdomain".to_string(), "other".to_string())]);
        let registration = ConnectorRuntimeTargetRegistration::Custom {
            custom_connector_id: custom_connector_id.to_string(),
            base_url_vars: Some(pinned_base_url_vars.clone()),
        };
        let firewall = custom_runtime_firewall(custom_connector_id);
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({
                    "targets": [{
                        "kind": "custom",
                        "customConnectorId": custom_connector_id,
                        "baseUrlVars": pinned_base_url_vars,
                    }],
                }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": firewall,
                        "networkPolicy": {
                            "allow": ["custom.write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                        "baseUrlVars": replacement_base_url_vars,
                    }],
                }));
        });
        let initial_firewall = custom_runtime_firewall(custom_connector_id);
        let initial_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let initial_policies = HashMap::from([(
            initial_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let firewalls = vec![initial_firewall];
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &initial_policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::new(),
            targets: Some(std::slice::from_ref(&registration)),
            refreshes: None,
        })
        .await;
        let request = recv_refresh_request(&mut requests).await;
        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(
            active.connectors[&target].pinned_base_url_vars,
            Some(pinned_base_url_vars)
        );
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn invalid_tagged_custom_response_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let initial_firewall = custom_runtime_firewall(custom_connector_id);
        let initial_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let initial_policies = HashMap::from([(
            initial_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let invalid_firewall = custom_runtime_firewall("550e8400-e29b-41d4-a716-446655440001");
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "results": [{
                        "target": target.clone(),
                        "state": "available",
                        "firewall": invalid_firewall,
                        "networkPolicy": {
                            "allow": ["custom.write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                    }],
                }));
        });
        let firewalls = vec![initial_firewall];
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &initial_policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::new(),
            targets: Some(std::slice::from_ref(&runtime_target_registration(&target))),
            refreshes: None,
        })
        .await;
        let request = recv_refresh_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn old_api_fallback_refreshes_builtin_without_short_retry_loop() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let target = builtin_target("slack");
        let tagged_route = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(404);
        });
        let legacy_route = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"))
                .json_body(json!({ "connectorSlugs": ["slack"] }));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "refreshes": [{
                        "connectorSlug": "slack",
                        "networkPolicy": {
                            "allow": ["chat:write", "files:write"],
                            "deny": [],
                            "ask": [],
                            "unknownPolicy": "allow",
                        },
                        "nextRefreshAt": "2999-01-01T00:00:00Z",
                    }],
                }));
        });
        let firewalls = vec![FirewallEntry::Builtin {
            name: "slack".to_string(),
            base_url_vars: None,
        }];
        let policies = HashMap::from([(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec!["files:write".to_string()],
                ask: vec![],
                unknown_policy: "allow".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::from(["slack".to_string()]),
            targets: Some(std::slice::from_ref(&runtime_target_registration(&target))),
            refreshes: None,
        })
        .await;
        core.notify_connector_runtime_sync(run_id, target.clone())
            .await;
        let request = recv_refresh_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        tagged_route.assert_calls(1);
        legacy_route.assert_calls(1);
        let registry_json: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(registry_path).await.unwrap()).unwrap();
        assert_eq!(
            registry_json["vms"]["10.200.0.2"]["networkPolicies"]["slack"]["allow"],
            json!(["chat:write", "files:write"])
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 0);
        assert!(active.refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn old_api_fallback_retains_custom_last_known_good_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let custom_connector_id = "550e8400-e29b-41d4-a716-446655440000";
        let target = custom_target(custom_connector_id);
        let tagged_route = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(404);
        });
        let firewall = custom_runtime_firewall(custom_connector_id);
        let firewall_name = format!("custom_connector_{}", custom_connector_id.replace('-', ""));
        let firewalls = vec![firewall];
        let policies = HashMap::from([(
            firewall_name,
            NetworkPolicy {
                allow: vec!["custom.read".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "deny".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &firewalls, &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::new(),
            targets: Some(std::slice::from_ref(&runtime_target_registration(&target))),
            refreshes: None,
        })
        .await;
        let request = recv_refresh_request(&mut requests).await;

        assert!(
            core.sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        tagged_route.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before
        );
        let active_runs = core.inner.active_runs.lock().await;
        let active = &active_runs[&run_id];
        assert_eq!(active.connectors[&target].consecutive_failures, 1);
        assert!(active.refresh_tasks.contains_key(&target));
        drop(active_runs);
        core.unregister_run(run_id).await;
    }

    #[tokio::test]
    async fn tagged_terminal_builtin_keeps_policy_without_matching_firewall() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let target = builtin_target("slack");
        let terminal_sync = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"));
            then.status(409)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                        "message": "Run is terminal",
                    },
                }));
        });
        let policies = HashMap::from([(
            "slack".to_string(),
            NetworkPolicy {
                allow: vec!["chat:write".to_string()],
                deny: vec![],
                ask: vec![],
                unknown_policy: "allow".to_string(),
            },
        )]);
        let (_dir, registry, registry_path) =
            registered_runtime_registry(run_id, &[], &policies).await;
        let registry_before = tokio::fs::read(&registry_path).await.unwrap();

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::from(["slack".to_string()]),
            targets: Some(std::slice::from_ref(&runtime_target_registration(&target))),
            refreshes: None,
        })
        .await;
        core.notify_connector_runtime_sync(run_id, target).await;
        let request = recv_refresh_request(&mut requests).await;

        assert!(
            !core
                .sync_connector_runtime_batch_now(run_id, &request.targets)
                .await
        );

        terminal_sync.assert_calls(1);
        assert_eq!(
            tokio::fs::read(&registry_path).await.unwrap(),
            registry_before,
            "builtin terminal reconciliation must keep the legacy firewall guard",
        );
        assert!(!core.inner.active_runs.lock().await.contains_key(&run_id));
    }

    #[tokio::test]
    async fn inactive_network_policy_notification_is_not_enqueued() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);

        core.notify_network_policy_refresh(RunId::nil(), "slack".to_string())
            .await;

        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn active_network_policy_notification_schedules_immediate_refresh() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(registry));

        core.notify_network_policy_refresh(run_id, "slack".to_string())
            .await;

        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(target_connector_slugs(&request.targets), vec!["slack"]);
        assert_eq!(request.targets[0].generation, 1);
    }

    #[tokio::test]
    async fn cancelled_network_policy_notification_does_not_wait_for_queue_capacity() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }
        let cancel = CancellationToken::new();
        cancel.cancel();

        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_network_policy_refresh_until_cancelled(
                run_id,
                "slack".to_string(),
                &cancel,
            ),
        )
        .await
        .expect("cancelled notification should not wait for queue capacity");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id).expect("run should remain active");
        assert_eq!(active.connectors[&builtin_target("slack")].generation, 0);
        assert!(active.refresh_tasks.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn full_queue_notification_preserves_policy_and_retries_without_registry_lock() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }
        let lock_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");
        let policy_before = tokio::fs::read_to_string(&registry_path)
            .await
            .expect("registry should be readable before notification");

        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_network_policy_refresh(run_id, "slack".to_string()),
        )
        .await
        .expect("notification should not wait for queue capacity or registry lock");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| {
                        active.connectors[&builtin_target("slack")].consecutive_failures == 1
                            && active.refresh_tasks.contains_key(&builtin_target("slack"))
                    })
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue saturation should install a retry");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        assert_eq!(
            tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
            policy_before
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
        drop(lock_guard);
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_refresh_task_clears_itself_after_firing() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(registry));

        replace_schedule(&core, run_id, "slack", "1970-01-01T00:00:00.000Z").await;
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        tokio::time::advance(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY).await;
        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(target_connector_slugs(&request.targets), vec!["slack"]);
        wait_until_scheduled_refresh_task_clears(&core, run_id).await;
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active after scheduled refresh fires");
        assert!(active.refresh_tasks.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_refresh_coalesces_due_connectors_for_run() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner.active_runs.lock().await.insert(
            run_id,
            active_run_network_policy_state_with_connectors(registry, ["slack", "github"]),
        );

        for connector_slug in ["slack", "github"] {
            replace_schedule(&core, run_id, connector_slug, "1970-01-01T00:00:00.000Z").await;
        }
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        tokio::time::advance(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY).await;
        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(
            target_connector_slugs(&request.targets),
            vec!["github", "slack"]
        );
        wait_until_scheduled_refresh_task_clears(&core, run_id).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn retry_backoff_preserves_same_run_coalescing_and_caps_delay() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner.active_runs.lock().await.insert(
            run_id,
            active_run_network_policy_state_with_connectors(registry, ["slack", "github"]),
        );
        let targets = core
            .current_refresh_targets(run_id, vec!["slack".to_string(), "github".to_string()])
            .await;

        let first_base = tokio::time::Instant::now();
        core.schedule_refresh_retries(run_id, &targets, "test_failure")
            .await;
        {
            let active_runs = core.inner.active_runs.lock().await;
            let active = &active_runs[&run_id];
            assert_eq!(
                active.refresh_tasks[&builtin_target("slack")].deadline,
                active.refresh_tasks[&builtin_target("github")].deadline,
                "same-run connectors at the same attempt should remain coalescible"
            );
            let first_delay = active.refresh_tasks[&builtin_target("slack")].deadline - first_base;
            assert!(first_delay >= Duration::from_millis(800));
            assert!(first_delay <= REFRESH_RETRY_INITIAL_DELAY);
        }

        let slack_target = targets
            .iter()
            .find(|target| target.target == builtin_target("slack"))
            .expect("slack target should exist")
            .clone();
        for expected_attempt in 2..=7 {
            let scheduling_base = tokio::time::Instant::now();
            core.schedule_refresh_retries(
                run_id,
                std::slice::from_ref(&slack_target),
                "test_failure",
            )
            .await;
            let active_runs = core.inner.active_runs.lock().await;
            let active = &active_runs[&run_id];
            assert_eq!(
                active.connectors[&builtin_target("slack")].consecutive_failures,
                expected_attempt
            );
            if expected_attempt >= 6 {
                let delay =
                    active.refresh_tasks[&builtin_target("slack")].deadline - scheduling_base;
                assert!(delay >= Duration::from_secs(24));
                assert!(delay <= REFRESH_RETRY_MAX_DELAY);
            }
        }

        let distinct_run_delays = (1_u128..=16)
            .map(|value| refresh_retry_delay(RunId::from(uuid::Uuid::from_u128(value)), 1))
            .collect::<HashSet<_>>();
        assert!(
            distinct_run_delays.len() > 1,
            "deterministic jitter should spread different runs"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn unregister_cancels_scheduled_refresh_before_deadline() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }

        replace_schedule(&core, run_id, "slack", "1970-01-01T00:00:00.000Z").await;
        assert!(
            core.inner
                .active_runs
                .lock()
                .await
                .get(&run_id)
                .is_some_and(|active| active.refresh_tasks.len() == 1),
            "scheduled task should remain tracked while waiting on the full refresh queue"
        );

        core.unregister_run(run_id).await;
        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn scheduled_refresh_full_queue_preserves_policy_and_retries() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }
        let policy_before = tokio::fs::read_to_string(&registry_path)
            .await
            .expect("registry should be readable before scheduled refresh");
        let lock_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");

        replace_schedule(&core, run_id, "slack", "1970-01-01T00:00:00.000Z").await;
        tokio::time::advance(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY).await;

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| {
                        active.connectors[&builtin_target("slack")].consecutive_failures == 1
                            && active.refresh_tasks.contains_key(&builtin_target("slack"))
                    })
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("queue saturation should replace the due task with a retry");
        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        assert_eq!(
            tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
            policy_before
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
        drop(lock_guard);
    }

    #[tokio::test]
    async fn mismatched_network_policy_refresh_retains_last_known_good_and_retries() {
        let (_, events) = capture_network_policy_events(
            assert_mismatched_network_policy_refresh_retains_last_known_good(),
        )
        .await;

        let unexpected = captured_event(
            &events,
            "network policy refresh returned unexpected connector",
        );
        assert_connector_field(unexpected, "response_connector_slug", "github");
        assert_connector_field(unexpected, "requested_connector_slugs", "[\"slack\"]");
        assert_connector_field(
            captured_event(
                &events,
                "network policy refresh response omitted requested connector",
            ),
            "connector_slug",
            "slack",
        );
        let retry = captured_event(
            &events,
            "retained last-known-good network policy; scheduled refresh retry",
        );
        assert_connector_field(retry, "reason", "invalid_or_unpublished_response");
    }

    #[tokio::test]
    async fn failed_network_policy_refresh_retains_last_known_good_and_retries() {
        let (_, events) = capture_network_policy_events(
            assert_failed_network_policy_refresh_retains_last_known_good(),
        )
        .await;

        assert_connector_field(
            captured_event(
                &events,
                "network policy refresh failed; retaining last-known-good network policies",
            ),
            "connector_slugs",
            "[\"slack\"]",
        );
        assert_connector_field(
            captured_event(
                &events,
                "retained last-known-good network policy; scheduled refresh retry",
            ),
            "reason",
            "api_error",
        );
    }

    #[tokio::test]
    async fn terminal_network_policy_refresh_reconciles_entire_run() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let refresh_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"))
                .json_body(json!({ "connectorSlugs": ["slack"] }));
            then.status(409)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                        "message": "Run is terminal",
                    },
                }));
        });
        let harness =
            NetworkPolicyRefreshHarness::new_with_connectors(&server, run_id, &["slack", "github"])
                .await;
        let github_target = harness
            .handle
            .core
            .current_refresh_target(run_id, "github")
            .await
            .expect("active connector should have a refresh target");
        assert!(
            harness
                .handle
                .core
                .replace_schedule_deadline_if_current(
                    run_id,
                    &github_target,
                    Some(
                        parse_refresh_deadline("2999-01-01T00:00:00.000Z")
                            .expect("valid refresh deadline should parse"),
                    ),
                )
                .await,
            "active connector should accept refresh schedule"
        );
        let scheduled_task = {
            let active_runs = harness.handle.core.inner.active_runs.lock().await;
            active_runs[&run_id].refresh_tasks[&builtin_target("github")]
                .handle
                .abort_handle()
        };

        let (_, events) = capture_network_policy_events(harness.refresh_slack()).await;

        refresh_mock.assert_calls(1);
        assert_fail_closed_policy(&harness.policy("slack").await);
        assert_fail_closed_policy(&harness.policy("github").await);
        assert!(
            harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .get(&run_id)
                .is_none()
        );
        assert!(
            events.iter().all(|event| {
                event
                    .fields
                    .get("message")
                    .is_none_or(|message| message != "network policy refresh failed")
            }),
            "terminal reconciliation should not emit the generic failure warning"
        );
        assert_eq!(
            captured_event(&events, "reconciled terminal run network policies").level,
            tracing::Level::INFO
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while !scheduled_task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal reconciliation should stop scheduled refresh tasks");

        harness
            .handle
            .notify_network_policy_refresh(run_id, "slack".to_string())
            .await;
        tokio::task::yield_now().await;
        refresh_mock.assert_calls(1);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn ambiguous_network_policy_refresh_errors_retain_last_known_good() {
        for (status, body) in [
            (
                404_u16,
                json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                        "message": "Run is terminal",
                    },
                }),
            ),
            (
                403_u16,
                json!({
                    "error": {
                        "code": "FORBIDDEN",
                        "message": "Run does not belong to user",
                    },
                }),
            ),
            (
                409_u16,
                json!({
                    "error": {
                        "code": "CONFLICT",
                        "message": "unrelated conflict",
                    },
                }),
            ),
            (
                409_u16,
                json!({
                    "error": {
                        "code": "RUN_TERMINAL",
                    },
                }),
            ),
        ] {
            let server = MockServer::start();
            let run_id = RunId::nil();
            let refresh_mock = server.mock(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
                then.status(status)
                    .header("content-type", "application/json")
                    .json_body(body);
            });
            let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;

            let (_, events) = capture_network_policy_events(harness.refresh_slack()).await;

            refresh_mock.assert_calls(1);
            assert_last_known_good_policy(&harness.slack_policy().await);
            captured_event(
                &events,
                "network policy refresh failed; retaining last-known-good network policies",
            );
            assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;
            assert!(
                harness
                    .handle
                    .core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .contains_key(&run_id)
            );
            harness.shutdown().await;
        }
    }

    #[tokio::test]
    async fn newer_notification_survives_older_in_flight_refresh() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let run_id = RunId::nil();
        let harness = NetworkPolicyRefreshHarness::new_with_api(
            api_client_for_url(api_url),
            run_id,
            &["slack"],
        )
        .await;
        let (first_received_tx, first_received_rx) = tokio::sync::oneshot::channel();
        let (release_first_tx, release_first_rx) = tokio::sync::oneshot::channel();
        let server_task = tokio::spawn(async move {
            let (mut first_socket, first_request) = accept_http_request(&listener).await;
            first_received_tx
                .send(())
                .expect("first request receiver should remain available");
            release_first_rx
                .await
                .expect("first response should be released");
            let first_body = json!({
                "refreshes": [{
                    "connectorSlug": "slack",
                    "networkPolicy": {
                        "allow": ["old:read"],
                        "deny": [],
                        "ask": [],
                        "unknownPolicy": "allow",
                    },
                    "nextRefreshAt": null,
                }],
            })
            .to_string();
            let first_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                first_body.len(),
                first_body
            );
            first_socket
                .write_all(first_response.as_bytes())
                .await
                .unwrap();

            let (mut second_socket, second_request) = accept_http_request(&listener).await;
            let second_body = json!({
                "refreshes": [{
                    "connectorSlug": "slack",
                    "networkPolicy": {
                        "allow": ["new:read"],
                        "deny": [],
                        "ask": [],
                        "unknownPolicy": "allow",
                    },
                    "nextRefreshAt": null,
                }],
            })
            .to_string();
            let second_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                second_body.len(),
                second_body
            );
            second_socket
                .write_all(second_response.as_bytes())
                .await
                .unwrap();
            [first_request, second_request]
        });

        harness
            .handle
            .notify_network_policy_refresh(run_id, "slack".to_string())
            .await;
        tokio::time::timeout(Duration::from_secs(1), first_received_rx)
            .await
            .expect("first refresh should reach the API")
            .expect("first request sender should remain available");

        harness
            .handle
            .notify_network_policy_refresh(run_id, "slack".to_string())
            .await;
        assert_eq!(
            harness.handle.core.inner.active_runs.lock().await[&run_id].connectors
                [&builtin_target("slack")]
                .generation,
            2
        );
        release_first_tx
            .send(())
            .expect("first response receiver should remain available");

        let policy = wait_until_slack_policy(&harness.registry_path, |policy| {
            policy["allow"] == json!(["new:read"])
        })
        .await;
        assert_eq!(policy["unknownPolicy"], json!("allow"));
        let requests = tokio::time::timeout(Duration::from_secs(1), server_task)
            .await
            .expect("both generations should reach the API")
            .expect("API task should succeed");
        for request in &requests {
            assert_network_policy_refresh_request(request, &run_id);
        }
        let active_runs = harness.handle.core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active after newer refresh");
        assert_eq!(active.connectors[&builtin_target("slack")].generation, 2);
        assert_eq!(
            active.connectors[&builtin_target("slack")].consecutive_failures,
            0
        );
        assert!(!active.refresh_tasks.contains_key(&builtin_target("slack")));
        drop(active_runs);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn transport_network_policy_refresh_error_retries_and_recovers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let run_id = RunId::nil();
        let harness = NetworkPolicyRefreshHarness::new_with_api(
            api_client_for_url(api_url),
            run_id,
            &["slack"],
        )
        .await;
        let registry_path = harness.registry_path.clone();
        let source_ip = harness.source_ip.clone();
        let response_body = json!({
            "refreshes": [{
                "connectorSlug": "slack",
                "networkPolicy": {
                    "allow": ["chat:write", "files:write"],
                    "deny": [],
                    "ask": ["channels:read"],
                    "unknownPolicy": "allow",
                },
                "nextRefreshAt": "2999-01-01T00:00:00.000Z",
            }],
        })
        .to_string();
        let server_task = tokio::spawn(async move {
            let (first_socket, first_request) = accept_http_request(&listener).await;
            drop(first_socket);

            let (mut second_socket, second_request) = accept_http_request(&listener).await;
            let registry_json: serde_json::Value = serde_json::from_str(
                &tokio::fs::read_to_string(&registry_path)
                    .await
                    .expect("registry should be readable before retry response"),
            )
            .expect("registry should be valid JSON before retry response");
            let policy_before_retry_response =
                registry_json["vms"][&source_ip]["networkPolicies"]["slack"].clone();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            second_socket.write_all(response.as_bytes()).await.unwrap();
            (first_request, second_request, policy_before_retry_response)
        });

        let (_, events) = tokio::time::timeout(
            Duration::from_secs(1),
            capture_network_policy_events(harness.refresh_slack()),
        )
        .await
        .expect("network policy refresh retry should complete");
        let (first_request, second_request, policy_before_retry_response) =
            tokio::time::timeout(Duration::from_secs(1), server_task)
                .await
                .expect("network policy refresh server should finish")
                .expect("network policy refresh server task should succeed");

        assert_network_policy_refresh_request(&first_request, &run_id);
        assert_network_policy_refresh_request(&second_request, &run_id);
        assert_eq!(
            policy_before_retry_response,
            json!({
                "allow": ["chat:write"],
                "deny": ["files:write"],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
        assert_eq!(
            harness.slack_policy().await,
            json!({
                "allow": ["chat:write", "files:write"],
                "deny": [],
                "ask": ["channels:read"],
                "unknownPolicy": "allow",
            })
        );
        assert!(
            harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .get(&run_id)
                .is_some_and(|active| active.refresh_tasks.contains_key(&builtin_target("slack"))),
            "successful retry should install the returned refresh schedule"
        );
        let retry = captured_event(&events, "network policy refresh transport failed, retrying");
        assert_connector_field(retry, "connector_slugs", "[\"slack\"]");
        assert_connector_field(retry, "attempt", "1");
        assert_connector_field(retry, "max_attempts", "2");
        assert_connector_field(retry, "will_retry", "true");
        for field in ["failure_kind", "client_request_id", "client_session_id"] {
            assert!(
                retry
                    .fields
                    .get(field)
                    .is_some_and(|value| !value.is_empty()),
                "retry event should include {field}: {retry:#?}"
            );
        }
        for message in [
            "network policy refresh failed; retaining last-known-good network policies",
            "retained last-known-good network policy; scheduled refresh retry",
        ] {
            assert!(
                events.iter().all(|event| {
                    event
                        .fields
                        .get("message")
                        .is_none_or(|actual| actual != message)
                }),
                "successful retry should not emit {message}: {events:#?}"
            );
        }
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn persistent_transport_failure_retains_policy_and_scheduled_retry_recovers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let run_id = RunId::nil();
        let harness = NetworkPolicyRefreshHarness::new_with_api(
            api_client_for_url(api_url),
            run_id,
            &["slack"],
        )
        .await;
        let response_body = network_policy_refresh_response(json!({
            "connectorSlug": "slack",
        }))
        .to_string();
        let server_task = tokio::spawn(async move {
            let (first_socket, first_request) = accept_http_request(&listener).await;
            drop(first_socket);
            let (second_socket, second_request) = accept_http_request(&listener).await;
            drop(second_socket);
            let (mut third_socket, third_request) = accept_http_request(&listener).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            third_socket.write_all(response.as_bytes()).await.unwrap();
            [first_request, second_request, third_request]
        });

        let (_, events) = tokio::time::timeout(
            Duration::from_secs(1),
            capture_network_policy_events(harness.refresh_slack()),
        )
        .await
        .expect("persistent network policy refresh failure should complete");

        assert_last_known_good_policy(&harness.slack_policy().await);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;
        let retry_deadline = harness.handle.core.inner.active_runs.lock().await[&run_id]
            .refresh_tasks[&builtin_target("slack")]
            .deadline;
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.fields.get("message").is_some_and(|message| {
                        message == "network policy refresh transport failed, retrying"
                    })
                })
                .count(),
            1,
            "persistent failure should retry immediately exactly once: {events:#?}"
        );
        let failure = captured_event(
            &events,
            "network policy refresh failed; retaining last-known-good network policies",
        );
        assert_connector_field(failure, "transport_retry_attempted", "true");
        assert_connector_field(
            captured_event(
                &events,
                "retained last-known-good network policy; scheduled refresh retry",
            ),
            "reason",
            "api_error",
        );

        tokio::time::sleep_until(retry_deadline).await;
        let recovered_policy = wait_until_slack_policy(&harness.registry_path, |policy| {
            policy["allow"] == json!(["chat:write", "files:write"])
        })
        .await;
        assert_eq!(recovered_policy["unknownPolicy"], json!("allow"));
        let [first_request, second_request, third_request] =
            tokio::time::timeout(Duration::from_secs(1), server_task)
                .await
                .expect("network policy refresh server should finish after scheduled retry")
                .expect("network policy refresh server task should succeed");
        for request in [&first_request, &second_request, &third_request] {
            assert_network_policy_refresh_request(request, &run_id);
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if harness
                    .handle
                    .core
                    .inner
                    .active_runs
                    .lock()
                    .await
                    .get(&run_id)
                    .is_some_and(|active| {
                        active.connectors[&builtin_target("slack")].consecutive_failures == 0
                            && !active.refresh_tasks.contains_key(&builtin_target("slack"))
                    })
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("successful recovery should reset retry state");
        let active_runs = harness.handle.core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active after recovery");
        assert_eq!(
            active.connectors[&builtin_target("slack")].consecutive_failures,
            0
        );
        assert!(
            !active.refresh_tasks.contains_key(&builtin_target("slack")),
            "null nextRefreshAt should clear the retry schedule"
        );
        drop(active_runs);
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn successful_network_policy_refresh_ignores_additional_response_fields() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let refresh_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "refreshes": [{
                        "connectorSlug": "slack",
                        "networkPolicy": {
                            "allow": ["chat:write"],
                            "deny": ["files:write"],
                            "ask": ["channels:read"],
                            "unknownPolicy": "allow",
                        },
                        "nextRefreshAt": null,
                        "additionalField": true,
                    }],
                }));
        });
        let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;

        let (_, events) = capture_network_policy_events(harness.refresh_slack()).await;

        refresh_mock.assert_calls(1);
        assert_connector_field(
            captured_event(
                &events,
                "patched connector network policy in proxy registry",
            ),
            "connector_slug",
            "slack",
        );
        assert_connector_field(
            captured_event(&events, "refreshed network policy"),
            "connector_slug",
            "slack",
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn stale_registry_ownership_stops_refresh_without_retry() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let refresh_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(network_policy_refresh_response(json!({
                    "connectorSlug": "slack",
                })));
        });
        let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;
        let registry = ProxyRegistryHandle::new(
            harness.registry_path.clone(),
            harness._dir.path().join("registry.lock"),
        );
        registry
            .unregister_vm(&harness.source_ip)
            .await
            .expect("replacement ownership should remove the old VM");

        harness.refresh_slack().await;

        refresh_mock.assert_calls(1);
        assert!(
            !harness
                .handle
                .core
                .inner
                .active_runs
                .lock()
                .await
                .contains_key(&run_id),
            "stale registry ownership should stop all refresh tracking"
        );
        harness.shutdown().await;
    }

    #[tokio::test]
    async fn malformed_canonical_network_policy_refresh_identities_retain_last_known_good() {
        for (_, identity) in [
            ("missing identity", json!({})),
            (
                "invalid canonical identity",
                json!({
                    "connectorSlug": null,
                }),
            ),
            (
                "empty canonical identity",
                json!({
                    "connectorSlug": "",
                }),
            ),
        ] {
            let server = MockServer::start();
            let run_id = RunId::nil();
            let refresh_mock = server.mock(|when, then| {
                when.method(POST)
                    .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
                then.status(200)
                    .header("content-type", "application/json")
                    .json_body(network_policy_refresh_response(identity));
            });
            let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;

            harness.refresh_slack().await;

            refresh_mock.assert_calls(1);
            let policy = harness.slack_policy().await;
            assert_last_known_good_policy(&policy);
            assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;
            harness.shutdown().await;
        }
    }

    #[tokio::test]
    async fn duplicate_network_policy_refresh_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let refresh_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "refreshes": [
                        {
                            "connectorSlug": "slack",
                            "networkPolicy": {
                                "allow": ["chat:write", "files:write"],
                                "deny": [],
                                "ask": ["channels:read"],
                                "unknownPolicy": "allow",
                            },
                            "nextRefreshAt": null,
                        },
                        {
                            "connectorSlug": "slack",
                            "networkPolicy": {
                                "allow": ["channels:read"],
                                "deny": ["files:write"],
                                "ask": ["chat:write"],
                                "unknownPolicy": "ask",
                            },
                            "nextRefreshAt": null,
                        },
                    ],
                }));
        });

        let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;
        harness.refresh_slack().await;
        refresh_mock.assert_calls(1);
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn invalid_network_policy_refresh_deadline_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "refreshes": [
                        {
                            "connectorSlug": "slack",
                            "networkPolicy": {
                                "allow": ["chat:write", "files:write"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                            "nextRefreshAt": "not-a-date",
                        },
                    ],
                }));
        });

        let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;
        harness.refresh_slack().await;
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }

    #[tokio::test]
    async fn registry_patch_error_retains_last_known_good_and_retries() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let refresh_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(network_policy_refresh_response(json!({
                    "connectorSlug": "slack",
                })));
        });
        let (core, _requests) = core_without_worker(&server);
        let (dir, _registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        let invalid_lock_path = dir.path().join("invalid-registry-lock");
        tokio::fs::create_dir(&invalid_lock_path)
            .await
            .expect("invalid lock path directory should be created");
        let failing_registry = ProxyRegistryHandle::new(registry_path.clone(), invalid_lock_path);
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_network_policy_state(failing_registry));
        let registry_before = tokio::fs::read_to_string(&registry_path)
            .await
            .expect("registry should be readable before refresh");

        let (_, events) = capture_network_policy_events(
            core.refresh_network_policies_now(run_id, vec!["slack".to_string()]),
        )
        .await;

        refresh_mock.assert_calls(1);
        assert_eq!(
            tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable after patch failure"),
            registry_before
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
        assert_connector_field(
            captured_event(
                &events,
                "retained last-known-good network policy; scheduled refresh retry",
            ),
            "reason",
            "invalid_or_unpublished_response",
        );
    }

    #[tokio::test]
    async fn invalid_initial_network_policy_refresh_deadline_preserves_policy_and_retries() {
        let server = MockServer::start();
        let (core, _requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        let refreshes = HashMap::from([(
            "slack".to_string(),
            NetworkPolicyRefresh {
                next_refresh_at: "not-a-date".to_string(),
            },
        )]);

        core.register_run(NetworkPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_slugs: HashSet::from(["slack".to_string()]),
            targets: None,
            refreshes: Some(&refreshes),
        })
        .await;

        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&registry_path)
                .await
                .expect("registry should remain readable"),
        )
        .expect("registry should remain valid JSON");
        assert_last_known_good_policy(
            &registry_json["vms"]["10.200.0.2"]["networkPolicies"]["slack"],
        );
        assert_retry_scheduled(&core, run_id, "slack", 1).await;
    }

    #[tokio::test]
    async fn network_policy_refresh_splits_batches_to_match_api_contract() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let connector_slugs = (0..=NETWORK_POLICY_REFRESH_BATCH_MAX)
            .map(|index| format!("connector-{index}"))
            .collect::<Vec<_>>();
        let first_batch = connector_slugs[..NETWORK_POLICY_REFRESH_BATCH_MAX].to_vec();
        let second_batch = connector_slugs[NETWORK_POLICY_REFRESH_BATCH_MAX..].to_vec();
        let first_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"))
                .json_body(json!({ "connectorSlugs": first_batch }));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "refresh failed",
                    },
                }));
        });
        let second_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"))
                .json_body(json!({ "connectorSlugs": second_batch }));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "refresh failed",
                    },
                }));
        });
        let (core, _requests) = core_without_worker(&server);
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"vms":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let registry = ProxyRegistryHandle::new(registry_path, dir.path().join("registry.lock"));
        core.inner.active_runs.lock().await.insert(
            run_id,
            active_run_network_policy_state_with_connectors(registry, connector_slugs.clone()),
        );

        core.refresh_network_policies_now(run_id, connector_slugs)
            .await;

        first_mock.assert_calls(1);
        second_mock.assert_calls(1);
    }

    #[tokio::test]
    async fn connector_runtime_sync_splits_batches_without_limiting_run_targets() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let connector_slugs = (0..=CONNECTOR_RUNTIME_SYNC_BATCH_MAX)
            .map(|index| format!("connector-{index}"))
            .collect::<Vec<_>>();
        let targets = connector_slugs
            .iter()
            .map(|connector_slug| builtin_target(connector_slug))
            .collect::<Vec<_>>();
        let first_batch = targets[..CONNECTOR_RUNTIME_SYNC_BATCH_MAX].to_vec();
        let second_batch = targets[CONNECTOR_RUNTIME_SYNC_BATCH_MAX..].to_vec();
        let first_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": first_batch }));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "sync failed",
                    },
                }));
        });
        let second_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/connector-runtime/sync"))
                .json_body(json!({ "targets": second_batch }));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "sync failed",
                    },
                }));
        });
        let (core, _requests) = core_without_worker(&server);
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry_path = dir.path().join("proxy-registry.json");
        tokio::fs::write(&registry_path, br#"{"vms":{},"updatedAt":0}"#)
            .await
            .expect("empty registry should be written");
        let registry = ProxyRegistryHandle::new(registry_path, dir.path().join("registry.lock"));
        let mut active_run =
            active_run_network_policy_state_with_connectors(registry, connector_slugs.clone());
        active_run.tagged = true;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run);

        core.refresh_network_policies_now(run_id, connector_slugs)
            .await;

        first_mock.assert_calls(1);
        second_mock.assert_calls(1);
        core.unregister_run(run_id).await;
    }

    async fn assert_failed_network_policy_refresh_retains_last_known_good() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "refresh failed",
                    },
                }));
        });

        let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;
        harness.refresh_slack().await;
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }

    async fn assert_mismatched_network_policy_refresh_retains_last_known_good() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "refreshes": [
                        {
                            "connectorSlug": "github",
                            "networkPolicy": {
                                "allow": ["repos:read"],
                                "deny": [],
                                "ask": [],
                                "unknownPolicy": "allow",
                            },
                            "nextRefreshAt": null,
                        },
                    ],
                }));
        });

        let harness = NetworkPolicyRefreshHarness::new(&server, run_id).await;
        harness.refresh_slack().await;
        let policy = harness.slack_policy().await;
        assert_last_known_good_policy(&policy);
        assert_retry_scheduled(&harness.handle.core, run_id, "slack", 1).await;

        harness.shutdown().await;
    }
}
