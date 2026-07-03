//! Runtime connector policy refresh for active API-backed runs.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
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
    core: ConnectorPolicyRefreshCore,
    worker_task: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>>,
}

#[derive(Clone)]
struct ConnectorPolicyRefreshCore {
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
    refresh_tasks: HashMap<String, ScheduledRefreshTask>,
    next_refresh_task_id: u64,
}

struct ScheduledRefreshTask {
    id: u64,
    handle: tokio::task::JoinHandle<()>,
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
    pub(crate) initial_refresh_connector_refs: HashSet<String>,
    pub(crate) refreshes: Option<&'a HashMap<String, ConnectorPolicyRefresh>>,
}

#[derive(Clone, Copy)]
enum RefreshTrigger {
    Initial,
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
        matches!(self, Self::Notification | Self::Scheduled)
    }
}

impl ConnectorPolicyRefreshHandle {
    pub(super) fn new(api: ApiClient) -> Self {
        let (request_tx, request_rx) = mpsc::channel(REFRESH_REQUEST_QUEUE_CAPACITY);
        let core = ConnectorPolicyRefreshCore {
            inner: Arc::new(ConnectorPolicyRefreshState {
                api,
                active_runs: Mutex::new(HashMap::new()),
                cancel: CancellationToken::new(),
            }),
            request_tx,
        };
        let worker_task = tokio::spawn(run_refresh_worker(core.clone(), request_rx));
        Self {
            core,
            worker_task: Arc::new(StdMutex::new(Some(worker_task))),
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.core.shutdown_active_runs().await;
        let worker_task = self.take_worker_task();
        if let Some(worker_task) = worker_task
            && let Err(error) = worker_task.await
        {
            warn!(error = %error, "connector policy refresh worker failed during shutdown");
        }
    }

    pub(crate) async fn register_run(&self, registration: ConnectorPolicyRefreshRegistration<'_>) {
        self.core.register_run(registration).await;
    }

    pub(crate) async fn unregister_run(&self, run_id: RunId) {
        self.core.unregister_run(run_id).await;
    }

    pub(crate) async fn notify_permission_refresh(&self, run_id: RunId, connector_ref: String) {
        self.core
            .notify_permission_refresh(run_id, connector_ref)
            .await;
    }

    pub(crate) async fn notify_permission_refresh_until_cancelled(
        &self,
        run_id: RunId,
        connector_ref: String,
        cancel: &CancellationToken,
    ) {
        self.core
            .notify_permission_refresh_until_cancelled(run_id, connector_ref, cancel)
            .await;
    }

    fn take_worker_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.worker_task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for ConnectorPolicyRefreshHandle {
    fn drop(&mut self) {
        if Arc::strong_count(&self.worker_task) != 1 {
            return;
        }
        self.core.inner.cancel.cancel();
        if let Some(worker_task) = self.take_worker_task() {
            worker_task.abort();
        }
    }
}

impl ConnectorPolicyRefreshCore {
    async fn shutdown_active_runs(&self) {
        self.inner.cancel.cancel();
        let old_runs = std::mem::take(&mut *self.inner.active_runs.lock().await);
        for old in old_runs.into_values() {
            old.cancel.cancel();
            abort_tasks(old.refresh_tasks.into_values().map(|task| task.handle));
        }
    }

    async fn register_run(&self, registration: ConnectorPolicyRefreshRegistration<'_>) {
        if self.inner.cancel.is_cancelled() {
            return;
        }
        if registration.connector_refs.is_empty() {
            self.unregister_run(registration.run_id).await;
            return;
        }
        let initial_refresh_connector_refs: Vec<String> = registration
            .initial_refresh_connector_refs
            .iter()
            .filter(|connector_ref| registration.connector_refs.contains(*connector_ref))
            .cloned()
            .collect();

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

            active_runs.insert(
                registration.run_id,
                ActiveRunPolicyState {
                    source_ip: registration.source_ip.to_string(),
                    registry: registration.registry,
                    connector_refs: registration.connector_refs,
                    cancel: run_cancel.clone(),
                    refresh_tasks: HashMap::new(),
                    next_refresh_task_id: 0,
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
            self.enqueue_refresh_until_cancelled(
                RefreshRequest {
                    run_id: registration.run_id,
                    connector_ref,
                    trigger: RefreshTrigger::Initial,
                },
                &run_cancel,
            )
            .await;
        }
    }

    async fn unregister_run(&self, run_id: RunId) {
        let old = self.inner.active_runs.lock().await.remove(&run_id);
        if let Some(old) = old {
            old.cancel.cancel();
            abort_tasks(old.refresh_tasks.into_values().map(|task| task.handle));
        }
    }

    async fn notify_permission_refresh(&self, run_id: RunId, connector_ref: String) {
        self.notify_permission_refresh_inner(run_id, connector_ref, None)
            .await;
    }

    async fn notify_permission_refresh_until_cancelled(
        &self,
        run_id: RunId,
        connector_ref: String,
        cancel: &CancellationToken,
    ) {
        self.notify_permission_refresh_inner(run_id, connector_ref, Some(cancel))
            .await;
    }

    async fn notify_permission_refresh_inner(
        &self,
        run_id: RunId,
        connector_ref: String,
        cancel: Option<&CancellationToken>,
    ) {
        let Some(run_cancel) = self.active_connector_cancel(run_id, &connector_ref).await else {
            return;
        };
        let request = RefreshRequest {
            run_id,
            connector_ref,
            trigger: RefreshTrigger::Notification,
        };
        if let Some(cancel) = cancel {
            self.enqueue_refresh_until_either_cancelled(request, &run_cancel, cancel)
                .await;
        } else {
            self.enqueue_refresh_until_cancelled(request, &run_cancel)
                .await;
        }
    }

    async fn active_connector_cancel(
        &self,
        run_id: RunId,
        connector_ref: &str,
    ) -> Option<CancellationToken> {
        let active_runs = self.inner.active_runs.lock().await;
        let active = active_runs.get(&run_id)?;
        active
            .connector_refs
            .contains(connector_ref)
            .then(|| active.cancel.clone())
    }

    async fn enqueue_refresh_until_cancelled(
        &self,
        request: RefreshRequest,
        cancel: &CancellationToken,
    ) {
        tokio::select! {
            biased;
            () = self.inner.cancel.cancelled() => {}
            () = cancel.cancelled() => {}
            result = self.request_tx.send(request) => {
                if let Err(error) = result {
                    warn!(error = %error, "connector policy refresh queue closed");
                }
            }
        }
    }

    async fn enqueue_refresh_until_either_cancelled(
        &self,
        request: RefreshRequest,
        cancel: &CancellationToken,
        other_cancel: &CancellationToken,
    ) {
        tokio::select! {
            biased;
            () = self.inner.cancel.cancelled() => {}
            () = cancel.cancelled() => {}
            () = other_cancel.cancelled() => {}
            result = self.request_tx.send(request) => {
                if let Err(error) = result {
                    warn!(error = %error, "connector policy refresh queue closed");
                }
            }
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
            if trigger.fail_closed_on_error()
                && let Some(snapshot) = self.active_snapshot(run_id, &connector_ref).await
            {
                fail_closed_connector_policy(run_id, &connector_ref, snapshot).await;
            }
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
            old.handle.abort();
        }
        let Some(deadline) = deadline else {
            return;
        };

        let task_id = active.next_refresh_task_id;
        active.next_refresh_task_id += 1;
        let cancel = active.cancel.clone();
        let enqueue_cancel = cancel.clone();
        let global_cancel = self.inner.cancel.clone();
        let connector_ref = connector_ref.to_string();
        let handle = self.clone();
        let task_connector_ref = connector_ref.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                () = global_cancel.cancelled() => {}
                () = cancel.cancelled() => {}
                () = tokio::time::sleep_until(deadline) => {
                    handle
                        .clear_completed_schedule(run_id, &task_connector_ref, task_id)
                        .await;
                    handle
                        .enqueue_refresh_until_cancelled(
                            RefreshRequest {
                                run_id,
                                connector_ref: task_connector_ref,
                                trigger: RefreshTrigger::Scheduled,
                            },
                            &enqueue_cancel,
                        )
                        .await;
                }
            }
        });
        active.refresh_tasks.insert(
            connector_ref,
            ScheduledRefreshTask {
                id: task_id,
                handle: task,
            },
        );
    }

