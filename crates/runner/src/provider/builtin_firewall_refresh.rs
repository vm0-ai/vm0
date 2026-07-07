//! Runner-side builtin firewall catalog refresh and local cache.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use super::api::ApiClient;
use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::lock;
use crate::state_file::{self, OwnerCheck};
use crate::types::FirewallEntry;

const BUILTIN_FIREWALL_CACHE_SCHEMA_VERSION: u32 = 1;
const BUILTIN_FIREWALL_CACHE_MAX_BYTES: u64 = 16 * 1024 * 1024;
const BUILTIN_FIREWALL_PERIODIC_REFRESH_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltinFirewallsResolveRequest<'a> {
    pub(super) names: &'a [String],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltinFirewallsResolveResponse {
    pub(super) catalog_digest: String,
    pub(super) catalog_version: String,
    pub(super) firewalls: BTreeMap<String, Value>,
}

#[derive(Debug)]
pub(super) enum BuiltinFirewallResolveError {
    Permanent(String),
    Transient(String),
}

impl fmt::Display for BuiltinFirewallResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Permanent(message) | Self::Transient(message) => f.write_str(message),
        }
    }
}

#[derive(Clone)]
pub(crate) struct BuiltinFirewallRefreshHandle {
    core: BuiltinFirewallRefreshCore,
    worker: Arc<BuiltinFirewallRefreshWorker>,
}

#[derive(Clone)]
struct BuiltinFirewallRefreshCore {
    inner: Arc<BuiltinFirewallRefreshState>,
}

struct BuiltinFirewallRefreshState {
    api: ApiClient,
    store: BuiltinFirewallCacheStore,
    active_runs: Mutex<HashMap<RunId, BTreeSet<String>>>,
    cancel: CancellationToken,
    interval: Duration,
}

