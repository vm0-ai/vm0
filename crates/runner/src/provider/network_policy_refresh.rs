//! Runtime network policy refresh for active API-backed runs.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use api_contracts::generated::constants::runners::NETWORK_POLICY_REFRESH_CONNECTOR_REFS_MAX;
use chrono::{DateTime, Utc};
use tokio::sync::{
    Mutex, mpsc,
    mpsc::error::{TrySendError, TrySendError::Closed, TrySendError::Full},
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::api::ApiClient;
use crate::ids::RunId;
use crate::proxy::ProxyRegistryHandle;
use crate::types::{NetworkPolicy, NetworkPolicyRefresh};

const REFRESH_REQUEST_QUEUE_CAPACITY: usize = 256;
const NETWORK_POLICY_REFRESH_BATCH_MAX: usize = NETWORK_POLICY_REFRESH_CONNECTOR_REFS_MAX as usize;
const EXPIRED_REFRESH_DEADLINE_RETRY_DELAY: Duration = Duration::from_millis(250);
const SCHEDULED_REFRESH_COALESCE_WINDOW: Duration = Duration::from_millis(100);

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
    deadline: tokio::time::Instant,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct ActiveRunPolicySnapshot {
    source_ip: String,
    registry: ProxyRegistryHandle,
}

pub(crate) struct NetworkPolicyRefreshRegistration<'a> {
    pub(crate) run_id: RunId,
    pub(crate) source_ip: &'a str,
    pub(crate) registry: ProxyRegistryHandle,
    pub(crate) connector_refs: HashSet<String>,
    pub(crate) refreshes: Option<&'a HashMap<String, NetworkPolicyRefresh>>,
}

struct RefreshRequest {
    run_id: RunId,
    connector_refs: Vec<String>,
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

    pub(crate) async fn notify_network_policy_refresh(&self, run_id: RunId, connector_ref: String) {
        self.core
            .notify_network_policy_refresh(run_id, connector_ref)
            .await;
    }

