//! Runtime connector policy refresh for active API-backed runs.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::api::ApiClient;
use crate::ids::RunId;
use crate::proxy::ProxyRegistryHandle;
use crate::types::{ConnectorPolicyRefresh, NetworkPolicy};

const REFRESH_REQUEST_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
pub(crate) struct ConnectorPolicyRefreshHandle {
    inner: Arc<ConnectorPolicyRefreshState>,
    request_tx: mpsc::Sender<RefreshRequest>,
}

struct ConnectorPolicyRefreshState {
    api: ApiClient,
    active_runs: Mutex<HashMap<RunId, ActiveRunPolicyState>>,
    cancel: CancellationToken,
}

struct ActiveRunPolicyState {
    source_ip: String,
    registry: ProxyRegistryHandle,
    connector_refs: HashSet<String>,
    cancel: CancellationToken,
    refresh_tasks: HashMap<String, tokio::task::JoinHandle<()>>,
}

#[derive(Clone)]
struct ActiveRunPolicySnapshot {
    source_ip: String,
    registry: ProxyRegistryHandle,
}

pub(crate) struct ConnectorPolicyRefreshRegistration<'a> {
    pub(crate) run_id: RunId,
    pub(crate) source_ip: &'a str,
    pub(crate) registry: ProxyRegistryHandle,
    pub(crate) connector_refs: HashSet<String>,
    pub(crate) refreshes: Option<&'a HashMap<String, ConnectorPolicyRefresh>>,
}

#[derive(Clone, Copy)]
enum RefreshTrigger {
    Notification,
    Scheduled,
}

struct RefreshRequest {
    run_id: RunId,
    connector_ref: String,
    trigger: RefreshTrigger,
}

impl RefreshTrigger {
    fn fail_closed_on_error(self) -> bool {
        matches!(self, Self::Scheduled)
    }
}

impl ConnectorPolicyRefreshHandle {
    pub(super) fn new(api: ApiClient) -> Self {
        let (request_tx, request_rx) = mpsc::channel(REFRESH_REQUEST_QUEUE_CAPACITY);
        let handle = Self {
            inner: Arc::new(ConnectorPolicyRefreshState {
                api,
                active_runs: Mutex::new(HashMap::new()),
                cancel: CancellationToken::new(),
            }),
            request_tx,
        };
        tokio::spawn(run_refresh_worker(handle.clone(), request_rx));
        handle
    }

    pub(crate) async fn shutdown(&self) {
        self.inner.cancel.cancel();
        let old_runs = std::mem::take(&mut *self.inner.active_runs.lock().await);
        for old in old_runs.into_values() {
            old.cancel.cancel();
            abort_tasks(old.refresh_tasks.into_values());
        }
    }

    pub(crate) async fn register_run(&self, registration: ConnectorPolicyRefreshRegistration<'_>) {
        if registration.connector_refs.is_empty() {
            self.unregister_run(registration.run_id).await;
            return;
        }
        let initial_refresh_connector_refs: Vec<String> =
            registration.connector_refs.iter().cloned().collect();

        let mut old_tasks = Vec::new();
        {
            let mut active_runs = self.inner.active_runs.lock().await;
            if let Some(old) = active_runs.remove(&registration.run_id) {
                old.cancel.cancel();
                old_tasks.extend(old.refresh_tasks.into_values());
            }

            active_runs.insert(
                registration.run_id,
                ActiveRunPolicyState {
                    source_ip: registration.source_ip.to_string(),
                    registry: registration.registry,
                    connector_refs: registration.connector_refs,
                    cancel: CancellationToken::new(),
                    refresh_tasks: HashMap::new(),
                },
            );
        }
        abort_tasks(old_tasks);

        if let Some(refreshes) = registration.refreshes {
            for (connector_ref, refresh) in refreshes {
                self.replace_schedule(
                    registration.run_id,
                    connector_ref,
                    Some(refresh.next_refresh_at.clone()),
                )
                .await;
            }
        }

        for connector_ref in initial_refresh_connector_refs {
            self.try_enqueue_refresh(RefreshRequest {
                run_id: registration.run_id,
                connector_ref,
                trigger: RefreshTrigger::Notification,
            });
        }
    }

    pub(crate) async fn unregister_run(&self, run_id: RunId) {
        let old = self.inner.active_runs.lock().await.remove(&run_id);
        if let Some(old) = old {
            old.cancel.cancel();
            abort_tasks(old.refresh_tasks.into_values());
        }
    }

    pub(crate) async fn notify_permission_refresh(&self, run_id: RunId, connector_ref: String) {
        self.enqueue_refresh(RefreshRequest {
            run_id,
            connector_ref,
            trigger: RefreshTrigger::Notification,
        })
        .await;
    }

    async fn enqueue_refresh(&self, request: RefreshRequest) {
        if let Err(error) = self.request_tx.send(request).await {
            warn!(error = %error, "connector policy refresh queue closed");
        }
    }

    fn try_enqueue_refresh(&self, request: RefreshRequest) {
        if let Err(error) = self.request_tx.try_send(request) {
            warn!(error = %error, "connector policy refresh queue unavailable");
        }
    }

