//! Sandbox preparation, reuse, and post-run cleanup glue.

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use sandbox::{
    Sandbox, SandboxConfig, SandboxCreateObserver, SandboxCreateStage, SandboxError,
    SandboxFactory, SandboxId, SandboxNbdCowCreateOutcome, SandboxNbdCowCreateStage,
    SandboxNbdNetlinkConnectStage, SandboxStartObserver, SandboxStartStage,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::agent_run::{AgentExecutionResult, RunControls, RunStart, run_in_sandbox};
use super::cli_framework::{
    EffectiveCliFramework, effective_cli_framework, normalized_cli_agent_type,
};
use super::diagnostics::{
    AgentStdoutStreamDiagnostics, append_stdout_stream_diagnostics_to_stream_log,
    collect_agent_abnormal_exit_diagnostics, copy_guest_logs, explicit_enospc_evidence,
    read_guest_cli_agent_session_id,
};
use super::session_id::{
    canonical_codex_thread_id, invalid_session_id_diagnostic_preview, is_valid_session_id,
};
use super::telemetry::record_workspace_cache_result;
use super::{
    ExecuteOutcome, ExecutionFailure, ExecutorConfig, JobParams, NewSandboxDispatch, RunnerError,
    RunnerResult, SandboxPreparedNotifier, SandboxReuseResult, SessionHistoryMaterializer,
    SessionHistoryRestorePlan,
};
use crate::dns::{DnsReadinessLogObservation, inspect_readiness_log_segment};
use crate::duration::duration_ms;
use crate::ids::RunId;
use crate::network_log_manager::NetworkLogSession;
use crate::provider::NetworkPolicyRefreshRegistration;
use crate::proxy;
use crate::restored_session_identity::RestoredSessionIdentity;
use crate::storage_cache::PreparedFreshStorage;
use crate::storage_plan::build_storage_plan;
use crate::telemetry::JobTelemetry;
use crate::types::{ExecutionContext, FirewallEntry};
use crate::workspace_image_cache::{
    WorkspaceCacheCheckoutResult, WorkspaceImageLease, WorkspaceImageLeaseIdentity,
    WorkspaceImagePrepareRequest,
};
use crate::workspace_mount::ensure_workspace_drive_mounted;
use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;

const SLOW_PROXY_REGISTER_THRESHOLD: Duration = Duration::from_secs(3);
const RUNNER_FRESH_WORKSPACE_IMAGE_PREPARE: &str = "runner_fresh_workspace_image_prepare";
const RUNNER_FRESH_SANDBOX_FACTORY_CREATE: &str = "runner_fresh_sandbox_factory_create";
const RUNNER_FRESH_SANDBOX_FACTORY_COW_POOL_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_cow_pool_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DIR_RENAME: &str =
    "runner_fresh_sandbox_factory_workspace_dir_rename";
// `workspace_drive_prepare` contains the seed-copy/fresh-format child stages;
// downstream queries should not sum the parent and child durations together.
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DRIVE_PREPARE: &str =
    "runner_fresh_sandbox_factory_workspace_drive_prepare";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_SEED_SPARSE_COPY: &str =
    "runner_fresh_sandbox_factory_workspace_seed_sparse_copy";
const RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_FRESH_FORMAT: &str =
    "runner_fresh_sandbox_factory_workspace_fresh_format";
const RUNNER_FRESH_SANDBOX_FACTORY_SOCK_DIR_PREPARE: &str =
    "runner_fresh_sandbox_factory_sock_dir_prepare";
const RUNNER_FRESH_SANDBOX_FACTORY_NETNS_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_netns_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_CREATE: &str =
    "runner_fresh_sandbox_factory_nbd_cow_create";
// NBD detail durations are children of `nbd_cow_create`. Device scan is nested
// again inside device acquire, and netlink details are nested inside netlink
// connect. Downstream queries must not add nested durations to their parents.
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_LAYER_CREATE: &str =
    "runner_fresh_sandbox_factory_nbd_cow_layer_create";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_ACQUIRE: &str =
    "runner_fresh_sandbox_factory_nbd_device_acquire";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_SCAN: &str =
    "runner_fresh_sandbox_factory_nbd_device_scan";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_DISPATCH_SETUP: &str =
    "runner_fresh_sandbox_factory_nbd_dispatch_setup";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_connect";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_BLOCKING_TASK_QUEUE: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_blocking_task_queue";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_SOCKET_SETUP: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_socket_setup";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_FAMILY_RESOLVE: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_family_resolve";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_COMMAND: &str =
    "runner_fresh_sandbox_factory_nbd_netlink_connect_command";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_VERIFY: &str =
    "runner_fresh_sandbox_factory_nbd_size_verify";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_CLEANUP: &str =
    "runner_fresh_sandbox_factory_nbd_retry_cleanup";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_DELAY: &str =
    "runner_fresh_sandbox_factory_nbd_retry_delay";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_DEMAND_SCAN: &str =
    "runner_fresh_sandbox_factory_nbd_acquire_source_demand_scan";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_COOLED_CLAIM: &str =
    "runner_fresh_sandbox_factory_nbd_acquire_source_cooled_claim";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_NONE: &str =
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_none";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_ONE: &str =
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_one";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_MULTIPLE: &str =
    "runner_fresh_sandbox_factory_nbd_ebusy_retries_multiple";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_NONE: &str =
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_none";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_ONE: &str =
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_one";
const RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_MULTIPLE: &str =
    "runner_fresh_sandbox_factory_nbd_size_zero_retries_multiple";
const RUNNER_FRESH_SANDBOX_PROXY_REGISTER: &str = "runner_fresh_sandbox_proxy_register";
const RUNNER_FRESH_SANDBOX_START: &str = "runner_fresh_sandbox_start";
const RUNNER_FRESH_SANDBOX_START_BACKEND_LAUNCH: &str = "runner_fresh_sandbox_start_backend_launch";
const RUNNER_FRESH_SANDBOX_START_SNAPSHOT_LOAD_RESUME: &str =
    "runner_fresh_sandbox_start_snapshot_load_resume";
const RUNNER_FRESH_SANDBOX_START_GUEST_CONNECTION_WAIT: &str =
    "runner_fresh_sandbox_start_guest_connection_wait";
const RUNNER_FRESH_SANDBOX_START_GUEST_DNS_READINESS: &str =
    "runner_fresh_sandbox_start_guest_dns_readiness";
const RUNNER_FRESH_SANDBOX_START_RUNTIME_FINALIZE: &str =
    "runner_fresh_sandbox_start_runtime_finalize";
const RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_WORKSPACE_IMAGE: &str =
    "runner_fresh_sandbox_retry_without_workspace_image";
const RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY: &str = "runner_fresh_sandbox_dns_readiness_retry";

const WORKSPACE_IMAGE_PREPARE_INVALID_WORKING_DIR: &str =
    "workspace_image_prepare_invalid_working_dir";
const WORKSPACE_IMAGE_PREPARE_LOCK_BUSY: &str = "workspace_image_prepare_lock_busy";
const WORKSPACE_IMAGE_PREPARE_INVALID_METADATA: &str = "workspace_image_prepare_invalid_metadata";
const WORKSPACE_IMAGE_PREPARE_DISK_PRESSURE: &str = "workspace_image_prepare_disk_pressure";
const SANDBOX_FACTORY_CREATE_FAILED: &str = "sandbox_factory_create_failed";
const SANDBOX_FACTORY_CREATE_STAGE_FAILED: &str = "sandbox_factory_create_stage_failed";
const SANDBOX_PROXY_REGISTER_FAILED: &str = "sandbox_proxy_register_failed";
const SANDBOX_START_FAILED: &str = "sandbox_start_failed";
const SANDBOX_START_STAGE_FAILED: &str = "sandbox_start_stage_failed";
const DNS_READINESS_RETRY_PREPARE_FAILED: &str = "replacement_prepare_failed";
const SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN: &str = "cleanup_uncertain";

struct FreshSandboxFactoryCreateObserver<'a> {
    telemetry: &'a mut JobTelemetry,
}

