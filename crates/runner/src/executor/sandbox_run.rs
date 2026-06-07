//! Sandbox preparation, reuse, and post-run cleanup glue.

use std::panic::AssertUnwindSafe;
use std::time::Instant;

use futures_util::FutureExt;
use sandbox::{Sandbox, SandboxConfig, SandboxFactory, SandboxId};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::agent_run::{AgentExecutionResult, RunStart, run_in_sandbox};
use super::diagnostics::{
    AgentStdoutStreamDiagnostics, append_stdout_stream_diagnostics_to_stream_log, copy_guest_logs,
    read_guest_session_id,
};
use super::env::normalized_cli_agent_type;
use super::telemetry::record_workspace_cache_result;
use super::{
    ExecuteOutcome, ExecutionFailure, ExecutorConfig, JobParams, NewSandboxDispatch, RunnerError,
    RunnerResult, SandboxReuseResult,
};
use crate::ids::RunId;
use crate::network_log_manager::NetworkLogSession;
use crate::proxy;
use crate::telemetry::JobTelemetry;
use crate::types::ExecutionContext;
use crate::workspace_image_cache::{
    SessionWorkspaceCache, WorkspaceImageLease, WorkspaceImagePrepareRequest,
};
use crate::workspace_mount::ensure_workspace_drive_mounted;
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

pub(super) async fn execute_new_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> RunnerResult<ExecuteOutcome> {
    let NewSandboxDispatch {
        id: sandbox_id,
        reuse_result,
    } = dispatch;
    let mut workspace_image = prepare_workspace_image(
        context,
        sandbox_id,
        config,
        &params.profile_name,
        params.workspace_disk_mb,
        telemetry,
    )
    .await;
    let prepared = match create_started_sandbox(
        factory,
        context,
        sandbox_id,
        config,
        params,
        telemetry,
        workspace_image.as_ref(),
    )
    .await
    {
        Ok(prepared) => prepared,
        Err(e)
            if e.retry_without_workspace_image
                && workspace_image
                    .as_ref()
                    .is_some_and(WorkspaceImageLease::is_cache_hit) =>
        {
            let error = e.error;
            invalidate_workspace_cache_hit(
                workspace_image.as_ref(),
                context.run_id,
                "sandbox_prepare_failed",
            )
            .await;
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                error = %error,
                "workspace image cache hit failed during sandbox preparation; retrying with fresh workspace image"
            );
            workspace_image = None;
            create_started_sandbox(
                factory, context, sandbox_id, config, params, telemetry, None,
            )
            .await
            .map_err(|e| e.error)?
        }
        Err(e) => return Err(e.error),
    };

    let mut outcome = execute_prepared_sandbox_run(
        prepared,
        context,
        config,
        RunStart {
            restore_guest_state: params.restore_guest_state,
            reuse_result,
            prev_storage: workspace_image
                .as_ref()
                .and_then(WorkspaceImageLease::previous_storage),
        },
        telemetry,
        cancel,
    )
    .await;
    outcome.workspace_promotable = workspace_image_promotable(
        workspace_image.as_ref(),
        context,
        outcome.guest_session_id.as_deref(),
    );
    outcome.workspace_image = workspace_image;
    Ok(outcome)
}

pub(super) struct PreparedSandboxRun {
    pub(super) sandbox: Box<dyn Sandbox>,
    pub(super) source_ip: String,
    pub(super) network_log_session: NetworkLogSession,
}

pub(super) struct SandboxPrepareError {
    error: RunnerError,
    retry_without_workspace_image: bool,
}

impl SandboxPrepareError {
    fn retry(error: RunnerError) -> Self {
        Self {
            error,
            retry_without_workspace_image: true,
        }
    }

    fn fatal(error: RunnerError) -> Self {
        Self {
            error,
            retry_without_workspace_image: false,
        }
    }
}

