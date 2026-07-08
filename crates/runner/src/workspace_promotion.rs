use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::FutureExt;
use guest_contracts::session_history_identity::{
    SESSION_HISTORY_SIDECAR_MAX_BYTES, SessionHistorySidecarExportMetadata,
};
use sandbox::{CopyFileOptions, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;
use tokio::fs;
use tracing::warn;

use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
use crate::workspace_image_cache::{
    WorkspaceImagePromotionContext, WorkspaceImagePromotionOutcome,
    WorkspaceSessionHistorySidecarPromotionSource,
};
use crate::workspace_mount::flush_and_unmount_workspace_drive;

const SESSION_HISTORY_SIDECAR_EXPORT_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_HISTORY_SIDECAR_COPY_TIMEOUT: Duration = Duration::from_secs(30);

enum WorkspacePromotionAction {
    Promoted,
    PreservedExisting,
    AbandonUnpublished,
}

pub(crate) async fn promote_workspace_image_from_active_sandbox(
    sandbox: &dyn Sandbox,
    promotion: Option<WorkspaceImagePromotionContext>,
    reason: &'static str,
) -> bool {
    let Some(promotion) = promotion else {
        return false;
    };

    match AssertUnwindSafe(promote_workspace_image_from_active_sandbox_inner(
        sandbox, &promotion, reason,
    ))
    .catch_unwind()
    .await
    {
        Ok(WorkspacePromotionAction::Promoted) => true,
        Ok(WorkspacePromotionAction::PreservedExisting) => false,
        Ok(WorkspacePromotionAction::AbandonUnpublished) => {
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            false
        }
        Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                "workspace image cache promotion panicked"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            false
        }
    }
}

async fn promote_workspace_image_from_active_sandbox_inner(
    sandbox: &dyn Sandbox,
    promotion: &WorkspaceImagePromotionContext,
    reason: &'static str,
) -> WorkspacePromotionAction {
    let sidecar_source = export_session_history_sidecar(sandbox, promotion, reason).await;
    match flush_and_unmount_workspace_drive(sandbox, promotion.run_id()).await {
        Ok(()) => {}
        Err(e) => {
            if let Some(source) = sidecar_source.as_ref() {
                promotion
                    .discard_session_history_sidecar_source(source)
                    .await;
            }
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                error = %e,
                "workspace image cache promotion skipped because guest unmount failed"
            );
            return WorkspacePromotionAction::AbandonUnpublished;
        }
    }

    let outcome = promotion
        .promote_with_session_history_sidecar(sidecar_source.as_ref())
        .await;
    if !matches!(outcome, Ok(WorkspaceImagePromotionOutcome::Promoted))
        && let Some(source) = sidecar_source.as_ref()
    {
        promotion
            .discard_session_history_sidecar_source(source)
            .await;
    }
    match outcome {
        Ok(WorkspaceImagePromotionOutcome::Promoted) => WorkspacePromotionAction::Promoted,
        Ok(WorkspaceImagePromotionOutcome::PreservedExisting) => {
            WorkspacePromotionAction::PreservedExisting
        }
        Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished) => {
            WorkspacePromotionAction::AbandonUnpublished
        }
        Err(e) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                error = %e,
                "workspace image cache promotion failed"
            );
            WorkspacePromotionAction::AbandonUnpublished
        }
    }
}

