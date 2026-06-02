// Each #[tokio::test] spins up an isolated single-thread runtime, so
// tokio::sync::Mutex cannot wake waiters across runtimes. A std Mutex
// serialises correctly (each runtime owns its own OS thread).
#![allow(clippy::await_holding_lock)]

#[macro_use]
mod support;

mod checkpoint;
mod complete;
mod events;
mod heartbeat;
mod http_client;
mod presigned_upload;
mod telemetry;