    pub(crate) async fn notify_network_policy_refresh_until_cancelled(
        &self,
        run_id: RunId,
        connector_ref: String,
        cancel: &CancellationToken,
    ) {
        self.core
            .notify_network_policy_refresh_until_cancelled(run_id, connector_ref, cancel)
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
        if registration.connector_refs.is_empty() {
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
    }

    async fn unregister_run(&self, run_id: RunId) {
        let old = self.inner.active_runs.lock().await.remove(&run_id);
        if let Some(old) = old {
            old.cancel.cancel();
            abort_tasks(old.refresh_tasks.into_values().map(|task| task.handle));
        }
    }

    async fn notify_network_policy_refresh(&self, run_id: RunId, connector_ref: String) {
        self.notify_network_policy_refresh_inner(run_id, connector_ref, None)
            .await;
    }

    async fn notify_network_policy_refresh_until_cancelled(
        &self,
        run_id: RunId,
        connector_ref: String,
        cancel: &CancellationToken,
    ) {
        self.notify_network_policy_refresh_inner(run_id, connector_ref, Some(cancel))
            .await;
    }

    async fn notify_network_policy_refresh_inner(
        &self,
        run_id: RunId,
        connector_ref: String,
        cancel: Option<&CancellationToken>,
    ) {
        let Some(run_cancel) = self.active_connector_cancel(run_id, &connector_ref).await else {
            return;
        };
        if self.inner.cancel.is_cancelled()
            || run_cancel.is_cancelled()
            || cancel.is_some_and(CancellationToken::is_cancelled)
        {
            return;
        }
        let request = RefreshRequest {
            run_id,
            connector_refs: vec![connector_ref],
        };
        if let Err(error) = self.request_tx.try_send(request) {
            self.handle_notification_enqueue_error(error).await;
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

    async fn handle_notification_enqueue_error(&self, error: TrySendError<RefreshRequest>) {
        match error {
            Full(request) => {
                warn!(
                    run_id = %request.run_id,
                    connector_count = request.connector_refs.len(),
                    connector_refs = ?request.connector_refs,
                    "network policy refresh queue full; failing closed after network policy refresh notification"
                );
                self.try_fail_closed_active_connectors(request.run_id, &request.connector_refs)
                    .await;
            }
            Closed(error) => {
                warn!(
                    run_id = %error.run_id,
                    connector_count = error.connector_refs.len(),
                    connector_refs = ?error.connector_refs,
                    "network policy refresh queue closed"
                );
            }
        }
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
                warn!(
                    run_id = %request.run_id,
                    connector_count = request.connector_refs.len(),
                    connector_refs = ?request.connector_refs,
                    "network policy refresh queue full; failing closed after scheduled refresh deadline"
                );
                self.fail_closed_active_connectors(request.run_id, &request.connector_refs)
                    .await;
            }
            Closed(error) => {
                warn!(
                    run_id = %error.run_id,
                    connector_count = error.connector_refs.len(),
                    connector_refs = ?error.connector_refs,
                    "network policy refresh queue closed"
                );
            }
        }
    }

    async fn refresh_network_policies_now(&self, run_id: RunId, connector_refs: Vec<String>) {
        let active_connector_refs = self
            .active_connector_refs(run_id, unique_connector_refs(connector_refs))
            .await;
        if active_connector_refs.is_empty() {
            return;
        }

        for connector_refs in active_connector_refs.chunks(NETWORK_POLICY_REFRESH_BATCH_MAX) {
            if !self
                .refresh_network_policy_batch_now(run_id, connector_refs)
                .await
            {
                return;
            }
        }
    }

    async fn refresh_network_policy_batch_now(
        &self,
        run_id: RunId,
        active_connector_refs: &[String],
    ) -> bool {
        let response = match self
            .inner
            .api
            .refresh_network_policies(run_id, active_connector_refs)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    connector_count = active_connector_refs.len(),
                    connector_refs = ?active_connector_refs,
                    error = %error,
                    "network policy refresh failed"
                );
                self.fail_closed_active_connectors(run_id, active_connector_refs)
                    .await;
                return true;
            }
        };

        let requested_connector_refs: HashSet<String> =
            active_connector_refs.iter().cloned().collect();
        let mut responses_by_connector = HashMap::new();
        let mut duplicate_connector_refs = HashSet::new();
        for refresh in response.refreshes {
            if !requested_connector_refs.contains(refresh.connector_ref.as_str()) {
                warn!(
                    run_id = %run_id,
                    response_connector_ref = refresh.connector_ref,
                    requested_connector_refs = ?active_connector_refs,
                    "network policy refresh returned unexpected connector"
                );
                continue;
            }
            let response_connector_ref = refresh.connector_ref.clone();
            if responses_by_connector
                .insert(response_connector_ref.clone(), refresh)
                .is_some()
            {
                warn!(
                    run_id = %run_id,
                    connector_ref = response_connector_ref,
                    "network policy refresh returned duplicate connector"
                );
                duplicate_connector_refs.insert(response_connector_ref);
            }
        }

        for connector_ref in active_connector_refs {
            let connector_ref = connector_ref.as_str();
            if duplicate_connector_refs.contains(connector_ref) {
                if let Some(snapshot) = self.active_snapshot(run_id, connector_ref).await {
                    fail_closed_network_policy(run_id, connector_ref, snapshot).await;
                }
                continue;
            }
            let Some(response) = responses_by_connector.remove(connector_ref) else {
                warn!(
                    run_id = %run_id,
                    connector_ref,
                    "network policy refresh response omitted requested connector"
                );
                if let Some(snapshot) = self.active_snapshot(run_id, connector_ref).await {
                    fail_closed_network_policy(run_id, connector_ref, snapshot).await;
                }
                continue;
            };

            let Some(snapshot) = self.active_snapshot(run_id, connector_ref).await else {
                continue;
            };
            match patch_network_policy(run_id, connector_ref, snapshot, response.network_policy)
                .await
            {
                Ok(true) => {
                    info!(
                        run_id = %run_id,
                        connector_ref,
                        "refreshed network policy"
                    );
                    self.replace_schedule(run_id, connector_ref, response.next_refresh_at)
                        .await;
                }
                Ok(false) => {
                    self.unregister_run(run_id).await;
                    return false;
                }
                Err(error) => {
                    warn!(
                        run_id = %run_id,
                        connector_ref,
                        error = %error,
                        "failed to patch refreshed network policy"
                    );
                    if let Some(snapshot) = self.active_snapshot(run_id, connector_ref).await {
                        fail_closed_network_policy(run_id, connector_ref, snapshot).await;
                    }
                }
            }
        }
        true
    }

    async fn active_connector_refs(
        &self,
        run_id: RunId,
        connector_refs: Vec<String>,
    ) -> Vec<String> {
        let active_runs = self.inner.active_runs.lock().await;
        let Some(active) = active_runs.get(&run_id) else {
            return Vec::new();
        };
        connector_refs
            .into_iter()
            .filter(|connector_ref| active.connector_refs.contains(connector_ref))
            .collect()
    }

    async fn try_fail_closed_active_connectors(&self, run_id: RunId, connector_refs: &[String]) {
        for connector_ref in connector_refs {
            if let Some(snapshot) = self.active_snapshot(run_id, connector_ref).await {
                try_fail_closed_network_policy(run_id, connector_ref, snapshot).await;
            }
        }
    }

    async fn fail_closed_active_connectors(&self, run_id: RunId, connector_refs: &[String]) {
        for connector_ref in connector_refs {
            if let Some(snapshot) = self.active_snapshot(run_id, connector_ref).await {
                fail_closed_network_policy(run_id, connector_ref, snapshot).await;
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
        let global_cancel = self.inner.cancel.clone();
        let connector_ref = connector_ref.to_string();
        let handle = self.clone();
        let task_connector_ref = connector_ref.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                () = global_cancel.cancelled() => {}
                () = cancel.cancelled() => {}
                () = tokio::time::sleep_until(deadline) => {
                    if let Some((connector_refs, enqueue_cancel)) = handle
                        .take_due_scheduled_refreshes(run_id, &task_connector_ref, task_id)
                        .await
                    {
                        handle
                            .enqueue_scheduled_refresh(
                                RefreshRequest {
                                    run_id,
                                    connector_refs,
                                },
                                &enqueue_cancel,
                            )
                            .await;
                    }
                }
            }
        });
        active.refresh_tasks.insert(
            connector_ref,
            ScheduledRefreshTask {
                id: task_id,
                deadline,
                handle: task,
            },
        );
    }

    async fn take_due_scheduled_refreshes(
        &self,
        run_id: RunId,
        connector_ref: &str,
        task_id: u64,
    ) -> Option<(Vec<String>, CancellationToken)> {
        let mut handles_to_abort = Vec::new();
        let (connector_refs, cancel) = {
            let mut active_runs = self.inner.active_runs.lock().await;
            let active = active_runs.get_mut(&run_id)?;
            if active
                .refresh_tasks
                .get(connector_ref)
                .is_none_or(|task| task.id != task_id)
            {
                return None;
            }

            let coalesce_deadline = tokio::time::Instant::now() + SCHEDULED_REFRESH_COALESCE_WINDOW;
            let mut due_connector_refs = active
                .refresh_tasks
                .iter()
                .filter(|(_, task)| task.deadline <= coalesce_deadline)
                .map(|(connector_ref, _)| connector_ref.clone())
                .collect::<Vec<_>>();
            due_connector_refs.sort();

            let mut connector_refs = Vec::with_capacity(due_connector_refs.len());
            for due_connector_ref in due_connector_refs {
                if let Some(task) = active.refresh_tasks.remove(&due_connector_ref) {
                    if due_connector_ref != connector_ref {
                        handles_to_abort.push(task.handle);
                    }
                    connector_refs.push(due_connector_ref);
                }
            }

            (connector_refs, active.cancel.clone())
        };

        abort_tasks(handles_to_abort);
        (!connector_refs.is_empty()).then_some((connector_refs, cancel))
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
                    connector_refs,
                } = request;
                let completed = tokio::select! {
                    () = handle.inner.cancel.cancelled() => {
                        false
                    }
                    () = handle.refresh_network_policies_now(
                        run_id,
                        connector_refs,
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

async fn try_fail_closed_network_policy(
    run_id: RunId,
    connector_ref: &str,
    snapshot: ActiveRunPolicySnapshot,
) {
    match snapshot
        .registry
        .try_fail_closed_network_policy_if_run_matches(
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
                "failed closed network policy after network policy refresh queue overflow"
            );
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                run_id = %run_id,
                connector_ref,
                error = %error,
                "failed to fail close network policy after network policy refresh queue overflow"
            );
        }
    }
}

