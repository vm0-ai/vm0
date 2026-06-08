//! Provider-neutral sandbox traits and shared types.
//!
//! This crate defines the API used by runners and higher-level orchestration
//! code to create, control, snapshot, and tear down isolated execution
//! environments. It does not start a sandbox by itself; concrete providers
//! implement these traits in separate crates.
//!
//! The main extension points are:
//!
//! - [`SandboxRuntime`], which owns provider-wide resources and creates
//!   [`SandboxFactory`] instances.
//! - [`SandboxFactory`], which creates and destroys [`Sandbox`] instances.
//! - [`Sandbox`], which represents a running isolated environment.
//! - [`SandboxControl`], which exposes host-side control operations.
//! - [`SnapshotProvider`], which creates provider-specific snapshots.
//!
//! Configuration, result, and error types are shared here so provider crates
//! can expose a consistent lifecycle and failure model.

mod config;
mod control;
mod error;
mod factory;
mod runtime;
mod sandbox;
mod snapshot;
mod types;

pub use config::{
    BlockRateLimits, DeviceRateLimits, FactoryConfig, NetworkRateLimits, ResourceLimits,
    RuntimeConfig, SandboxConfig, SandboxId, SnapshotRef, WorkspaceDriveConfig,
};
pub use control::{RemoteExecResult, RemoteKillResult, SandboxControl, SandboxControlError};
pub use error::{
    Result, SandboxError, SandboxIdleTransition, SandboxInitializationPhase,
    SandboxInvalidStateContext, SandboxOperation, SandboxOperationReason,
};
pub use factory::SandboxFactory;
pub use runtime::{RuntimeProvider, SandboxRuntime};
pub use sandbox::Sandbox;
pub use snapshot::{
    PendingSnapshotPublish, SnapshotCreateConfig, SnapshotError, SnapshotOutput, SnapshotProvider,
};
pub use types::{
    CopyFileOptions, CopyFileResult, EXEC_OUTPUT_LIMIT_1_MIB, EXEC_OUTPUT_LIMIT_7_MIB,
    EXEC_OUTPUT_LIMIT_64_KIB, ExecOutputLimits, ExecRequest, ExecResult, GuestProcessCancelHandle,
    GuestProcessControlHandle, GuestProcessHandle, GuestProcessWaiter, ProcessControlAck,
    ProcessControlMode, ProcessExit, ProcessOutputChunk, ProcessOutputMode, ProcessOutputReceiver,
    StartProcessRequest,
};
