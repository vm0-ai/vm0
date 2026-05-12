//! Firecracker-backed implementation of the `sandbox` provider traits.
//!
//! This crate wires Firecracker microVMs, host networking, COW rootfs devices,
//! vsock control, and snapshot creation behind the provider-neutral traits from
//! the `sandbox` crate. Most runner code should target those traits; use this
//! crate directly when constructing the Firecracker provider or when a tool
//! needs Firecracker-specific controls.
//!
//! The main entry points are:
//!
//! - [`FirecrackerRuntime`], which manages shared host resources and creates
//!   [`FirecrackerFactory`] instances.
//! - [`FirecrackerFactory`], which creates and destroys [`FirecrackerSandbox`]
//!   instances for a configured rootfs, kernel, and profile.
//! - [`FirecrackerSandbox`], the running microVM implementation of the
//!   `sandbox::Sandbox` trait.
//! - [`FirecrackerControl`], which exposes control-plane operations for a
//!   running sandbox.
//! - [`FirecrackerSnapshotProvider`], which creates snapshots compatible with
//!   this provider.
//! - [`NetnsPool`] and [`NetnsLease`], for code that must manage provider
//!   network resources directly.
//!
//! Lower-level helpers such as [`ApiClient`] and the exported path/config types
//! are public for runner integration and diagnostics, but they are not the
//! preferred abstraction for normal sandbox lifecycle code.

mod api;
mod balloon;
mod command;
mod config;
pub mod control;
mod cow_pool;
mod factory;
mod leaked_resources;
mod network;
mod paths;
mod prerequisites;
mod process;
mod runtime;
mod sandbox;
mod snapshot;

pub use api::{ApiClient, ApiError, BalloonStatistics};
pub use config::{FirecrackerConfig, SnapshotConfig};
pub use control::FirecrackerControl;
pub use factory::{FirecrackerFactory, PREWARM_SCRIPT, config_hash};
pub use network::{NetnsInfo, NetnsLease, NetnsPool, NetnsPoolConfig};
pub use paths::{
    FactoryPaths, LockPaths, RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths,
};
pub use runtime::{FirecrackerRuntime, FirecrackerRuntimeProvider};
pub use sandbox::FirecrackerSandbox;
pub use snapshot::{
    FirecrackerSnapshotProvider, SNAPSHOT_COMPLETE_MARKER_CONTENT, SnapshotError, create_snapshot,
};