async fn fail_closed_network_policy(
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
                "failed closed network policy after network policy refresh failure"
            );
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                run_id = %run_id,
                connector_ref,
                error = %error,
                "failed to fail close network policy"
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
                "invalid network policy refresh deadline"
            );
            return None;
        }
    };
    let delay = deadline
        .signed_duration_since(Utc::now())
        .to_std()
        .unwrap_or(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY);
    Some(tokio::time::Instant::now() + delay)
}

fn unique_connector_refs(connector_refs: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::with_capacity(connector_refs.len());
    for connector_ref in connector_refs {
        if seen.insert(connector_ref.clone()) {
            unique.push(connector_ref);
        }
    }
    unique
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

            let handle = NetworkPolicyRefreshHandle::new(api_client_for_server(server));
            handle
                .core
                .register_run(NetworkPolicyRefreshRegistration {
                    run_id,
                    source_ip,
                    registry: registry.clone(),
                    connector_refs: HashSet::from(["slack".to_string()]),
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
        active_run_policy_state_with_connectors(registry, ["slack"])
    }

    fn active_run_policy_state_with_connectors<I, S>(
        registry: ProxyRegistryHandle,
        connector_refs: I,
    ) -> ActiveRunPolicyState
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        ActiveRunPolicyState {
            source_ip: "10.200.0.2".to_string(),
            registry,
            connector_refs: connector_refs.into_iter().map(Into::into).collect(),
            cancel: CancellationToken::new(),
            refresh_tasks: HashMap::new(),
            next_refresh_task_id: 0,
        }
    }

    fn refresh_request(run_id: RunId, connector_ref: &str) -> RefreshRequest {
        RefreshRequest {
            run_id,
            connector_refs: vec![connector_ref.to_string()],
        }
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

    async fn load_slack_policy(registry_path: &std::path::Path) -> serde_json::Value {
        let registry_json: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(registry_path)
                .await
                .expect("registry should be readable"),
        )
        .expect("registry should be valid JSON");
        registry_json["vms"]["10.200.0.2"]["networkPolicies"]["slack"].clone()
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
                connector_refs: HashSet::from(["slack".to_string()]),
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
                connector_refs: HashSet::from(["slack".to_string()]),
                refreshes: None,
            })
            .await;

        assert!(handle.core.inner.active_runs.lock().await.is_empty());
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
    async fn active_network_policy_notification_is_enqueued() {
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

        core.notify_network_policy_refresh(run_id, "slack".to_string())
            .await;

        let request = requests
            .try_recv()
            .expect("active connector notification should enqueue refresh");
        assert_eq!(request.run_id, run_id);
        assert_eq!(request.connector_refs, vec!["slack".to_string()]);
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
            .insert(run_id, active_run_policy_state(registry));
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
    }

    #[tokio::test]
    async fn full_queue_network_policy_notification_fails_closed_without_waiting() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }

        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_network_policy_refresh(run_id, "slack".to_string()),
        )
        .await
        .expect("full queue notification should fail closed without waiting for capacity");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        let policy = wait_until_slack_policy(&registry_path, |policy| {
            policy["unknownPolicy"] == json!("deny")
        })
        .await;
        assert_fail_closed_policy(&policy);
    }

    #[tokio::test]
    async fn full_queue_notification_skips_busy_registry_lock_without_waiting() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }
        let lock_guard = crate::lock::acquire(lock_path)
            .await
            .expect("registry lock should be acquired");

        tokio::time::timeout(
            Duration::from_secs(1),
            core.notify_network_policy_refresh(run_id, "slack".to_string()),
        )
        .await
        .expect("full queue notification should not wait for registry lock");

        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        let policy = wait_until_slack_policy(&registry_path, |policy| {
            policy["unknownPolicy"] == json!("allow")
        })
        .await;
        assert_original_policy(&policy);

        drop(lock_guard);
        tokio::task::yield_now().await;
        let policy = load_slack_policy(&registry_path).await;
        assert_original_policy(&policy);
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
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        tokio::time::advance(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY).await;
        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(request.connector_refs, vec!["slack".to_string()]);
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
            active_run_policy_state_with_connectors(registry, ["slack", "github"]),
        );

        for connector_ref in ["slack", "github"] {
            core.replace_schedule(
                run_id,
                connector_ref,
                Some("1970-01-01T00:00:00.000Z".to_string()),
            )
            .await;
        }
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        tokio::time::advance(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY).await;
        let request = recv_refresh_request(&mut requests).await;
        assert_eq!(request.run_id, run_id);
        assert_eq!(
            request.connector_refs,
            vec!["github".to_string(), "slack".to_string()]
        );
        wait_until_scheduled_refresh_task_clears(&core, run_id).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            requests.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
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
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }

        core.replace_schedule(
            run_id,
            "slack",
            Some("1970-01-01T00:00:00.000Z".to_string()),
        )
        .await;
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
    async fn scheduled_refresh_full_queue_fails_closed_without_waiting_for_capacity() {
        let server = MockServer::start();
        let (core, mut requests) = core_without_worker(&server);
        let run_id = RunId::nil();
        let (_dir, registry, registry_path, _lock_path) = registered_slack_registry(run_id).await;
        core.inner
            .active_runs
            .lock()
            .await
            .insert(run_id, active_run_policy_state(registry));
        for _ in 0..REFRESH_REQUEST_QUEUE_CAPACITY {
            core.request_tx
                .try_send(refresh_request(run_id, "slack"))
                .expect("refresh queue should accept request");
        }

        core.replace_schedule(
            run_id,
            "slack",
            Some("1970-01-01T00:00:00.000Z".to_string()),
        )
        .await;
        tokio::time::advance(EXPIRED_REFRESH_DEADLINE_RETRY_DELAY).await;

        wait_until_scheduled_refresh_task_clears(&core, run_id).await;
        let mut queued = 0;
        while requests.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REFRESH_REQUEST_QUEUE_CAPACITY);
        let policy = wait_until_slack_policy(&registry_path, |policy| {
            policy["unknownPolicy"] == json!("deny")
        })
        .await;
        assert_fail_closed_policy(&policy);
    }

    #[tokio::test]
    async fn mismatched_network_policy_refresh_fails_closed() {
        assert_mismatched_network_policy_refresh_fail_closed().await;
    }

    #[tokio::test]
    async fn failed_network_policy_refresh_fails_closed() {
        assert_failed_network_policy_refresh_fail_closed().await;
    }

    #[tokio::test]
    async fn network_policy_refresh_splits_batches_to_match_api_contract() {
        let server = MockServer::start();
        let run_id = RunId::nil();
        let connector_refs = (0..=NETWORK_POLICY_REFRESH_BATCH_MAX)
            .map(|index| format!("connector-{index}"))
            .collect::<Vec<_>>();
        let first_batch = connector_refs[..NETWORK_POLICY_REFRESH_BATCH_MAX].to_vec();
        let second_batch = connector_refs[NETWORK_POLICY_REFRESH_BATCH_MAX..].to_vec();
        let first_mock = server.mock(|when, then| {
            when.method(POST)
                .path(format!("/api/runners/runs/{run_id}/network-policy-refresh"))
                .json_body(json!({ "connectorRefs": first_batch }));
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
                .json_body(json!({ "connectorRefs": second_batch }));
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
            active_run_policy_state_with_connectors(registry, connector_refs.clone()),
        );

        core.refresh_network_policies_now(run_id, connector_refs)
            .await;

        first_mock.assert_calls(1);
        second_mock.assert_calls(1);
    }

    async fn assert_failed_network_policy_refresh_fail_closed() {
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
        assert_fail_closed_policy(&policy);

        harness.shutdown().await;
    }

    async fn assert_mismatched_network_policy_refresh_fail_closed() {
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
                            "connectorRef": "github",
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
        assert_fail_closed_policy(&policy);

        harness.shutdown().await;
    }
}