    async fn refresh_connector_now(
        &self,
        run_id: RunId,
        connector_ref: String,
        trigger: RefreshTrigger,
    ) {
        let Some(snapshot) = self.active_snapshot(run_id, &connector_ref).await else {
            return;
        };

        let response = match self
            .inner
            .api
            .refresh_connector_policy(run_id, &connector_ref)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    connector_ref,
                    error = %error,
                    "connector policy refresh failed"
                );
                if trigger.fail_closed_on_error() {
                    fail_closed_connector_policy(run_id, &connector_ref, snapshot).await;
                }
                return;
            }
        };

        if response.connector_ref != connector_ref {
            warn!(
                run_id = %run_id,
                requested_connector_ref = connector_ref,
                response_connector_ref = response.connector_ref,
                "connector policy refresh returned mismatched connector"
            );
            return;
        }

        let Some(snapshot) = self.active_snapshot(run_id, &connector_ref).await else {
            return;
        };
        match patch_connector_policy(run_id, &connector_ref, snapshot, response.network_policy)
            .await
        {
            Ok(true) => {
                info!(
                    run_id = %run_id,
                    connector_ref,
                    "refreshed connector policy"
                );
                self.replace_schedule(run_id, &connector_ref, response.next_refresh_at)
                    .await;
            }
            Ok(false) => {
                self.unregister_run(run_id).await;
            }
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    connector_ref,
                    error = %error,
                    "failed to patch refreshed connector policy"
                );
                if trigger.fail_closed_on_error()
                    && let Some(snapshot) = self.active_snapshot(run_id, &connector_ref).await
                {
                    fail_closed_connector_policy(run_id, &connector_ref, snapshot).await;
                }
            }
        }
    }

    async fn active_snapshot(
        &self,
        run_id: RunId,
        connector_ref: &str,
    ) -> Option<ActiveRunPolicySnapshot> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        active
            .connector_refs
            .contains(connector_ref)
            .then(|| ActiveRunPolicySnapshot {
                source_ip: active.source_ip.clone(),
                registry: active.registry.clone(),
            })
    }

    async fn replace_schedule(
        &self,
        run_id: RunId,
        connector_ref: &str,
        next_refresh_at: Option<String>,
    ) {
        let deadline = next_refresh_at.as_deref().and_then(parse_refresh_deadline);
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return;
        };
        if !active.connector_refs.contains(connector_ref) {
            return;
        }

        if let Some(old) = active.refresh_tasks.remove(connector_ref) {
            old.abort();
        }
        let Some(deadline) = deadline else {
            return;
        };

        let cancel = active.cancel.clone();
        let connector_ref = connector_ref.to_string();
        let handle = self.clone();
        let task_connector_ref = connector_ref.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {}
                () = tokio::time::sleep_until(deadline) => {
                    handle
                        .enqueue_refresh(RefreshRequest {
                            run_id,
                            connector_ref: task_connector_ref,
                            trigger: RefreshTrigger::Scheduled,
                        })
                        .await;
                }
            }
        });
        active.refresh_tasks.insert(connector_ref, task);
    }
}

async fn run_refresh_worker(
    handle: ConnectorPolicyRefreshHandle,
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
                handle
                    .refresh_connector_now(request.run_id, request.connector_ref, request.trigger)
                    .await;
            }
        }
    }
}

async fn patch_connector_policy(
    run_id: RunId,
    connector_ref: &str,
    snapshot: ActiveRunPolicySnapshot,
    policy: NetworkPolicy,
) -> crate::error::RunnerResult<bool> {
    snapshot
        .registry
        .patch_network_policy_if_run_matches(
            &snapshot.source_ip,
            &run_id.to_string(),
            connector_ref,
            policy,
        )
        .await
}

async fn fail_closed_connector_policy(
    run_id: RunId,
    connector_ref: &str,
    snapshot: ActiveRunPolicySnapshot,
) {
    match snapshot
        .registry
        .fail_closed_network_policy_if_run_matches(
            &snapshot.source_ip,
            &run_id.to_string(),
            connector_ref,
        )
        .await
    {
        Ok(true) => {
            warn!(
                run_id = %run_id,
                connector_ref,
                "failed closed connector policy after scheduled refresh failure"
            );
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                run_id = %run_id,
                connector_ref,
                error = %error,
                "failed to fail close connector policy"
            );
        }
    }
}

fn parse_refresh_deadline(value: &str) -> Option<tokio::time::Instant> {
    let deadline = match DateTime::parse_from_rfc3339(value) {
        Ok(deadline) => deadline.with_timezone(&Utc),
        Err(error) => {
            warn!(
                next_refresh_at = value,
                error = %error,
                "invalid connector policy refresh deadline"
            );
            return None;
        }
    };
    let delay = deadline
        .signed_duration_since(Utc::now())
        .to_std()
        .unwrap_or(Duration::ZERO);
    Some(tokio::time::Instant::now() + delay)
}

fn abort_tasks(tasks: impl IntoIterator<Item = tokio::task::JoinHandle<()>>) {
    for task in tasks {
        task.abort();
    }
}