struct BuiltinFirewallRefreshWorker {
    core: BuiltinFirewallRefreshCore,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
struct BuiltinFirewallCacheStore {
    path: PathBuf,
    lock_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltinFirewallCatalogCache {
    schema_version: u32,
    updated_at: String,
    entries: BTreeMap<String, CachedBuiltinFirewall>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedBuiltinFirewall {
    catalog_digest: String,
    catalog_version: String,
    firewall: Value,
}

impl BuiltinFirewallRefreshHandle {
    pub(super) fn new(api: ApiClient, cache_path: PathBuf, lock_path: PathBuf) -> Self {
        Self::new_with_interval(
            api,
            cache_path,
            lock_path,
            BUILTIN_FIREWALL_PERIODIC_REFRESH_INTERVAL,
        )
    }

    fn new_with_interval(
        api: ApiClient,
        cache_path: PathBuf,
        lock_path: PathBuf,
        interval: Duration,
    ) -> Self {
        let core = BuiltinFirewallRefreshCore {
            inner: Arc::new(BuiltinFirewallRefreshState {
                api,
                store: BuiltinFirewallCacheStore {
                    path: cache_path,
                    lock_path,
                },
                active_runs: Mutex::new(HashMap::new()),
                cancel: CancellationToken::new(),
                interval,
            }),
        };
        let task = tokio::spawn(periodic_refresh_worker(core.clone()));
        Self {
            core: core.clone(),
            worker: Arc::new(BuiltinFirewallRefreshWorker {
                core,
                task: StdMutex::new(Some(task)),
            }),
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.core.inner.cancel.cancel();
        let worker_task = self.take_worker_task();
        if let Some(worker_task) = worker_task
            && let Err(error) = worker_task.await
        {
            warn!(error = %error, "builtin firewall refresh worker failed during shutdown");
        }
    }

    pub(crate) async fn ensure_firewalls_available(
        &self,
        firewalls: Option<&[FirewallEntry]>,
    ) -> RunnerResult<()> {
        let names = builtin_firewall_names(firewalls);
        self.core.refresh_required_names(names).await
    }

    pub(crate) async fn register_run(&self, run_id: RunId, firewalls: Option<&[FirewallEntry]>) {
        self.core
            .register_run(run_id, builtin_firewall_names(firewalls))
            .await;
    }

    pub(crate) async fn unregister_run(&self, run_id: RunId) {
        self.core.unregister_run(run_id).await;
    }

    fn take_worker_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.worker.take_task()
    }
}

impl BuiltinFirewallRefreshWorker {
    fn take_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for BuiltinFirewallRefreshWorker {
    fn drop(&mut self) {
        self.core.inner.cancel.cancel();
        if let Some(worker_task) = self.take_task() {
            worker_task.abort();
        }
    }
}

impl BuiltinFirewallRefreshCore {
    async fn refresh_required_names(&self, names: BTreeSet<String>) -> RunnerResult<()> {
        if names.is_empty() || self.inner.cancel.is_cancelled() {
            return Ok(());
        }

        let requested = names.iter().cloned().collect::<Vec<_>>();
        match self.inner.api.resolve_builtin_firewalls(&requested).await {
            Ok(response) => {
                let entries = validate_required_response(&requested, response)?;
                self.inner.store.merge(entries).await?;
            }
            Err(BuiltinFirewallResolveError::Transient(error)) => {
                warn!(
                    builtin_count = requested.len(),
                    error,
                    "builtin firewall resolve failed; falling back to existing local or bundled catalog"
                );
            }
            Err(BuiltinFirewallResolveError::Permanent(error)) => {
                return Err(RunnerError::Api(format!(
                    "builtin firewall resolve failed: {error}"
                )));
            }
        }
        Ok(())
    }

    async fn register_run(&self, run_id: RunId, names: BTreeSet<String>) {
        if self.inner.cancel.is_cancelled() {
            return;
        }
        let mut active_runs = self.inner.active_runs.lock().await;
        if names.is_empty() {
            active_runs.remove(&run_id);
        } else {
            active_runs.insert(run_id, names);
        }
    }

    async fn unregister_run(&self, run_id: RunId) {
        self.inner.active_runs.lock().await.remove(&run_id);
    }

    async fn refresh_active_names(&self) {
        if self.inner.cancel.is_cancelled() {
            return;
        }
        let names = self.active_builtin_names().await;
        if names.is_empty() {
            return;
        }
        let requested = names.iter().cloned().collect::<Vec<_>>();
        match self.inner.api.resolve_builtin_firewalls(&requested).await {
            Ok(response) => {
                let entries = validate_periodic_response(&requested, response);
                if entries.is_empty() {
                    return;
                }
                if let Err(error) = self.inner.store.merge(entries).await {
                    warn!(error = %error, "failed to write periodic builtin firewall cache refresh");
                }
            }
            Err(error) => {
                warn!(
                    builtin_count = requested.len(),
                    error = %error,
                    "periodic builtin firewall resolve failed; keeping previous cache"
                );
            }
        }
    }

    async fn active_builtin_names(&self) -> BTreeSet<String> {
        let active_runs = self.inner.active_runs.lock().await;
        active_runs
            .values()
            .flat_map(|names| names.iter().cloned())
            .collect()
    }
}

async fn periodic_refresh_worker(core: BuiltinFirewallRefreshCore) {
    loop {
        tokio::select! {
            () = core.inner.cancel.cancelled() => break,
            () = tokio::time::sleep(core.inner.interval) => {
                core.refresh_active_names().await;
            }
        }
    }
}

fn builtin_firewall_names(firewalls: Option<&[FirewallEntry]>) -> BTreeSet<String> {
    firewalls
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| match entry {
            FirewallEntry::Builtin { name, .. } if !name.is_empty() => Some(name.clone()),
            _ => None,
        })
        .collect()
}

fn validate_required_response(
    requested: &[String],
    response: BuiltinFirewallsResolveResponse,
) -> RunnerResult<BTreeMap<String, CachedBuiltinFirewall>> {
    let mut entries = BTreeMap::new();
    for name in requested {
        let firewall = response.firewalls.get(name).ok_or_else(|| {
            RunnerError::Api(format!(
                "builtin firewall resolve response missing required firewall {name}"
            ))
        })?;
        validate_firewall_value(name, firewall).map_err(|message| {
            RunnerError::Api(format!("invalid builtin firewall {name}: {message}"))
        })?;
        entries.insert(
            name.clone(),
            CachedBuiltinFirewall {
                catalog_digest: response.catalog_digest.clone(),
                catalog_version: response.catalog_version.clone(),
                firewall: firewall.clone(),
            },
        );
    }
    Ok(entries)
}

fn validate_periodic_response(
    requested: &[String],
    response: BuiltinFirewallsResolveResponse,
) -> BTreeMap<String, CachedBuiltinFirewall> {
    let mut entries = BTreeMap::new();
    for name in requested {
        let Some(firewall) = response.firewalls.get(name) else {
            warn!(
                builtin = name,
                "periodic builtin firewall response missing active firewall"
            );
            continue;
        };
        if let Err(error) = validate_firewall_value(name, firewall) {
            warn!(
                builtin = name,
                error, "skipping invalid periodic builtin firewall response"
            );
            continue;
        }
        entries.insert(
            name.clone(),
            CachedBuiltinFirewall {
                catalog_digest: response.catalog_digest.clone(),
                catalog_version: response.catalog_version.clone(),
                firewall: firewall.clone(),
            },
        );
    }
    entries
}

fn validate_firewall_value(name: &str, firewall: &Value) -> Result<(), String> {
    let object = firewall
        .as_object()
        .ok_or_else(|| "firewall must be a JSON object".to_string())?;
    if let Some(raw_name) = object.get("name") {
        match raw_name.as_str() {
            Some(actual) if actual == name => {}
            Some(actual) => {
                return Err(format!("name field {actual:?} does not match response key"));
            }
            None => return Err("name field must be a string when present".to_string()),
        }
    }
    let apis = object
        .get("apis")
        .and_then(Value::as_array)
        .ok_or_else(|| "apis must be a list".to_string())?;
    if apis.iter().any(|api| !api.is_object()) {
        return Err("api entries must be objects".to_string());
    }
    Ok(())
}

impl BuiltinFirewallCacheStore {
    async fn merge(&self, entries: BTreeMap<String, CachedBuiltinFirewall>) -> RunnerResult<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let _guard = lock::acquire(self.lock_path.clone()).await?;
        let mut cache = self.read_cache_or_empty().await;
        cache.entries.extend(entries);
        cache.updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let content = serialize_cache(&cache)?;
        state_file::write_private_atomic(&self.path, &content)
            .await
            .map_err(|e| {
                RunnerError::Internal(format!(
                    "write builtin firewall cache {}: {e}",
                    self.path.display()
                ))
            })
    }

    async fn read_cache_or_empty(&self) -> BuiltinFirewallCatalogCache {
        let content = match state_file::read_to_string(
            &self.path,
            BUILTIN_FIREWALL_CACHE_MAX_BYTES,
            OwnerCheck::CurrentEuid,
        )
        .await
        {
            Ok(Some(content)) => content,
            Ok(None) => return empty_cache(),
            Err(error) => {
                warn!(
                    path = %self.path.display(),
                    error = %error,
                    "ignoring unreadable builtin firewall cache before merge"
                );
                return empty_cache();
            }
        };

        match serde_json::from_str::<BuiltinFirewallCatalogCache>(&content) {
            Ok(mut cache) if cache.schema_version == BUILTIN_FIREWALL_CACHE_SCHEMA_VERSION => {
                cache.entries.retain(|name, entry| {
                    if let Err(error) = validate_firewall_value(name, &entry.firewall) {
                        warn!(
                            path = %self.path.display(),
                            builtin = name,
                            error,
                            "dropping invalid existing builtin firewall cache entry before merge"
                        );
                        return false;
                    }
                    true
                });
                cache
            }
            Ok(cache) => {
                warn!(
                    path = %self.path.display(),
                    schema_version = cache.schema_version,
                    "ignoring unsupported builtin firewall cache schema before merge"
                );
                empty_cache()
            }
            Err(error) => {
                warn!(
                    path = %self.path.display(),
                    error = %error,
                    "ignoring malformed builtin firewall cache before merge"
                );
                empty_cache()
            }
        }
    }
}

fn serialize_cache(cache: &BuiltinFirewallCatalogCache) -> RunnerResult<Vec<u8>> {
    let content = serde_json::to_vec(cache)
        .map_err(|e| RunnerError::Internal(format!("serialize builtin firewall cache: {e}")))?;
    if content.len() as u64 > BUILTIN_FIREWALL_CACHE_MAX_BYTES {
        return Err(RunnerError::Internal(format!(
            "builtin firewall cache exceeds {} bytes",
            BUILTIN_FIREWALL_CACHE_MAX_BYTES
        )));
    }
    Ok(content)
}

fn empty_cache() -> BuiltinFirewallCatalogCache {
    BuiltinFirewallCatalogCache {
        schema_version: BUILTIN_FIREWALL_CACHE_SCHEMA_VERSION,
        updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        entries: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::Method::POST;
    use httpmock::MockServer;
    use serde_json::json;

    use crate::http::{HttpClient, HttpClientConfig};

    fn cache_store(dir: &tempfile::TempDir) -> BuiltinFirewallCacheStore {
        BuiltinFirewallCacheStore {
            path: dir.path().join("builtin-firewall-cache.json"),
            lock_path: dir.path().join("builtin-firewall-cache.json.lock"),
        }
    }

    fn cached_firewall(name: &str, base: &str) -> CachedBuiltinFirewall {
        CachedBuiltinFirewall {
            catalog_digest: "sha256:test".to_string(),
            catalog_version: "test.1".to_string(),
            firewall: json!({
                "name": name,
                "apis": [
                    {
                        "base": base,
                        "auth": {},
                        "hostPolicy": {"type": "fixed"}
                    }
                ]
            }),
        }
    }

    async fn read_cache(path: &std::path::Path) -> BuiltinFirewallCatalogCache {
        let content = tokio::fs::read_to_string(path).await.unwrap();
        serde_json::from_str(&content).unwrap()
    }

    fn http_client(api_url: String) -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url,
            vercel_bypass: None,
        })
        .unwrap()
    }

