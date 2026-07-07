//! Runner-owned builtin firewall catalog cache refresh.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::api::ApiClient;
use crate::error::{RunnerError, RunnerResult};
use crate::lock;
use crate::types::Firewall;

pub(super) const BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL: Duration = Duration::from_secs(5 * 60);
const BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltinFirewallCatalog {
    pub(super) catalog_digest: String,
    pub(super) catalog_version: String,
    pub(super) firewalls: BTreeMap<String, Firewall>,
}

impl BuiltinFirewallCatalog {
    pub(super) fn validate_for_api_response(&self) -> Result<(), String> {
        validate_catalog_digest(&self.catalog_digest)?;
        if self.catalog_version.is_empty() {
            return Err("catalogVersion must be non-empty".to_string());
        }
        validate_firewall_map(&self.firewalls)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BuiltinFirewallCatalogCache {
    schema_version: u32,
    catalog_digest: String,
    catalog_version: String,
    updated_at: String,
    firewalls: BTreeMap<String, Firewall>,
}

impl BuiltinFirewallCatalogCache {
    fn from_catalog(catalog: BuiltinFirewallCatalog) -> Self {
        Self {
            schema_version: BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
            catalog_digest: catalog.catalog_digest,
            catalog_version: catalog.catalog_version,
            updated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            firewalls: catalog.firewalls,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION {
            return Err(format!("unsupported schemaVersion {}", self.schema_version));
        }
        validate_catalog_digest(&self.catalog_digest)?;
        if self.catalog_version.is_empty() {
            return Err("catalogVersion must be non-empty".to_string());
        }
        if self.updated_at.is_empty() {
            return Err("updatedAt must be non-empty".to_string());
        }
        validate_firewall_map(&self.firewalls)
    }
}

pub(super) struct BuiltinFirewallCatalogRefreshHandle {
    inner: Arc<BuiltinFirewallCatalogRefreshInner>,
}

struct BuiltinFirewallCatalogRefreshInner {
    cancel: CancellationToken,
    task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl BuiltinFirewallCatalogRefreshHandle {
    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        Self {
            inner: Arc::new(BuiltinFirewallCatalogRefreshInner {
                cancel: CancellationToken::new(),
                task: StdMutex::new(None),
            }),
        }
    }

    pub(super) async fn start(
        api: ApiClient,
        cache_path: PathBuf,
        lock_path: PathBuf,
        provider_cancel: CancellationToken,
    ) -> Self {
        if let Err(error) = refresh_once(&api, &cache_path, &lock_path).await {
            warn!(
                error = %error,
                cache_path = %cache_path.display(),
                "initial builtin firewall catalog refresh failed"
            );
        }

        let cancel = provider_cancel.child_token();
        let task = tokio::spawn(run_periodic_refresh(
            api,
            cache_path,
            lock_path,
            cancel.clone(),
            BUILTIN_FIREWALL_CATALOG_REFRESH_INTERVAL,
        ));
        Self {
            inner: Arc::new(BuiltinFirewallCatalogRefreshInner {
                cancel,
                task: StdMutex::new(Some(task)),
            }),
        }
    }

    pub(super) async fn shutdown(&self) {
        self.inner.cancel.cancel();
        let task = self.inner.take_task();
        if let Some(task) = task
            && let Err(error) = task.await
        {
            warn!(error = %error, "builtin firewall catalog refresh task failed during shutdown");
        }
    }
}

impl BuiltinFirewallCatalogRefreshInner {
    fn take_task(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.task
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
    }
}

impl Drop for BuiltinFirewallCatalogRefreshInner {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.take_task() {
            task.abort();
        }
    }
}

async fn run_periodic_refresh(
    api: ApiClient,
    cache_path: PathBuf,
    lock_path: PathBuf,
    cancel: CancellationToken,
    interval: Duration,
) {
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(interval) => {}
        }

        if cancel.is_cancelled() {
            return;
        }
        match refresh_once(&api, &cache_path, &lock_path).await {
            Ok(()) => {}
            Err(error) => {
                warn!(
                    error = %error,
                    cache_path = %cache_path.display(),
                    "periodic builtin firewall catalog refresh failed"
                );
            }
        }
    }
}

async fn refresh_once(api: &ApiClient, cache_path: &Path, lock_path: &Path) -> RunnerResult<()> {
    let catalog = api.resolve_builtin_firewall_catalog().await?;
    write_catalog_cache(cache_path, lock_path, catalog).await
}

