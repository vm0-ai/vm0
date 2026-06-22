use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use agent_diagnostics::FailureDiagnostic;
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use api_contracts::generated::types::runners::storage::StorageManifest;
use futures_util::FutureExt;
use sandbox::{
    EXEC_OUTPUT_LIMIT_64_KIB, ExecResult, ExecTermination, ProcessControlMode, ProcessExit,
    ProcessOutputChunk, ProcessOutputMode, Sandbox, SandboxError, SandboxFactory, SandboxId,
};
use sandbox_mock::{MockSandbox, MockSandboxFactory};

use super::super::agent_run::{RunControls, RunStart};
use super::super::env::{guest_user_env_dir_path, guest_user_env_file_path};
use super::super::sandbox_run::{
    NewSandboxHooks, PreparedSandboxRun, execute_new_sandbox,
    execute_new_sandbox_with_prepared_notifier, execute_prepared_sandbox_run,
    execute_reused_sandbox, log_proxy_register_failure, log_proxy_register_success, register_proxy,
};
use super::super::{
    AGENT_ABNORMAL_EXIT_DIAGNOSTIC_TIMEOUT, EXIT_SIGKILL, ExecutionFailureKind, JOB_TIMEOUT,
    JobParams, NewSandboxDispatch, ResourceFailureKind, STDOUT_STREAM_LIMIT_MARKER,
    STDOUT_STREAM_OVERFLOW_MARKER, SandboxPreparedNotifier, USER_ENV_FILE_ENV_KEY, execute_job,
    execute_job_reuse, job_terminal_wait_timeout,
};
use super::support::{
    CapturedEvent, CapturedEvents, DestroyPanicFactory, QueuedCopyFileSandbox, api_storage,
    assert_proxy_registry_empty, create_overridden_sandbox, default_params,
    make_reusable_idle_sandbox, minimal_context, run_execute_inner, sandbox_create_error,
    sandbox_exec_error, sandbox_write_file_error, seed_workspace_image_cache, test_budget_lease,
    test_device_rate_limits, test_executor_config, test_telemetry,
};
use crate::ids::RunId;
use crate::paths::{RunnerPaths, scoped_session_workspace_cache_key};
use crate::types::{ResumeSession, SandboxReuseResult};
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceCacheCheckoutResult, WorkspaceCacheTerminalStatus,
    WorkspaceImageLeaseIdentity, WorkspaceImagePrepareRequest,
};
use tracing::Level;
use tracing_subscriber::prelude::*;

mod execution_diagnostics;
mod fresh_sandbox;
mod idle_pool;
mod proxy_registry;
mod reuse;
mod workspace_cache;