    #[tokio::test]
    async fn cache_merge_preserves_unrelated_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = cache_store(&dir);
        store
            .merge(BTreeMap::from([(
                "github".to_string(),
                cached_firewall("github", "https://api.github.com"),
            )]))
            .await
            .unwrap();
        store
            .merge(BTreeMap::from([(
                "slack".to_string(),
                cached_firewall("slack", "https://slack.com/api"),
            )]))
            .await
            .unwrap();

        let cache = read_cache(&store.path).await;
        assert!(cache.entries.contains_key("github"));
        assert!(cache.entries.contains_key("slack"));
    }

    #[tokio::test]
    async fn cache_merge_drops_invalid_existing_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = cache_store(&dir);
        store
            .merge(BTreeMap::from([(
                "github".to_string(),
                cached_firewall("github", "https://api.github.com"),
            )]))
            .await
            .unwrap();
        let mut cache = read_cache(&store.path).await;
        cache.entries.insert(
            "bad".to_string(),
            CachedBuiltinFirewall {
                catalog_digest: "sha256:bad".to_string(),
                catalog_version: "bad.1".to_string(),
                firewall: json!({"name": "bad", "apis": "invalid"}),
            },
        );
        let content = serde_json::to_vec(&cache).unwrap();
        state_file::write_private_atomic(&store.path, &content)
            .await
            .unwrap();

        store
            .merge(BTreeMap::from([(
                "slack".to_string(),
                cached_firewall("slack", "https://slack.com/api"),
            )]))
            .await
            .unwrap();

        let cache = read_cache(&store.path).await;
        assert!(cache.entries.contains_key("github"));
        assert!(cache.entries.contains_key("slack"));
        assert!(!cache.entries.contains_key("bad"));
    }

    #[tokio::test]
    async fn cache_merge_rejects_oversized_cache_without_overwriting_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let store = cache_store(&dir);
        store
            .merge(BTreeMap::from([(
                "github".to_string(),
                cached_firewall("github", "https://api.github.com"),
            )]))
            .await
            .unwrap();
        let original_content = tokio::fs::read_to_string(&store.path).await.unwrap();
        let oversized_base = format!(
            "https://{}.example.com",
            "a".repeat(BUILTIN_FIREWALL_CACHE_MAX_BYTES as usize)
        );

        let error = store
            .merge(BTreeMap::from([(
                "slack".to_string(),
                cached_firewall("slack", &oversized_base),
            )]))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("builtin firewall cache exceeds"));
        assert_eq!(
            tokio::fs::read_to_string(&store.path).await.unwrap(),
            original_content
        );
    }

    #[tokio::test]
    async fn invalid_required_response_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let store = cache_store(&dir);
        let response = BuiltinFirewallsResolveResponse {
            catalog_digest: "sha256:test".to_string(),
            catalog_version: "test.1".to_string(),
            firewalls: BTreeMap::from([(
                "github".to_string(),
                json!({"name": "github", "apis": "not-a-list"}),
            )]),
        };

        let error = validate_required_response(&["github".to_string()], response).unwrap_err();

        assert!(error.to_string().contains("apis must be a list"));
        assert!(!store.path.exists());
    }

    #[tokio::test]
    async fn on_demand_refresh_preserves_raw_runtime_fields() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/runners/builtin-firewalls/resolve")
                    .header("authorization", "Bearer runner-token")
                    .json_body(json!({"names": ["github"]}));
                then.status(200).json_body(json!({
                    "catalogDigest": "sha256:live",
                    "catalogVersion": "live.1",
                    "firewalls": {
                        "github": {
                            "name": "github",
                            "apis": [
                                {
                                    "base": "https://api.github.com",
                                    "auth": {},
                                    "hostPolicy": {"type": "fixed"}
                                }
                            ]
                        }
                    }
                }));
            })
            .await;
        let dir = tempfile::tempdir().unwrap();
        let handle = BuiltinFirewallRefreshHandle::new_with_interval(
            ApiClient::new(http_client(server.base_url()), "runner-token".to_string()),
            dir.path().join("builtin-firewall-cache.json"),
            dir.path().join("builtin-firewall-cache.json.lock"),
            Duration::from_secs(3600),
        );
        let firewalls = vec![FirewallEntry::Builtin {
            name: "github".to_string(),
            base_url_vars: None,
        }];

        handle
            .ensure_firewalls_available(Some(&firewalls))
            .await
            .unwrap();
        handle.shutdown().await;

        mock.assert_async().await;
        let cache = read_cache(&dir.path().join("builtin-firewall-cache.json")).await;
        assert_eq!(cache.entries["github"].catalog_digest, "sha256:live");
        assert_eq!(
            cache.entries["github"].firewall["apis"][0]["hostPolicy"]["type"],
            "fixed"
        );
    }

    #[tokio::test]
    async fn active_refresh_updates_registered_builtin_names() {
        let server = MockServer::start_async().await;
        let mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/runners/builtin-firewalls/resolve")
                    .json_body(json!({"names": ["github"]}));
                then.status(200).json_body(json!({
                    "catalogDigest": "sha256:periodic",
                    "catalogVersion": "periodic.1",
                    "firewalls": {
                        "github": {
                            "name": "github",
                            "apis": [{"base": "https://api.github.com", "auth": {}}]
                        }
                    }
                }));
            })
            .await;
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-cache.json");
        let handle = BuiltinFirewallRefreshHandle::new_with_interval(
            ApiClient::new(http_client(server.base_url()), "runner-token".to_string()),
            cache_path.clone(),
            dir.path().join("builtin-firewall-cache.json.lock"),
            Duration::from_secs(3600),
        );
        let firewalls = vec![FirewallEntry::Builtin {
            name: "github".to_string(),
            base_url_vars: None,
        }];

        handle.register_run(RunId::new_v4(), Some(&firewalls)).await;
        handle.core.refresh_active_names().await;
        handle.shutdown().await;

        mock.assert_async().await;
        let cache = read_cache(&cache_path).await;
        assert!(cache.entries.contains_key("github"));
    }

    #[tokio::test]
    async fn periodic_refresh_skips_invalid_entries_without_overwriting_cache() {
        let server = MockServer::start_async().await;
        let _mock = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/api/runners/builtin-firewalls/resolve")
                    .json_body(json!({"names": ["github"]}));
                then.status(200).json_body(json!({
                    "catalogDigest": "sha256:invalid",
                    "catalogVersion": "invalid.1",
                    "firewalls": {
                        "github": {"name": "github", "apis": "bad"}
                    }
                }));
            })
            .await;
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-cache.json");
        let store = BuiltinFirewallCacheStore {
            path: cache_path.clone(),
            lock_path: dir.path().join("builtin-firewall-cache.json.lock"),
        };
        store
            .merge(BTreeMap::from([(
                "github".to_string(),
                cached_firewall("github", "https://old.example.com"),
            )]))
            .await
            .unwrap();
        let handle = BuiltinFirewallRefreshHandle::new_with_interval(
            ApiClient::new(http_client(server.base_url()), "runner-token".to_string()),
            cache_path.clone(),
            dir.path().join("builtin-firewall-cache.json.lock"),
            Duration::from_secs(3600),
        );
        let firewalls = vec![FirewallEntry::Builtin {
            name: "github".to_string(),
            base_url_vars: None,
        }];

        handle.register_run(RunId::new_v4(), Some(&firewalls)).await;
        handle.core.refresh_active_names().await;
        handle.shutdown().await;

        let cache = read_cache(&cache_path).await;
        assert_eq!(
            cache.entries["github"].firewall["apis"][0]["base"],
            "https://old.example.com"
        );
    }
}