struct FreshSandboxStartObserver<'a> {
    telemetry: &'a mut JobTelemetry,
}

impl SandboxStartObserver for FreshSandboxStartObserver<'_> {
    fn record_stage(&mut self, stage: SandboxStartStage, duration: Duration, success: bool) {
        let error = (!success).then_some(SANDBOX_START_STAGE_FAILED);
        self.telemetry.record(
            fresh_sandbox_start_stage_action(stage),
            duration,
            success,
            error,
        );
    }
}

fn fresh_sandbox_start_stage_action(stage: SandboxStartStage) -> &'static str {
    match stage {
        SandboxStartStage::BackendLaunch => RUNNER_FRESH_SANDBOX_START_BACKEND_LAUNCH,
        SandboxStartStage::SnapshotLoadResume => RUNNER_FRESH_SANDBOX_START_SNAPSHOT_LOAD_RESUME,
        SandboxStartStage::GuestConnectionWait => RUNNER_FRESH_SANDBOX_START_GUEST_CONNECTION_WAIT,
        SandboxStartStage::GuestDnsReadiness => RUNNER_FRESH_SANDBOX_START_GUEST_DNS_READINESS,
        SandboxStartStage::RuntimeFinalize => RUNNER_FRESH_SANDBOX_START_RUNTIME_FINALIZE,
    }
}

