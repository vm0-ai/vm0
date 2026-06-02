// Each #[tokio::test] spins up an isolated single-thread runtime, so
// tokio::sync::Mutex cannot wake waiters across runtimes. A std Mutex
// serialises correctly (each runtime owns its own OS thread).
#![allow(clippy::await_holding_lock)]

#[macro_use]
#[path = "integration/support.rs"]
mod support;

#[path = "integration/checkpoint.rs"]
mod checkpoint;
#[path = "integration/complete.rs"]
mod complete;
#[path = "integration/events.rs"]
mod events;
#[path = "integration/heartbeat.rs"]
mod heartbeat;
#[path = "integration/http_client.rs"]
mod http_client;
#[path = "integration/presigned_upload.rs"]
mod presigned_upload;
#[path = "integration/telemetry.rs"]
mod telemetry;