async fn export_session_history_sidecar(
    sandbox: &dyn Sandbox,
    promotion: &WorkspaceImagePromotionContext,
    reason: &'static str,
) -> Option<WorkspaceSessionHistorySidecarPromotionSource> {
    let verification = promotion
        .restored_session_identity()?
        .final_metadata_verification()?;
    let export_path = guest_contracts::runtime_paths::session_history_sidecar_export_file(
        PathBuf::from(verification.runtime_dir),
    );
    let export_path = export_path.to_string_lossy().into_owned();
    let command = [
        quote_shell_arg(guest::RUN_AGENT),
        "export-session-history-sidecar".to_string(),
        quote_shell_arg(verification.metadata_path),
        quote_shell_arg(&export_path),
    ]
    .join(" ");
    let env = [(
        guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV,
        verification.runtime_dir,
    )];
    let request = ExecRequest {
        cmd: &command,
        timeout: SESSION_HISTORY_SIDECAR_EXPORT_TIMEOUT,
        env: &env,
        sudo: false,
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
    };
    let result = match sandbox
        .exec_with_diagnostic_label(&request, "session-history-sidecar-export")
        .await
    {
        Ok(result) => result,
        Err(e) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                error = %e,
                "workspace image cache session history sidecar export errored"
            );
            return None;
        }
    };
    if !helper_exec_succeeded(&result) {
        warn!(
            run_id = %promotion.run_id(),
            sandbox_id = %promotion.sandbox_id(),
            profile_name = promotion.profile_name(),
            session_id = %promotion.cli_agent_session_id(),
            reason,
            error = %format_helper_exec_failure("session history sidecar export", &result),
            "workspace image cache session history sidecar export failed"
        );
        return None;
    }
    let metadata = match serde_json::from_slice::<SessionHistorySidecarExportMetadata>(
        result.stdout.as_slice(),
    ) {
        Ok(metadata)
            if metadata.encoded_size > 0
                && metadata.encoded_size <= SESSION_HISTORY_SIDECAR_MAX_BYTES =>
        {
            metadata
        }
        Ok(_) | Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                "workspace image cache session history sidecar export returned invalid metadata"
            );
            return None;
        }
    };
    let tmp_path = promotion.session_history_sidecar_tmp_path();
    let _ = fs::remove_file(&tmp_path).await;
    let copied = match sandbox
        .copy_file(
            &export_path,
            &tmp_path,
            CopyFileOptions {
                max_bytes: SESSION_HISTORY_SIDECAR_MAX_BYTES,
                timeout: SESSION_HISTORY_SIDECAR_COPY_TIMEOUT,
                missing_ok: false,
            },
        )
        .await
    {
        Ok(result) => result,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path).await;
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                error = %e,
                "workspace image cache session history sidecar copy failed"
            );
            return None;
        }
    };
    if copied.bytes_copied != metadata.encoded_size {
        let _ = fs::remove_file(&tmp_path).await;
        warn!(
            run_id = %promotion.run_id(),
            sandbox_id = %promotion.sandbox_id(),
            profile_name = promotion.profile_name(),
            session_id = %promotion.cli_agent_session_id(),
            reason,
            copied_bytes = copied.bytes_copied,
            encoded_size = metadata.encoded_size,
            "workspace image cache session history sidecar copy size mismatch"
        );
        return None;
    }
    promotion.session_history_sidecar_source(
        tmp_path,
        metadata.representation,
        metadata.encoded_size,
    )
}

pub(crate) async fn promote_workspace_image_from_parked_sandbox(
    sandbox: &mut dyn Sandbox,
    promotion: Option<WorkspaceImagePromotionContext>,
    reason: &'static str,
) -> bool {
    let Some(promotion) = promotion else {
        return false;
    };

    match AssertUnwindSafe(sandbox.unpark()).catch_unwind().await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                error = %e,
                "workspace image cache promotion skipped because idle sandbox unpark failed"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            return false;
        }
        Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = %promotion.cli_agent_session_id(),
                reason,
                "workspace image cache promotion skipped because idle sandbox unpark panicked"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            return false;
        }
    }

    promote_workspace_image_from_active_sandbox(sandbox, Some(promotion), reason).await
}

pub(crate) async fn abandon_unpublished_workspace_promotion(
    promotion: Option<WorkspaceImagePromotionContext>,
    reason: &'static str,
) -> bool {
    let Some(promotion) = promotion else {
        return false;
    };
    let run_id = promotion.run_id();
    let sandbox_id = promotion.sandbox_id();
    let profile_name = promotion.profile_name().to_owned();
    let cli_agent_session_id = promotion.cli_agent_session_id().to_owned();
    match promotion.abandon_unpublished(reason).await {
        Ok(abandoned) => abandoned,
        Err(e) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                profile_name,
                session_id = %cli_agent_session_id,
                reason,
                error = %e,
                "workspace image cache promotion context abandonment failed"
            );
            false
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod tests;