    async fn clear_completed_schedule(&self, run_id: RunId, connector_ref: &str, task_id: u64) {
        let mut active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get_mut(&run_id) else {
            return;
        };
        if active
            .refresh_tasks
            .get(connector_ref)
            .is_some_and(|task| task.id == task_id)
        {
            active.refresh_tasks.remove(connector_ref);
        }
    }
}

async fn run_refresh_worker(
    handle: ConnectorPolicyRefreshCore,
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
                tokio::select! {
                    () = handle.inner.cancel.cancelled() => {
                        break;
                    }
                    () = handle.refresh_connector_now(
                        request.run_id,
                        request.connector_ref,
                        request.trigger,
                    ) => {}
                }
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
                "failed closed connector policy after connector policy refresh failure"
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use httpmock::{Method::POST, MockServer};
    use serde_json::json;

    use crate::http::{HttpClient, HttpClientConfig};
    use crate::proxy::{ProxyRegistryHandle, VmRegistration};
    use crate::types::FirewallEntry;

    fn api_client_for_server(server: &MockServer) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url: server.base_url(),
                vercel_bypass: None,
            })
            .expect("test API URL should be valid"),
            "runner-token".to_string(),
        )
    }

    fn core_without_worker(
        server: &MockServer,
    ) -> (
        ConnectorPolicyRefreshCore,
        tokio::sync::mpsc::Receiver<RefreshRequest>,
    ) {
        let (request_tx, request_rx) = mpsc::channel(REFRESH_REQUEST_QUEUE_CAPACITY);
        (
            ConnectorPolicyRefreshCore {
                inner: Arc::new(ConnectorPolicyRefreshState {
                    api: api_client_for_server(server),
                    active_runs: Mutex::new(HashMap::new()),
                    cancel: CancellationToken::new(),
                }),
                request_tx,
            },
            request_rx,
        )
    }

    fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
        let waker = std::task::Waker::noop();
        let mut context = Context::from_waker(waker);
        future.poll(&mut context)
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
        core: &ConnectorPolicyRefreshCore,
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

    struct RefreshPolicyHarness {
        _dir: tempfile::TempDir,
        handle: ConnectorPolicyRefreshHandle,
        registry_path: std::path::PathBuf,
        run_id: RunId,
        source_ip: String,
    }

    impl RefreshPolicyHarness {
        async fn new(server: &MockServer, run_id: RunId) -> Self {
            let dir = tempfile::tempdir().expect("tempdir should be created");
            let registry_path = dir.path().join("proxy-registry.json");
            tokio::fs::write(&registry_path, br#"{"vms":{},"updatedAt":0}"#)
                .await
                .expect("empty registry should be written");
            let registry =
                ProxyRegistryHandle::new(registry_path.clone(), dir.path().join("registry.lock"));
            let source_ip = "10.200.0.2";
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

            let handle = ConnectorPolicyRefreshHandle::new(api_client_for_server(server));
            handle
                .core
                .register_run(ConnectorPolicyRefreshRegistration {
                    run_id,
                    source_ip,
                    registry: registry.clone(),
                    connector_refs: HashSet::from(["slack".to_string()]),
                    initial_refresh_connector_refs: HashSet::new(),
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

        async fn refresh_slack(&self, trigger: RefreshTrigger) {
            self.handle
                .core
                .refresh_connector_now(self.run_id, "slack".to_string(), trigger)
                .await;
        }

        async fn slack_policy(&self) -> serde_json::Value {
            let registry_json: serde_json::Value = serde_json::from_str(
                &tokio::fs::read_to_string(&self.registry_path)
                    .await
                    .expect("registry should be readable"),
            )
            .expect("registry should be valid JSON");
            registry_json["vms"][&self.source_ip]["networkPolicies"]["slack"].clone()
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

    fn assert_original_policy(policy: &serde_json::Value) {
        assert_eq!(policy["allow"], json!(["chat:write"]));
        assert_eq!(policy["deny"], json!(["files:write"]));
        assert_eq!(policy["ask"], json!(["channels:read"]));
        assert_eq!(policy["unknownPolicy"], json!("allow"));
    }

    fn active_run_policy_state(registry: ProxyRegistryHandle) -> ActiveRunPolicyState {
        ActiveRunPolicyState {
            source_ip: "10.200.0.2".to_string(),
            registry,
            connector_refs: HashSet::from(["slack".to_string()]),
            cancel: CancellationToken::new(),
            refresh_tasks: HashMap::new(),
            next_refresh_task_id: 0,
        }
    }

    #[tokio::test]
    async fn shutdown_awaits_refresh_worker_task() {
        let server = MockServer::start();
        let handle = ConnectorPolicyRefreshHandle::new(api_client_for_server(&server));

        tokio::time::timeout(Duration::from_secs(1), handle.shutdown())
            .await
            .expect("connector policy refresh shutdown timed out");

        let worker_task = handle
            .worker_task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(worker_task.is_none());
    }

    #[tokio::test]
    async fn drop_last_handle_cancels_refresh_worker_task() {
        let server = MockServer::start();
        let handle = ConnectorPolicyRefreshHandle::new(api_client_for_server(&server));
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
    async fn drop_last_handle_releases_refresh_state_with_scheduled_task() {
        let server = MockServer::start();
        let handle = ConnectorPolicyRefreshHandle::new(api_client_for_server(&server));
        let weak_state = Arc::downgrade(&handle.core.inner);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        let refreshes = HashMap::from([(
            "slack".to_string(),
            ConnectorPolicyRefresh {
                next_refresh_at: "2999-01-01T00:00:00Z".to_string(),
            },
        )]);
        handle
            .core
            .register_run(ConnectorPolicyRefreshRegistration {
                run_id,
                source_ip: "10.200.0.2",
                registry,
                connector_refs: HashSet::from(["slack".to_string()]),
                initial_refresh_connector_refs: HashSet::new(),
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
        let handle = ConnectorPolicyRefreshHandle::new(api_client_for_server(&server));
        handle.shutdown().await;
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );

        handle
            .core
            .register_run(ConnectorPolicyRefreshRegistration {
                run_id: RunId::nil(),
                source_ip: "10.200.0.2",
                registry,
                connector_refs: HashSet::from(["slack".to_string()]),
                initial_refresh_connector_refs: HashSet::from(["slack".to_string()]),
                refreshes: None,
            })
            .await;

        assert!(handle.core.inner.active_runs.lock().await.is_empty());
    }

    #[tokio::test]
    async fn inactive_permission_notification_is_not_enqueued() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);

        core.notify_permission_refresh(RunId::nil(), "slack".to_string())
            .await;

        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn active_permission_notification_is_enqueued() {
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
            .insert(run_id, active_run_policy_state(registry));

        core.notify_permission_refresh(run_id, "slack".to_string())
            .await;

        let request = requests
            .try_recv()
            .expect("active connector notification should enqueue refresh");
        assert_eq!(request.run_id, run_id);
        assert_eq!(request.connector_ref, "slack");
        assert!(matches!(request.trigger, RefreshTrigger::Notification));
    }

    #[tokio::test]
    async fn cancelled_permission_notification_does_not_wait_for_queue_capacity() {
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
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(RefreshRequest {
                    run_id,
                    connector_ref: "slack".to_string(),
                    trigger: RefreshTrigger::Scheduled,
                })
                .expect("refresh queue should accept request");
        }
        let cancel = CancellationToken::new();
        cancel.cancel();

        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_permission_refresh_until_cancelled(run_id, "slack".to_string(), &cancel),
        )
        .await
        .expect("cancelled notification should not wait for queue capacity");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
    }

    #[tokio::test]
    async fn unregister_cancels_initial_refresh_waiting_for_queue_capacity() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let registry = ProxyRegistryHandle::new(
            dir.path().join("proxy-registry.json"),
            dir.path().join("proxy-registry.lock"),
        );
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(RefreshRequest {
                    run_id,
                    connector_ref: "slack".to_string(),
                    trigger: RefreshTrigger::Scheduled,
                })
                .expect("refresh queue should accept request");
        }

        let register = core.register_run(ConnectorPolicyRefreshRegistration {
            run_id,
            source_ip: "10.200.0.2",
            registry,
            connector_refs: HashSet::from(["slack".to_string()]),
            initial_refresh_connector_refs: HashSet::from(["slack".to_string()]),
            refreshes: None,
        });
        tokio::pin!(register);
        assert!(
            matches!(poll_once(register.as_mut()), Poll::Pending),
            "initial refresh should wait for refresh queue capacity before unregister"
        );

        core.unregister_run(run_id).await;
        tokio::time::timeout(Duration::from_secs(1), register.as_mut())
            .await
            .expect("unregister should cancel initial refresh waiting for queue capacity");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
    }

    #[tokio::test]
    async fn unregister_cancels_permission_notification_waiting_for_queue_capacity() {
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
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(RefreshRequest {
                    run_id,
                    connector_ref: "slack".to_string(),
                    trigger: RefreshTrigger::Scheduled,
                })
                .expect("refresh queue should accept request");
        }

        let notify = core.notify_permission_refresh(run_id, "slack".to_string());
        tokio::pin!(notify);
        assert!(
            matches!(poll_once(notify.as_mut()), Poll::Pending),
            "notification should wait for refresh queue capacity before unregister"
        );

        core.unregister_run(run_id).await;
        tokio::time::timeout(Duration::from_secs(1), notify.as_mut())
            .await
            .expect("unregister should cancel notification waiting for queue capacity");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
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
            .insert(run_id, active_run_policy_state(registry));

        core.replace_schedule(
            run_id,
            "slack",
            Some("1970-01-01T00:00:00.000Z".to_string()),
        )
        .await;

        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(request.connector_ref, "slack");
        assert!(matches!(request.trigger, RefreshTrigger::Scheduled));
        let active_runs = core.inner.active_runs.lock().await;
        let active = active_runs
            .get(&run_id)
            .expect("run should remain active after scheduled refresh fires");
        assert!(active.refresh_tasks.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn unregister_cancels_scheduled_refresh_waiting_for_queue_capacity() {
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
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(RefreshRequest {
                    run_id,
                    connector_ref: "slack".to_string(),
                    trigger: RefreshTrigger::Notification,
                })
                .expect("refresh queue should accept request");
        }

        core.replace_schedule(
            run_id,
            "slack",
            Some("1970-01-01T00:00:00.000Z".to_string()),
        )
        .await;
        wait_until_scheduled_refresh_task_clears(&core, run_id).await;
        assert!(
            core.inner
                .active_runs
                .lock()
                .await
                .get(&run_id)
                .is_some_and(|active| active.refresh_tasks.is_empty()),
            "scheduled task should be waiting on the full refresh queue"
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

    #[tokio::test]
    async fn scheduled_mismatched_connector_refresh_fails_closed() {
        assert_mismatched_connector_refresh_fail_closed(RefreshTrigger::Scheduled, true).await;
    }

    #[tokio::test]
    async fn notification_mismatched_connector_refresh_fails_closed() {
        assert_mismatched_connector_refresh_fail_closed(RefreshTrigger::Notification, true).await;
    }

    #[tokio::test]
    async fn initial_mismatched_connector_refresh_keeps_claim_policy() {
        assert_mismatched_connector_refresh_fail_closed(RefreshTrigger::Initial, false).await;
    }

    #[tokio::test]
    async fn scheduled_failed_connector_refresh_fails_closed() {
        assert_failed_connector_refresh_fail_closed(RefreshTrigger::Scheduled, true).await;
    }

    #[tokio::test]
    async fn notification_failed_connector_refresh_fails_closed() {
        assert_failed_connector_refresh_fail_closed(RefreshTrigger::Notification, true).await;
    }

    #[tokio::test]
    async fn initial_failed_connector_refresh_keeps_claim_policy() {
        assert_failed_connector_refresh_fail_closed(RefreshTrigger::Initial, false).await;
    }

    async fn assert_failed_connector_refresh_fail_closed(
        trigger: RefreshTrigger,
        expect_fail_closed: bool,
    ) {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST).path(format!(
                "/api/runners/runs/{run_id}/connector-network-policy"
            ));
            then.status(500)
                .header("content-type", "application/json")
                .json_body(json!({
                    "error": {
                        "code": "INTERNAL_SERVER_ERROR",
                        "message": "refresh failed",
                    },
                }));
        });

        let harness = RefreshPolicyHarness::new(&server, run_id).await;
        harness.refresh_slack(trigger).await;
        let policy = harness.slack_policy().await;
        if expect_fail_closed {
            assert_fail_closed_policy(&policy);
        } else {
            assert_original_policy(&policy);
        }

        harness.shutdown().await;
    }

    async fn assert_mismatched_connector_refresh_fail_closed(
        trigger: RefreshTrigger,
        expect_fail_closed: bool,
    ) {
        let server = MockServer::start();
        let run_id = RunId::nil();
        server.mock(|when, then| {
            when.method(POST).path(format!(
                "/api/runners/runs/{run_id}/connector-network-policy"
            ));
            then.status(200)
                .header("content-type", "application/json")
                .json_body(json!({
                    "connectorRef": "github",
                    "networkPolicy": {
                        "allow": ["repos:read"],
                        "deny": [],
                        "ask": [],
                        "unknownPolicy": "allow",
                    },
                    "nextRefreshAt": null,
                }));
        });

        let harness = RefreshPolicyHarness::new(&server, run_id).await;
        harness.refresh_slack(trigger).await;
        let policy = harness.slack_policy().await;
        if expect_fail_closed {
            assert_fail_closed_policy(&policy);
        } else {
            assert_original_policy(&policy);
        }

        harness.shutdown().await;
    }
}