impl SandboxCreateObserver for FreshSandboxFactoryCreateObserver<'_> {
    fn record_stage(&mut self, stage: SandboxCreateStage, duration: Duration, success: bool) {
        let error = if success {
            None
        } else {
            Some(SANDBOX_FACTORY_CREATE_STAGE_FAILED)
        };
        self.telemetry.record(
            fresh_sandbox_factory_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_nbd_cow_stage(
        &mut self,
        stage: SandboxNbdCowCreateStage,
        duration: Duration,
        success: bool,
    ) {
        let error = if success {
            None
        } else {
            Some(SANDBOX_FACTORY_CREATE_STAGE_FAILED)
        };
        self.telemetry.record(
            fresh_sandbox_factory_nbd_cow_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_nbd_netlink_connect_stage(
        &mut self,
        stage: SandboxNbdNetlinkConnectStage,
        duration: Duration,
        success: bool,
    ) {
        let error = if success {
            None
        } else {
            Some(SANDBOX_FACTORY_CREATE_STAGE_FAILED)
        };
        self.telemetry.record(
            fresh_sandbox_factory_nbd_netlink_connect_stage_action(stage),
            duration,
            success,
            error,
        );
    }

    fn record_nbd_cow_outcome(&mut self, outcome: SandboxNbdCowCreateOutcome) {
        self.telemetry.record(
            fresh_sandbox_factory_nbd_cow_outcome_action(outcome),
            Duration::ZERO,
            true,
            None,
        );
    }
}

fn fresh_sandbox_factory_stage_action(stage: SandboxCreateStage) -> &'static str {
    match stage {
        SandboxCreateStage::CowPoolAcquire => RUNNER_FRESH_SANDBOX_FACTORY_COW_POOL_ACQUIRE,
        SandboxCreateStage::WorkspaceDirRename => RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DIR_RENAME,
        SandboxCreateStage::WorkspaceDrivePrepare => {
            RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_DRIVE_PREPARE
        }
        SandboxCreateStage::WorkspaceSeedSparseCopy => {
            RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_SEED_SPARSE_COPY
        }
        SandboxCreateStage::WorkspaceFreshFormat => {
            RUNNER_FRESH_SANDBOX_FACTORY_WORKSPACE_FRESH_FORMAT
        }
        SandboxCreateStage::SockDirPrepare => RUNNER_FRESH_SANDBOX_FACTORY_SOCK_DIR_PREPARE,
        SandboxCreateStage::NetnsAcquire => RUNNER_FRESH_SANDBOX_FACTORY_NETNS_ACQUIRE,
        SandboxCreateStage::NbdCowCreate => RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_CREATE,
    }
}

fn fresh_sandbox_factory_nbd_cow_stage_action(stage: SandboxNbdCowCreateStage) -> &'static str {
    match stage {
        SandboxNbdCowCreateStage::CowLayerCreate => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_COW_LAYER_CREATE
        }
        SandboxNbdCowCreateStage::DeviceAcquire => RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_ACQUIRE,
        SandboxNbdCowCreateStage::DeviceScan => RUNNER_FRESH_SANDBOX_FACTORY_NBD_DEVICE_SCAN,
        SandboxNbdCowCreateStage::DispatchSetup => RUNNER_FRESH_SANDBOX_FACTORY_NBD_DISPATCH_SETUP,
        SandboxNbdCowCreateStage::NetlinkConnect => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT
        }
        SandboxNbdCowCreateStage::SizeVerify => RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_VERIFY,
        SandboxNbdCowCreateStage::RetryCleanup => RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_CLEANUP,
        SandboxNbdCowCreateStage::RetryDelay => RUNNER_FRESH_SANDBOX_FACTORY_NBD_RETRY_DELAY,
    }
}

fn fresh_sandbox_factory_nbd_netlink_connect_stage_action(
    stage: SandboxNbdNetlinkConnectStage,
) -> &'static str {
    match stage {
        SandboxNbdNetlinkConnectStage::BlockingTaskQueue => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_BLOCKING_TASK_QUEUE
        }
        SandboxNbdNetlinkConnectStage::SocketSetup => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_SOCKET_SETUP
        }
        SandboxNbdNetlinkConnectStage::FamilyResolve => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_FAMILY_RESOLVE
        }
        SandboxNbdNetlinkConnectStage::ConnectCommand => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_NETLINK_CONNECT_COMMAND
        }
    }
}

fn fresh_sandbox_factory_nbd_cow_outcome_action(
    outcome: SandboxNbdCowCreateOutcome,
) -> &'static str {
    match outcome {
        SandboxNbdCowCreateOutcome::AcquireSourceDemandScan => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_DEMAND_SCAN
        }
        SandboxNbdCowCreateOutcome::AcquireSourceCooledClaim => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_ACQUIRE_SOURCE_COOLED_CLAIM
        }
        SandboxNbdCowCreateOutcome::EbusyRetriesNone => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_NONE
        }
        SandboxNbdCowCreateOutcome::EbusyRetriesOne => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_ONE
        }
        SandboxNbdCowCreateOutcome::EbusyRetriesMultiple => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_EBUSY_RETRIES_MULTIPLE
        }
        SandboxNbdCowCreateOutcome::SizeZeroRetriesNone => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_NONE
        }
        SandboxNbdCowCreateOutcome::SizeZeroRetriesOne => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_ONE
        }
        SandboxNbdCowCreateOutcome::SizeZeroRetriesMultiple => {
            RUNNER_FRESH_SANDBOX_FACTORY_NBD_SIZE_ZERO_RETRIES_MULTIPLE
        }
    }
}

#[cfg(test)]
pub(super) async fn execute_new_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    cancel: tokio_util::sync::CancellationToken,
) -> RunnerResult<ExecuteOutcome> {
    execute_new_sandbox_with_prepared_notifier(
        factory,
        context,
        dispatch,
        config,
        params,
        telemetry,
        NewSandboxHooks {
            controls: RunControls::new(cancel, None),
            sandbox_prepared: None,
        },
    )
    .await
}

async fn prepare_fresh_storage(
    context: &ExecutionContext,
    workspace_image: Option<&WorkspaceImageLease>,
    config: &ExecutorConfig,
    cancel: &CancellationToken,
    telemetry: &mut JobTelemetry,
) -> RunnerResult<Option<PreparedFreshStorage>> {
    let Some(manifest) = &context.storage_manifest else {
        return Ok(None);
    };
    let apply_started = Instant::now();
    let result: RunnerResult<Option<PreparedFreshStorage>> = async {
        let runtime_dir = super::guest_runtime_dir(context.run_id)?;
        let plan = build_storage_plan(
            manifest,
            runtime_dir.as_str(),
            workspace_image.and_then(WorkspaceImageLease::previous_storage),
        )?;
        let delivery = crate::storage_cache::prepare_fresh_archive_delivery(
            &plan,
            &config.home,
            &config.fresh_archive_delivery,
            cancel,
            telemetry,
        )
        .await?;
        Ok(Some(PreparedFreshStorage { plan, delivery }))
    }
    .await;
    if let Err(error) = &result {
        telemetry.record(
            "runner_storage_manifest_apply",
            apply_started.elapsed(),
            false,
            Some(&error.to_string()),
        );
    }
    result
}

