//! Derived webhook URLs — built from `VM0_API_URL`.

use crate::env;
use std::sync::LazyLock;

static EVENTS_URL: LazyLock<String> =
    LazyLock::new(|| format!("{}/api/webhooks/agent/events", env::api_url()));
static CHECKPOINT_URL: LazyLock<String> =
    LazyLock::new(|| format!("{}/api/webhooks/agent/checkpoints", env::api_url()));
static HEARTBEAT_URL: LazyLock<String> =
    LazyLock::new(|| format!("{}/api/webhooks/agent/heartbeat", env::api_url()));
static TELEMETRY_URL: LazyLock<String> =
    LazyLock::new(|| format!("{}/api/webhooks/agent/telemetry", env::api_url()));
static STORAGE_PREPARE_URL: LazyLock<String> =
    LazyLock::new(|| format!("{}/api/webhooks/agent/storages/prepare", env::api_url()));
static STORAGE_COMMIT_URL: LazyLock<String> =
    LazyLock::new(|| format!("{}/api/webhooks/agent/storages/commit", env::api_url()));

pub fn events_url() -> &'static str {
    &EVENTS_URL
}
pub fn checkpoint_url() -> &'static str {
    &CHECKPOINT_URL
}
pub fn heartbeat_url() -> &'static str {
    &HEARTBEAT_URL
}
pub fn telemetry_url() -> &'static str {
    &TELEMETRY_URL
}
pub fn storage_prepare_url() -> &'static str {
    &STORAGE_PREPARE_URL
}
pub fn storage_commit_url() -> &'static str {
    &STORAGE_COMMIT_URL
}