pub(super) async fn prepare_workspace_image(
    context: &ExecutionContext,
    sandbox_id: SandboxId,
    config: &ExecutorConfig,
    profile_name: &str,
    workspace_disk_mb: u32,
    telemetry: &mut JobTelemetry,
) -> Option<WorkspaceImageLease> {
    let cache = config.workspace_cache.as_ref()?;

    if !context.session_workspace_image_cache_enabled() {
        invalidate_disabled_workspace_cache_baselines(context, cache).await;
        return None;
    }

    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            run_id: context.run_id,
            sandbox_id,
            profile_name,
            session_id: context.session_id(),
            working_dir: CANONICAL_WORKING_DIR,
            image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            workspace_drive_required: true,
        })
        .await;
    record_workspace_cache_result(telemetry, lease.result());
    Some(lease)
}

pub(super) async fn invalidate_disabled_workspace_cache_baselines(
    context: &ExecutionContext,
    cache: &SessionWorkspaceCache,
) {
    if let Err(e) = cache
        .invalidate_current_images_for_session(
            context.run_id,
            context.session_id(),
            "workspace image cache disabled by feature flag",
        )
        .await
    {
        warn!(
            run_id = %context.run_id,
            error = %e,
            "failed to invalidate disabled workspace image cache baselines"
        );
    }
}

pub(super) fn workspace_image_promotable(
    workspace_image: Option<&WorkspaceImageLease>,
    context: &ExecutionContext,
    guest_session_id: Option<&str>,
) -> bool {
    workspace_image
        .is_some_and(|image| image.can_attempt_promotion(context.session_id().or(guest_session_id)))
}

pub(super) async fn create_started_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    sandbox_id: SandboxId,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    workspace_image: Option<&WorkspaceImageLease>,
) -> Result<PreparedSandboxRun, SandboxPrepareError> {
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: params.vcpu,
            memory_mb: params.memory_mb,
        },
        device_rate_limits: params.device_rate_limits.clone(),
        workspace_drive: workspace_image.map_or_else(
            || {
                Some(sandbox::WorkspaceDriveConfig {
                    size_mb: params.workspace_disk_mb,
                    seed_image: None,
                })
            },
            WorkspaceImageLease::workspace_drive_config,
        ),
    };

    info!(run_id = %context.run_id, sandbox_id = %sandbox_id, "creating sandbox");
    let t = Instant::now();
    let mut sandbox = match factory.create(sandbox_config).await {
        Ok(s) => s,
        Err(e) => {
            telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
            return Err(SandboxPrepareError::retry(e.into()));
        }
    };

    let source_ip = sandbox.source_ip().to_string();
    let network_log_session = match register_proxy(config, context, &source_ip).await {
        Ok(session) => session,
        Err(e) => {
            telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
            destroy_sandbox_panic_safe(factory, sandbox).await;
            return Err(SandboxPrepareError::fatal(e));
        }
    };

    if let Err(e) = sandbox.start().await {
        telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
        if let Err(unregister_error) = unregister_proxy_registry(config, &source_ip).await {
            warn!(
                run_id = %context.run_id,
                error = %unregister_error,
                "failed to unregister VM from proxy after sandbox start failure"
            );
        }
        network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        destroy_sandbox_panic_safe(factory, sandbox).await;
        return Err(SandboxPrepareError::retry(e.into()));
    }
    telemetry.record("vm_create", t.elapsed(), true, None);

    let mount_started = Instant::now();
    if let Err(e) = ensure_workspace_drive_mounted(sandbox.as_ref(), context.run_id).await {
        telemetry.record(
            "workspace_drive_mount",
            mount_started.elapsed(),
            false,
            Some(&e.to_string()),
        );
        if let Err(unregister_error) = unregister_proxy_registry(config, &source_ip).await {
            warn!(
                run_id = %context.run_id,
                error = %unregister_error,
                "failed to unregister VM from proxy after workspace mount failure"
            );
        }
        network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        destroy_sandbox_panic_safe(factory, sandbox).await;
        return Err(SandboxPrepareError::retry(e));
    }
    telemetry.record("workspace_drive_mount", mount_started.elapsed(), true, None);

    Ok(PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
    })
}