async fn cancel_prepared_storage(controls: &mut RunControls, telemetry: &mut JobTelemetry) {
    if let Some(mut prepared) = controls.prepared_storage.take() {
        prepared.delivery.cancel_and_drain(telemetry).await;
    }
}

pub(super) async fn execute_new_sandbox_with_prepared_notifier(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    hooks: NewSandboxHooks<'_>,
) -> RunnerResult<ExecuteOutcome> {
    let NewSandboxDispatch {
        id: sandbox_id,
        reuse_result,
    } = dispatch;
    let NewSandboxHooks {
        mut controls,
        sandbox_prepared,
    } = hooks;
    let prepare_started = Instant::now();
    let mut workspace_image = prepare_workspace_image(
        context,
        sandbox_id,
        config,
        &params.profile_name,
        params.workspace_disk_mb,
        telemetry,
    )
    .await;
    let prepared_storage = prepare_fresh_storage(
        context,
        workspace_image.as_ref(),
        config,
        &controls.cancel,
        telemetry,
    )
    .await;
    match prepared_storage {
        Ok(prepared_storage) => controls.prepared_storage = prepared_storage,
        Err(error) => {
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            return Err(error);
        }
    }
    controls.session_history_restore_plan = resolve_fresh_session_history_restore_plan(
        std::mem::take(&mut controls.session_history_restore_plan),
        workspace_image.as_ref(),
        context,
        config,
        controls.cancel.clone(),
        telemetry,
    )
    .await;
    let mut used_retry = false;
    let mut dns_retry: Option<(Instant, bool)> = None;
    let prepared = loop {
        let result = create_started_sandbox(
            factory,
            context,
            sandbox_id,
            config,
            params,
            telemetry,
            StartSandboxOptions {
                workspace_image: workspace_image.as_ref(),
                sandbox_prepared,
            },
        )
        .await;

        if let Some((started, workspace_fallback)) = dns_retry.take() {
            let success = result.is_ok();
            telemetry.record(
                RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY,
                started.elapsed(),
                success,
                (!success).then_some(DNS_READINESS_RETRY_PREPARE_FAILED),
            );
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                success,
                workspace_fallback,
                "guest DNS readiness replacement completed"
            );
        }

        let failure = match result {
            Ok(prepared) => break prepared,
            Err(failure) => failure,
        };
        if used_retry {
            let error = failure.error;
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            cancel_prepared_storage(&mut controls, telemetry).await;
            return Err(error);
        }

        let cache_hit = workspace_image
            .as_ref()
            .is_some_and(WorkspaceImageLease::is_cache_hit);
        let retry_guest_dns = failure.retry == SandboxPrepareRetry::GuestDnsReadiness;
        let retry_without_workspace =
            failure.retry == SandboxPrepareRetry::WithoutWorkspaceImage && cache_hit;
        if !failure.cleanup_completed {
            if retry_guest_dns {
                telemetry.record(
                    RUNNER_FRESH_SANDBOX_DNS_READINESS_RETRY,
                    Duration::ZERO,
                    false,
                    Some(SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN),
                );
                warn!(
                    run_id = %context.run_id,
                    sandbox_id = %sandbox_id,
                    "guest DNS readiness replacement suppressed after uncertain cleanup"
                );
            } else if retry_without_workspace {
                telemetry.record(
                    RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_WORKSPACE_IMAGE,
                    Duration::ZERO,
                    false,
                    Some(SANDBOX_PREPARE_RETRY_CLEANUP_UNCERTAIN),
                );
                warn!(
                    run_id = %context.run_id,
                    sandbox_id = %sandbox_id,
                    "workspace image fallback suppressed after uncertain cleanup"
                );
            }
            let error = failure.error;
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            cancel_prepared_storage(&mut controls, telemetry).await;
            return Err(error);
        }
        if !retry_guest_dns && !retry_without_workspace {
            let error = failure.error;
            telemetry.record(
                "runner_fresh_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&error.to_string()),
            );
            cancel_prepared_storage(&mut controls, telemetry).await;
            return Err(error);
        }

        if retry_guest_dns {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                error = %failure.error,
                "guest DNS readiness failed; retrying with a fresh sandbox attachment"
            );
            dns_retry = Some((Instant::now(), cache_hit));
        }

        if cache_hit {
            cancel_prepared_storage(&mut controls, telemetry).await;
            invalidate_workspace_cache_hit(
                workspace_image.as_ref(),
                context.run_id,
                "sandbox_prepare_failed",
            )
            .await;
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                error = %failure.error,
                "workspace image cache hit failed during sandbox preparation; retrying with fresh workspace image"
            );
            telemetry.record(
                RUNNER_FRESH_SANDBOX_RETRY_WITHOUT_WORKSPACE_IMAGE,
                Duration::ZERO,
                true,
                None,
            );
            workspace_image = None;
            match prepare_fresh_storage(context, None, config, &controls.cancel, telemetry).await {
                Ok(prepared_storage) => controls.prepared_storage = prepared_storage,
                Err(error) => {
                    telemetry.record(
                        "runner_fresh_sandbox_prepare",
                        prepare_started.elapsed(),
                        false,
                        Some(&error.to_string()),
                    );
                    return Err(error);
                }
            }
            controls.session_history_restore_plan =
                discard_local_sidecar_restore_plan_for_workspace_retry(
                    std::mem::take(&mut controls.session_history_restore_plan),
                    context,
                    config,
                    controls.cancel.clone(),
                    telemetry,
                );
        }
        used_retry = true;
    };
    telemetry.record(
        "runner_fresh_sandbox_prepare",
        prepare_started.elapsed(),
        true,
        None,
    );

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
        controls,
    )
    .await;
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
    retry: SandboxPrepareRetry,
    cleanup_completed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SandboxPrepareRetry {
    None,
    WithoutWorkspaceImage,
    GuestDnsReadiness,
}