async fn write_catalog_cache(
    cache_path: &Path,
    lock_path: &Path,
    catalog: BuiltinFirewallCatalog,
) -> RunnerResult<()> {
    let cache = BuiltinFirewallCatalogCache::from_catalog(catalog);
    cache.validate().map_err(|e| {
        RunnerError::Internal(format!("validate builtin firewall catalog cache: {e}"))
    })?;
    let content = serde_json::to_vec(&cache).map_err(|e| {
        RunnerError::Internal(format!("serialize builtin firewall catalog cache: {e}"))
    })?;
    if content.len() as u64 > crate::state_file::BUILTIN_FIREWALL_CATALOG_MAX_BYTES {
        return Err(RunnerError::Internal(format!(
            "builtin firewall catalog cache exceeds {} bytes",
            crate::state_file::BUILTIN_FIREWALL_CATALOG_MAX_BYTES
        )));
    }

    let _guard = lock::acquire(lock_path.to_path_buf()).await?;
    crate::state_file::write_private_atomic(cache_path, &content).await?;
    info!(cache_path = %cache_path.display(), "builtin firewall catalog cache refreshed");
    Ok(())
}

#[cfg(test)]
async fn read_catalog_cache(
    cache_path: &Path,
) -> RunnerResult<Option<BuiltinFirewallCatalogCache>> {
    let Some(content) = crate::state_file::read_to_string(
        cache_path,
        crate::state_file::BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
        crate::state_file::OwnerCheck::CurrentEuid,
    )
    .await?
    else {
        return Ok(None);
    };
    let cache: BuiltinFirewallCatalogCache = serde_json::from_str(&content)
        .map_err(|e| RunnerError::Internal(format!("parse builtin firewall catalog cache: {e}")))?;
    cache.validate().map_err(|e| {
        RunnerError::Internal(format!("validate builtin firewall catalog cache: {e}"))
    })?;
    Ok(Some(cache))
}

fn validate_firewall_map(firewalls: &BTreeMap<String, Firewall>) -> Result<(), String> {
    if firewalls.is_empty() {
        return Err("firewalls must be non-empty".to_string());
    }
    for (key, firewall) in firewalls {
        if key != &firewall.name {
            return Err(format!(
                "firewalls key {key:?} does not match firewall.name {:?}",
                firewall.name
            ));
        }
        firewall.validate_for_cache()?;
    }
    Ok(())
}

fn validate_catalog_digest(value: &str) -> Result<(), String> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err("catalogDigest must start with sha256:".to_string());
    };
    if hex.len() != 64
        || !hex
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        return Err("catalogDigest must be a lowercase sha256 digest".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FirewallApi, FirewallAuth, FirewallPermission};

    fn digest() -> String {
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()
    }

    fn catalog(name: &str) -> BuiltinFirewallCatalog {
        BuiltinFirewallCatalog {
            catalog_digest: digest(),
            catalog_version: "test-catalog".to_string(),
            firewalls: BTreeMap::from([(
                name.to_string(),
                Firewall {
                    name: name.to_string(),
                    apis: vec![FirewallApi {
                        id: String::new(),
                        base: "https://api.example.com".to_string(),
                        auth: FirewallAuth {
                            headers: BTreeMap::new().into_iter().collect(),
                            base: None,
                            query: None,
                            aws_sigv4: None,
                        },
                        host_policy: None,
                        permissions: Some(vec![FirewallPermission {
                            name: "read".to_string(),
                            description: None,
                            rules: vec!["GET /items".to_string()],
                        }]),
                    }],
                },
            )]),
        }
    }

    #[tokio::test]
    async fn write_catalog_cache_writes_valid_private_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();

        let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
        assert_eq!(
            cache.schema_version,
            BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION
        );
        assert_eq!(cache.catalog_digest, digest());
        assert_eq!(cache.catalog_version, "test-catalog");
        assert_eq!(cache.firewalls["github"].name, "github");
    }

    #[tokio::test]
    async fn invalid_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("slack");
        let firewall = invalid.firewalls.remove("slack").unwrap();
        invalid.firewalls.insert("wrong-key".to_string(), firewall);
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("does not match firewall.name"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn empty_api_catalog_does_not_overwrite_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        let lock_path = dir.path().join("builtin-firewall-catalog-cache.json.lock");

        write_catalog_cache(&cache_path, &lock_path, catalog("github"))
            .await
            .unwrap();
        let before = tokio::fs::read_to_string(&cache_path).await.unwrap();

        let mut invalid = catalog("github");
        invalid
            .firewalls
            .get_mut("github")
            .expect("catalog should contain github")
            .apis
            .clear();
        let error = write_catalog_cache(&cache_path, &lock_path, invalid)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("must have at least one api"),
            "unexpected error: {error}"
        );
        let after = tokio::fs::read_to_string(&cache_path).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn read_catalog_cache_rejects_malformed_cache() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("builtin-firewall-catalog-cache.json");
        tokio::fs::write(&cache_path, r#"{"schemaVersion":1}"#)
            .await
            .unwrap();

        let error = read_catalog_cache(&cache_path).await.unwrap_err();

        assert!(
            error
                .to_string()
                .contains("parse builtin firewall catalog cache"),
            "unexpected error: {error}"
        );
    }
}