pub(super) async fn invalidate_workspace_cache_hit(
    workspace_image: Option<&WorkspaceImageLease>,
    run_id: RunId,
    reason: &str,
) {
    let Some(workspace_image) = workspace_image else {
        return;
    };
    if !workspace_image.is_cache_hit() {
        return;
    }
    if let Err(e) = workspace_image.invalidate(run_id, reason).await {
        warn!(
            run_id = %run_id,
            reason,
            error = %e,
            "failed to invalidate workspace image cache entry"
        );
    }
}

pub(super) async fn destroy_sandbox_panic_safe(
    factory: &dyn SandboxFactory,
    sandbox: Box<dyn Sandbox>,
) {
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("sandbox destroy panicked after start failure");
    }
}

/// Run a job inside a reused (kept-alive) sandbox.
///
/// Skips create + start. Re-registers proxy, fixes clock/entropy, then runs.
pub(super) async fn execute_reused_sandbox(
    sandbox: Box<dyn Sandbox>,
    source_ip: &str,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    prev_storage: &crate::idle_pool::StorageFingerprints,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> ExecuteOutcome {
    info!(
        run_id = %context.run_id,
        sandbox_id = %sandbox.id(),
        "reusing kept-alive sandbox"
    );

    let source_ip = source_ip.to_string();
    let network_log_session = match register_proxy(config, context, &source_ip).await {
        Ok(session) => session,
        Err(e) => {
            return ExecuteOutcome {
                failure: Some(ExecutionFailure::from_error(e.to_string())),
                sandbox: Some(sandbox),
                source_ip,
                network_log_session: None,
                workspace_image: None,
                workspace_promotable: false,
                guest_session_id: None,
            };
        }
    };

    let mount_started = Instant::now();
    if let Err(e) = ensure_workspace_drive_mounted(sandbox.as_ref(), context.run_id).await {
        telemetry.record(
            "workspace_drive_mount",
            mount_started.elapsed(),
            false,
            Some(&e.to_string()),
        );
        if let Err(unregister_error) = unregister_proxy_registry(config, &source_ip).await {
            warn!(
                run_id = %context.run_id,
                error = %unregister_error,
                "failed to unregister VM from proxy after reused sandbox mount failure"
            );
        }
        return ExecuteOutcome {
            failure: Some(ExecutionFailure::from_error(e.to_string())),
            sandbox: Some(sandbox),
            source_ip,
            network_log_session: Some(network_log_session),
            workspace_image: None,
            workspace_promotable: false,
            guest_session_id: None,
        };
    }
    telemetry.record("workspace_drive_mount", mount_started.elapsed(), true, None);

    execute_prepared_sandbox_run(
        PreparedSandboxRun {
            sandbox,
            source_ip,
            network_log_session,
        },
        context,
        config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: Some(prev_storage),
        },
        telemetry,
        cancel,
    )
    .await
}