pub(super) struct NewSandboxHooks<'a> {
    pub(super) controls: RunControls,
    pub(super) sandbox_prepared: Option<&'a SandboxPreparedNotifier>,
}

struct StartSandboxOptions<'a> {
    workspace_image: Option<&'a WorkspaceImageLease>,
    sandbox_prepared: Option<&'a SandboxPreparedNotifier>,
}

impl SandboxPrepareError {
    fn retry_without_workspace_image(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::WithoutWorkspaceImage,
            cleanup_completed,
        }
    }

    fn guest_dns_readiness(error: RunnerError, cleanup_completed: bool) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::GuestDnsReadiness,
            cleanup_completed,
        }
    }

    fn fatal(error: RunnerError) -> Self {
        Self {
            error,
            retry: SandboxPrepareRetry::None,
            cleanup_completed: false,
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
    let prepare_started = Instant::now();
    let lease = cache
        .prepare(WorkspaceImagePrepareRequest {
            identity: WorkspaceImageLeaseIdentity {
                run_id: context.run_id,
                sandbox_id,
                profile_name,
                cli_agent_session_id: context.cli_agent_session_id(),
                working_dir: CANONICAL_WORKING_DIR,
                image_size_bytes: u64::from(workspace_disk_mb) * 1024 * 1024,
            },
            workspace_drive_required: true,
        })
        .await;
    let prepare_error = workspace_image_prepare_error(lease.result());
    telemetry.record(
        RUNNER_FRESH_WORKSPACE_IMAGE_PREPARE,
        prepare_started.elapsed(),
        prepare_error.is_none(),
        prepare_error,
    );
    record_workspace_cache_result(telemetry, lease.result());
    Some(lease)
}

async fn resolve_fresh_session_history_restore_plan(
    plan: SessionHistoryRestorePlan,
    workspace_image: Option<&WorkspaceImageLease>,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
    telemetry: &mut JobTelemetry,
) -> SessionHistoryRestorePlan {
    let fallback = match plan {
        SessionHistoryRestorePlan::DeferredHashBacked { fallback } => fallback,
        other => return other,
    };
    let Some(workspace_image) = workspace_image else {
        return start_fresh_session_history_materializer(
            context, config, cancel, telemetry, fallback,
        );
    };
    if !workspace_image.is_cache_hit() {
        return start_fresh_session_history_materializer(
            context, config, cancel, telemetry, fallback,
        );
    }
    let Some(expected) = RestoredSessionIdentity::from_context(context) else {
        telemetry.record(
            "session_history_workspace_cache_miss",
            Duration::ZERO,
            true,
            Some("identity_mismatch"),
        );
        return start_fresh_session_history_materializer(
            context, config, cancel, telemetry, fallback,
        );
    };
    let probe_started = Instant::now();
    telemetry.record(
        "session_history_workspace_cache_probe",
        Duration::ZERO,
        true,
        None,
    );
    match workspace_image
        .probe_session_history_sidecar(&expected)
        .await
    {
        Ok(sidecar) => {
            telemetry.record(
                "session_history_workspace_cache_hit",
                probe_started.elapsed(),
                true,
                None,
            );
            SessionHistoryRestorePlan::LocalSidecar { sidecar, fallback }
        }
        Err(reason) => {
            telemetry.record(
                "session_history_workspace_cache_miss",
                probe_started.elapsed(),
                true,
                Some(reason.as_str()),
            );
            start_fresh_session_history_materializer(context, config, cancel, telemetry, fallback)
        }
    }
}

fn discard_local_sidecar_restore_plan_for_workspace_retry(
    plan: SessionHistoryRestorePlan,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
    telemetry: &mut JobTelemetry,
) -> SessionHistoryRestorePlan {
    match plan {
        SessionHistoryRestorePlan::LocalSidecar { fallback, .. } => {
            telemetry.record(
                "session_history_workspace_cache_miss",
                Duration::ZERO,
                true,
                Some("sandbox_retry_without_workspace_image"),
            );
            start_fresh_session_history_materializer(context, config, cancel, telemetry, fallback)
        }
        other => other,
    }
}

fn start_fresh_session_history_materializer(
    context: &ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
    telemetry: &mut JobTelemetry,
    fallback: Option<super::SessionHistoryRestoreFallback>,
) -> SessionHistoryRestorePlan {
    let started = Instant::now();
    let materializer = SessionHistoryMaterializer::start_cancellable(
        &config.http,
        &config.session_history_cpu,
        context.resume_session.as_ref(),
        effective_cli_framework(&context.cli_agent_type),
        cancel,
        Some(&config.session_history_probe),
    );
    telemetry.record(
        "runner_fresh_session_history_materializer_start",
        started.elapsed(),
        true,
        None,
    );
    SessionHistoryRestorePlan::Prestarted {
        materializer,
        fallback,
    }
}

fn workspace_image_prepare_error(result: WorkspaceCacheCheckoutResult) -> Option<&'static str> {
    match result {
        WorkspaceCacheCheckoutResult::Hit
        | WorkspaceCacheCheckoutResult::Miss
        | WorkspaceCacheCheckoutResult::NoSession => None,
        WorkspaceCacheCheckoutResult::InvalidWorkingDir => {
            Some(WORKSPACE_IMAGE_PREPARE_INVALID_WORKING_DIR)
        }
        WorkspaceCacheCheckoutResult::LockBusy => Some(WORKSPACE_IMAGE_PREPARE_LOCK_BUSY),
        WorkspaceCacheCheckoutResult::InvalidMetadata => {
            Some(WORKSPACE_IMAGE_PREPARE_INVALID_METADATA)
        }
        WorkspaceCacheCheckoutResult::DiskPressure => Some(WORKSPACE_IMAGE_PREPARE_DISK_PRESSURE),
    }
}

