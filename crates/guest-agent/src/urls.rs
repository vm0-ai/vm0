//! Derived webhook URLs — built from `VM0_API_URL`.

use crate::env;
use api_contracts::generated::routes;
use std::sync::LazyLock;

static EVENTS_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::events::SEND.url(env::api_url()));
static CHECKPOINT_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::checkpoints::CREATE.url(env::api_url()));
static COMPLETE_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::complete::COMPLETE.url(env::api_url()));
static HEARTBEAT_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::heartbeat::SEND.url(env::api_url()));
static TELEMETRY_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::telemetry::SEND.url(env::api_url()));
static CHECKPOINT_PREPARE_HISTORY_URL: LazyLock<String> = LazyLock::new(|| {
    routes::webhooks::agent::checkpoints::prepare_history::PREPARE.url(env::api_url())
});
static STORAGE_PREPARE_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::storages::prepare::PREPARE.url(env::api_url()));
static STORAGE_COMMIT_URL: LazyLock<String> =
    LazyLock::new(|| routes::webhooks::agent::storages::commit::COMMIT.url(env::api_url()));

pub fn events_url() -> &'static str {
    &EVENTS_URL
}
pub fn checkpoint_url() -> &'static str {
    &CHECKPOINT_URL
}
pub fn complete_url() -> &'static str {
    &COMPLETE_URL
}
pub fn heartbeat_url() -> &'static str {
    &HEARTBEAT_URL
}
pub fn telemetry_url() -> &'static str {
    &TELEMETRY_URL
}
pub fn checkpoint_prepare_history_url() -> &'static str {
    &CHECKPOINT_PREPARE_HISTORY_URL
}
pub fn storage_prepare_url() -> &'static str {
    &STORAGE_PREPARE_URL
}
pub fn storage_commit_url() -> &'static str {
    &STORAGE_COMMIT_URL
}