pub(super) async fn execute_prepared_sandbox_run(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> ExecuteOutcome {
    let PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
    } = run;

    let result = run_in_sandbox(
        sandbox.as_ref(),
        context,
        config,
        start,
        telemetry,
        cancel.clone(),
    )
    .await;

    let stdout_stream_diagnostics = result.as_ref().map_or_else(
        |_| AgentStdoutStreamDiagnostics::default(),
        |result| result.stdout_stream_diagnostics,
    );

    let cleanup_result = post_job_cleanup(
        sandbox.as_ref(),
        config,
        context,
        &source_ip,
        cancel.is_cancelled(),
        stdout_stream_diagnostics,
    )
    .await;

    let mut agent_result = match result {
        Ok(result) => result,
        Err(e) => AgentExecutionResult::failure_from_error(e.to_string()),
    };
    if let Err(e) = cleanup_result {
        warn!(
            run_id = %context.run_id,
            error = %e,
            "post-job proxy cleanup failed"
        );
        if agent_result.failure.is_none() {
            agent_result.failure = Some(ExecutionFailure::from_error(format!(
                "post-job proxy cleanup failed: {e}"
            )));
        }
    }

    // Read CLI-generated session ID for first-run parking.
    let guest_session_id = if agent_result.exit_code() == 0 && context.session_id().is_none() {
        let id = read_guest_session_id(sandbox.as_ref(), context.run_id).await;
        if let Some(ref sid) = id {
            info!(run_id = %context.run_id, session_id = %sid, "read guest session ID for parking");
        }
        id
    } else {
        None
    };

    ExecuteOutcome {
        failure: agent_result.failure,
        sandbox: Some(sandbox),
        source_ip,
        network_log_session: Some(network_log_session),
        workspace_image: None,
        workspace_promotable: false,
        guest_session_id,
    }
}

/// Register a VM in the proxy registry and network log manager.
pub(super) async fn register_proxy(
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
) -> RunnerResult<NetworkLogSession> {
    let network_log_path = config.log_paths.network_log(context.run_id);
    let proxy_log_path = config.log_paths.proxy_log(context.run_id);
    let run_id_str = context.run_id.to_string();
    let cli_agent_type = normalized_cli_agent_type(&context.cli_agent_type);
    let registration = proxy::VmRegistration {
        run_id: &run_id_str,
        cli_agent_type,
        sandbox_token: &context.sandbox_token,
        network_log_path: &network_log_path,
        proxy_log_path: &proxy_log_path,
        firewalls: context.firewalls.as_deref(),
        network_policies: context.network_policies.as_ref(),
        encrypted_secrets: context.encrypted_secrets.as_deref(),
        secret_connector_map: context.secret_connector_map.as_ref(),
        secret_connector_metadata_map: context.secret_connector_metadata_map.as_ref(),
        vars: context.vars.as_ref(),
        capture_network_bodies: context.capture_network_bodies.unwrap_or(false),
        billable_firewalls: &context.billable_firewalls,
        model_usage_provider: context.model_usage_provider.as_deref(),
    };
    config
        .registry
        .register_vm(source_ip, &registration)
        .await
        .map_err(|e| RunnerError::Internal(format!("register VM in proxy registry: {e}")))?;
    Ok(config
        .network_log_manager
        .register_source_ip(source_ip, network_log_path)
        .await)
}

/// Unregister a VM from the proxy registry.
pub(super) async fn unregister_proxy_registry(
    config: &ExecutorConfig,
    source_ip: &str,
) -> RunnerResult<()> {
    config
        .registry
        .unregister_vm(source_ip)
        .await
        .map_err(|e| RunnerError::Internal(format!("unregister VM from proxy registry: {e}")))
}

/// Post-job cleanup: copy logs, unregister proxy registry.
///
/// Called after `run_in_sandbox` completes, whether the sandbox will be
/// parked (keep-alive) or destroyed. Rust-side network-log attribution stays
/// open until `sandbox_finalization` quiesces the sandbox and closes the returned
/// `NetworkLogSession`; the HTTP upload remains deferred after `provider.complete`.
pub(super) async fn post_job_cleanup(
    sandbox: &dyn Sandbox,
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
    cancelled: bool,
    stdout_stream_diagnostics: AgentStdoutStreamDiagnostics,
) -> RunnerResult<()> {
    copy_guest_logs(sandbox, context, &config.log_paths, cancelled).await;
    append_stdout_stream_diagnostics_to_stream_log(
        context.run_id,
        &config.log_paths.system_stream_log(context.run_id),
        stdout_stream_diagnostics,
    )
    .await;
    unregister_proxy_registry(config, source_ip).await
}