async fn create_started_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    sandbox_id: SandboxId,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    options: StartSandboxOptions<'_>,
) -> Result<PreparedSandboxRun, SandboxPrepareError> {
    let StartSandboxOptions {
        workspace_image,
        sandbox_prepared,
    } = options;
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
    let factory_create_started = Instant::now();
    let create_result = {
        let mut observer = FreshSandboxFactoryCreateObserver { telemetry };
        factory
            .create_with_observer(sandbox_config, &mut observer)
            .await
    };
    let mut sandbox = match create_result {
        Ok(s) => {
            telemetry.record(
                RUNNER_FRESH_SANDBOX_FACTORY_CREATE,
                factory_create_started.elapsed(),
                true,
                None,
            );
            s
        }
        Err(e) => {
            telemetry.record(
                RUNNER_FRESH_SANDBOX_FACTORY_CREATE,
                factory_create_started.elapsed(),
                false,
                Some(SANDBOX_FACTORY_CREATE_FAILED),
            );
            telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
            return Err(SandboxPrepareError::retry_without_workspace_image(
                e.into(),
                true,
            ));
        }
    };

    let source_ip = sandbox.source_ip().to_string();
    let proxy_register_started = Instant::now();
    let network_log_session = match register_proxy(config, context, &source_ip).await {
        Ok(session) => {
            let proxy_register_elapsed = proxy_register_started.elapsed();
            telemetry.record(
                RUNNER_FRESH_SANDBOX_PROXY_REGISTER,
                proxy_register_elapsed,
                true,
                None,
            );
            log_proxy_register_success(
                context.run_id,
                sandbox_id,
                &params.profile_name,
                proxy_register_elapsed,
            );
            session
        }
        Err(e) => {
            let proxy_register_elapsed = proxy_register_started.elapsed();
            telemetry.record(
                RUNNER_FRESH_SANDBOX_PROXY_REGISTER,
                proxy_register_elapsed,
                false,
                Some(SANDBOX_PROXY_REGISTER_FAILED),
            );
            log_proxy_register_failure(
                context.run_id,
                sandbox_id,
                &params.profile_name,
                proxy_register_elapsed,
                &e.to_string(),
            );
            telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
            let _ = destroy_sandbox_panic_safe(factory, sandbox).await;
            return Err(SandboxPrepareError::fatal(e));
        }
    };

    let network_log_path = config.log_paths.network_log(context.run_id);
    let network_log_start_offset = match tokio::fs::metadata(&network_log_path).await {
        Ok(metadata) => Some(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(0),
        Err(error) => {
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                io_kind = ?error.kind(),
                "failed to capture network log offset before sandbox start"
            );
            None
        }
    };
    let sandbox_start_started = Instant::now();
    let start_result = {
        let mut observer = FreshSandboxStartObserver { telemetry };
        sandbox.start_with_observer(&mut observer).await
    };
    if let Err(e) = start_result {
        let guest_dns_readiness = matches!(&e, SandboxError::GuestDnsReadiness { .. });
        telemetry.record(
            RUNNER_FRESH_SANDBOX_START,
            sandbox_start_started.elapsed(),
            false,
            Some(SANDBOX_START_FAILED),
        );
        telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
        let unregister_completed =
            match unregister_proxy_registry(config, &source_ip, context.run_id).await {
                Ok(()) => true,
                Err(unregister_error) => {
                    warn!(
                        run_id = %context.run_id,
                        error = %unregister_error,
                        "failed to unregister VM from proxy after sandbox start failure"
                    );
                    false
                }
            };
        let network_log_observation = network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        if guest_dns_readiness {
            let observation = match network_log_start_offset {
                Some(start_offset) => {
                    inspect_readiness_log_segment(&network_log_path, start_offset).await
                }
                None => DnsReadinessLogObservation::unavailable(),
            };
            warn!(
                run_id = %context.run_id,
                sandbox_id = %sandbox_id,
                source_ip,
                query_observed = observation.query_observed,
                result_observed = observation.result_observed,
                scan_status = observation.status.as_str(),
                dns_drain_status = network_log_observation.drain_status("dns"),
                kmsg_drain_status = network_log_observation.drain_status("kmsg"),
                writer_backpressure_observed = network_log_observation.writer_backpressure_observed(),
                "guest DNS readiness network log observation"
            );
        }
        let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
            .await
            .is_completed();
        let cleanup_completed = unregister_completed && destroy_completed;
        let error = e.into();
        return Err(if guest_dns_readiness {
            SandboxPrepareError::guest_dns_readiness(error, cleanup_completed)
        } else {
            SandboxPrepareError::retry_without_workspace_image(error, cleanup_completed)
        });
    }
    telemetry.record(
        RUNNER_FRESH_SANDBOX_START,
        sandbox_start_started.elapsed(),
        true,
        None,
    );
    telemetry.record("vm_create", t.elapsed(), true, None);

    let mount_started = Instant::now();
    if let Err(e) = ensure_workspace_drive_mounted(sandbox.as_ref(), context.run_id).await {
        telemetry.record(
            "workspace_drive_mount",
            mount_started.elapsed(),
            false,
            Some(&e.to_string()),
        );
        let unregister_completed =
            match unregister_proxy_registry(config, &source_ip, context.run_id).await {
                Ok(()) => true,
                Err(unregister_error) => {
                    warn!(
                        run_id = %context.run_id,
                        error = %unregister_error,
                        "failed to unregister VM from proxy after workspace mount failure"
                    );
                    false
                }
            };
        network_log_session
            .close_for_upload(context.run_id, &config.network_log_drain)
            .await;
        let destroy_completed = destroy_sandbox_panic_safe(factory, sandbox)
            .await
            .is_completed();
        return Err(SandboxPrepareError::retry_without_workspace_image(
            e,
            unregister_completed && destroy_completed,
        ));
    }
    telemetry.record("workspace_drive_mount", mount_started.elapsed(), true, None);
    if let Some(notifier) = sandbox_prepared {
        notifier.notify(context.run_id, sandbox_id).await;
    }

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DestroySandboxOutcome {
    Completed,
    Uncertain,
}

impl DestroySandboxOutcome {
    fn is_completed(self) -> bool {
        matches!(self, Self::Completed)
    }
}

pub(super) async fn destroy_sandbox_panic_safe(
    factory: &dyn SandboxFactory,
    sandbox: Box<dyn Sandbox>,
) -> DestroySandboxOutcome {
    if AssertUnwindSafe(factory.destroy(sandbox))
        .catch_unwind()
        .await
        .is_err()
    {
        warn!("sandbox destroy panicked after start failure");
        DestroySandboxOutcome::Uncertain
    } else {
        DestroySandboxOutcome::Completed
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
    prev_storage: &crate::storage_fingerprints::StorageFingerprints,
    telemetry: &mut JobTelemetry,
    controls: RunControls,
) -> ExecuteOutcome {
    info!(
        run_id = %context.run_id,
        sandbox_id = %sandbox.id(),
        "reusing kept-alive sandbox"
    );

    let source_ip = source_ip.to_string();
    let prepare_started = Instant::now();
    let network_log_session = match register_proxy(config, context, &source_ip).await {
        Ok(session) => session,
        Err(e) => {
            telemetry.record(
                "runner_reused_sandbox_prepare",
                prepare_started.elapsed(),
                false,
                Some(&e.to_string()),
            );
            return ExecuteOutcome {
                failure: Some(ExecutionFailure::from_error(e.to_string())),
                sandbox: Some(sandbox),
                source_ip,
                network_log_session: None,
                workspace_image: None,
                discovered_cli_agent_session_id: None,
                restored_session_identity: None,
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
        if let Err(unregister_error) =
            unregister_proxy_registry(config, &source_ip, context.run_id).await
        {
            warn!(
                run_id = %context.run_id,
                error = %unregister_error,
                "failed to unregister VM from proxy after reused sandbox mount failure"
            );
        }
        telemetry.record(
            "runner_reused_sandbox_prepare",
            prepare_started.elapsed(),
            false,
            Some(&e.to_string()),
        );
        return ExecuteOutcome {
            failure: Some(ExecutionFailure::from_error(e.to_string())),
            sandbox: Some(sandbox),
            source_ip,
            network_log_session: Some(network_log_session),
            workspace_image: None,
            discovered_cli_agent_session_id: None,
            restored_session_identity: None,
        };
    }
    telemetry.record("workspace_drive_mount", mount_started.elapsed(), true, None);
    telemetry.record(
        "runner_reused_sandbox_prepare",
        prepare_started.elapsed(),
        true,
        None,
    );

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
        controls,
    )
    .await
}

pub(super) async fn execute_prepared_sandbox_run(
    run: PreparedSandboxRun,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    controls: RunControls,
) -> ExecuteOutcome {
    let PreparedSandboxRun {
        sandbox,
        source_ip,
        network_log_session,
    } = run;
    let cleanup_cancel = controls.cancel.clone();
    let reuse_result = start.reuse_result;

    let result = run_in_sandbox(
        sandbox.as_ref(),
        context,
        config,
        start,
        telemetry,
        controls,
    )
    .await;

    let pre_process_resource_diagnostics = match result.as_ref() {
        Err(error) if explicit_enospc_evidence([error.to_string().as_str()]) => {
            collect_agent_abnormal_exit_diagnostics(
                sandbox.as_ref(),
                context.run_id,
                sandbox.id(),
                reuse_result,
                1,
            )
            .await
        }
        Ok(_) | Err(_) => None,
    };

    let stdout_stream_diagnostics = result.as_ref().map_or_else(
        |_| AgentStdoutStreamDiagnostics::default(),
        |result| result.stdout_stream_diagnostics,
    );
    let restored_session_identity = result
        .as_ref()
        .ok()
        .and_then(|result| result.reusable_session_identity.clone());

    let cleanup_result = post_job_cleanup(
        sandbox.as_ref(),
        config,
        context,
        &source_ip,
        cleanup_cancel.is_cancelled(),
        stdout_stream_diagnostics,
    )
    .await;

    let mut agent_result = match result {
        Ok(result) => result,
        Err(e) => AgentExecutionResult::failure_from_error(e.to_string())
            .with_resource_diagnostics(pre_process_resource_diagnostics),
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
    let discovered_cli_agent_session_id =
        if agent_result.exit_code() == 0 && context.cli_agent_session_id().is_none() {
            let id = read_guest_cli_agent_session_id(sandbox.as_ref(), context.run_id)
                .await
                .and_then(|id| normalize_guest_cli_agent_session_id_for_parking(context, id));
            if let Some(ref sid) = id {
                info!(
                    run_id = %context.run_id,
                    session_id = %sid,
                    "read guest session ID for parking"
                );
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
        discovered_cli_agent_session_id,
        restored_session_identity,
    }
}

fn normalize_guest_cli_agent_session_id_for_parking(
    context: &ExecutionContext,
    session_id: String,
) -> Option<String> {
    match effective_cli_framework(&context.cli_agent_type) {
        EffectiveCliFramework::Codex => canonical_codex_thread_id(&session_id).or_else(|| {
            warn!(
                run_id = %context.run_id,
                framework = "codex",
                session_id = %invalid_session_id_diagnostic_preview(&session_id),
                "ignoring invalid guest session ID for framework"
            );
            None
        }),
        EffectiveCliFramework::ClaudeCode => {
            if is_valid_session_id(&session_id) {
                Some(session_id)
            } else {
                warn!(
                    run_id = %context.run_id,
                    framework = "claude-code",
                    session_id = %invalid_session_id_diagnostic_preview(&session_id),
                    "ignoring invalid guest session ID for framework"
                );
                None
            }
        }
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
    let network_log_session = config
        .network_log_manager
        .register_source_ip(source_ip, network_log_path)
        .await;
    if let Some(refresh) = config.network_policy_refresh.as_ref() {
        let connector_refs = active_connector_refs(context);
        refresh
            .register_run(NetworkPolicyRefreshRegistration {
                run_id: context.run_id,
                source_ip,
                registry: config.registry.clone(),
                connector_refs,
                refreshes: context.network_policy_refreshes.as_ref(),
            })
            .await;
    }
    Ok(network_log_session)
}

fn active_connector_refs(context: &ExecutionContext) -> HashSet<String> {
    let Some(network_policies) = context.network_policies.as_ref() else {
        return HashSet::new();
    };
    context
        .firewalls
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let FirewallEntry::Builtin { name, .. } = entry else {
                return None;
            };
            (!name.starts_with("model-provider:") && network_policies.contains_key(name.as_str()))
                .then_some(name)
        })
        .map(|name| name.to_string())
        .collect()
}

pub(super) fn log_proxy_register_success(
    run_id: RunId,
    sandbox_id: SandboxId,
    profile: &str,
    elapsed: Duration,
) {
    if elapsed < SLOW_PROXY_REGISTER_THRESHOLD {
        info!(
            stage = "proxy_register",
            elapsed_ms = duration_ms(elapsed),
            threshold_ms = duration_ms(SLOW_PROXY_REGISTER_THRESHOLD),
            success = true,
            run_id = %run_id,
            sandbox_id = %sandbox_id,
            profile,
            "proxy register timing"
        );
        return;
    }
    warn!(
        stage = "proxy_register",
        elapsed_ms = duration_ms(elapsed),
        threshold_ms = duration_ms(SLOW_PROXY_REGISTER_THRESHOLD),
        success = true,
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        profile,
        "slow proxy register"
    );
}

pub(super) fn log_proxy_register_failure(
    run_id: RunId,
    sandbox_id: SandboxId,
    profile: &str,
    elapsed: Duration,
    error: &str,
) {
    warn!(
        stage = "proxy_register",
        elapsed_ms = duration_ms(elapsed),
        success = false,
        run_id = %run_id,
        sandbox_id = %sandbox_id,
        profile,
        error,
        "proxy register failed"
    );
}

/// Unregister a VM from the proxy registry.
pub(super) async fn unregister_proxy_registry(
    config: &ExecutorConfig,
    source_ip: &str,
    run_id: RunId,
) -> RunnerResult<()> {
    let result = config
        .registry
        .unregister_vm(source_ip)
        .await
        .map_err(|e| RunnerError::Internal(format!("unregister VM from proxy registry: {e}")));
    if let Some(refresh) = config.network_policy_refresh.as_ref() {
        refresh.unregister_run(run_id).await;
    }
    result
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
    unregister_proxy_registry(config, source_ip, context.run_id).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::types::{Firewall, FirewallApi, FirewallAuth, FirewallPermission, NetworkPolicy};

    fn network_policy() -> NetworkPolicy {
        NetworkPolicy {
            allow: Vec::new(),
            deny: Vec::new(),
            ask: Vec::new(),
            unknown_policy: "ask".to_string(),
        }
    }

    #[test]
    fn active_connector_refs_only_include_builtin_connectors_with_network_policy() {
        let mut context = crate::test_fixtures::execution_context_for_test(RunId::nil());
        context.firewalls = Some(vec![
            FirewallEntry::Builtin {
                name: "github".to_string(),
                base_url_vars: None,
            },
            FirewallEntry::Inline {
                firewall: Firewall {
                    name: "custom-crm".to_string(),
                    apis: vec![FirewallApi {
                        id: "custom-crm-api".to_string(),
                        base: "https://crm.example.com".to_string(),
                        auth: FirewallAuth {
                            headers: HashMap::new(),
                            base: None,
                            query: None,
                            aws_sigv4: None,
                        },
                        host_policy: None,
                        permissions: Some(vec![FirewallPermission {
                            name: "records.read".to_string(),
                            description: None,
                            rules: vec!["GET /records".to_string()],
                        }]),
                    }],
                },
            },
            FirewallEntry::Builtin {
                name: "model-provider:openai".to_string(),
                base_url_vars: None,
            },
        ]);
        context.network_policies = Some(HashMap::from([
            ("github".to_string(), network_policy()),
            ("custom-crm".to_string(), network_policy()),
            ("model-provider:openai".to_string(), network_policy()),
            ("not-active".to_string(), network_policy()),
        ]));

        let refs = active_connector_refs(&context);

        assert_eq!(refs, HashSet::from(["github".to_string()]));
    }
}
