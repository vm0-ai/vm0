use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::time::Duration;

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use futures_util::FutureExt;
use guest_contracts::session_history_identity::SessionHistorySidecarExportMetadata;
use sandbox::{CopyFileOptions, EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;
use tokio::fs;
use tracing::warn;

use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};
use crate::paths::guest;
use crate::workspace_image_cache::{
    WorkspaceImagePromotionContext, WorkspaceImagePromotionOutcome,
    WorkspaceSessionHistorySidecarEntryGuard, WorkspaceSessionHistorySidecarPromotionSource,
};
use crate::workspace_mount::freeze_workspace_drive;

const SESSION_HISTORY_SIDECAR_EXPORT_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_HISTORY_SIDECAR_COPY_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_HISTORY_SIDECAR_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

enum WorkspacePromotionAction {
    Promoted,
    PreservedExisting,
    AbandonUnpublished,
}

/// A workspace image whose guest filesystem is frozen and whose sandbox must
/// now be stopped and destroyed.
///
/// The active image is not safe to publish until [`Sandbox::stop`] succeeds.
/// Callers must never resume, thaw, or pool the sandbox after preparation.
#[must_use = "a prepared workspace promotion must be published or abandoned after stopping the sandbox"]
pub(crate) struct PreparedWorkspaceImagePromotion {
    promotion: WorkspaceImagePromotionContext,
    sidecar_source: Option<SessionHistorySidecarSourceGuard>,
    reason: &'static str,
}

struct SessionHistorySidecarSourceGuard {
    entry_guard: WorkspaceSessionHistorySidecarEntryGuard,
    source: WorkspaceSessionHistorySidecarPromotionSource,
}

impl SessionHistorySidecarSourceGuard {
    fn new(
        entry_guard: WorkspaceSessionHistorySidecarEntryGuard,
        source: WorkspaceSessionHistorySidecarPromotionSource,
    ) -> Self {
        Self {
            entry_guard,
            source,
        }
    }

    fn tmp_path(&self) -> &std::path::Path {
        &self.source.tmp_path
    }

    async fn discard(self) {
        self.entry_guard
            .discard_session_history_sidecar_source(&self.source)
            .await;
    }

    async fn promote(
        &self,
        promotion: &WorkspaceImagePromotionContext,
    ) -> crate::error::RunnerResult<WorkspaceImagePromotionOutcome> {
        self.entry_guard
            .promote_with_session_history_sidecar(promotion, &self.source)
            .await
    }
}

impl Drop for SessionHistorySidecarSourceGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.source.tmp_path);
    }
}

pub(crate) async fn prepare_workspace_image_from_active_sandbox(
    sandbox: &dyn Sandbox,
    promotion: Option<WorkspaceImagePromotionContext>,
    reason: &'static str,
) -> Option<PreparedWorkspaceImagePromotion> {
    let promotion = promotion?;

    match AssertUnwindSafe(prepare_workspace_image_from_active_sandbox_inner(
        sandbox, &promotion, reason,
    ))
    .catch_unwind()
    .await
    {
        Ok(Ok(sidecar_source)) => Some(PreparedWorkspaceImagePromotion {
            promotion,
            sidecar_source,
            reason,
        }),
        Ok(Err(e)) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                error = %e,
                "workspace image cache promotion skipped because guest freeze failed"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            None
        }
        Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                "workspace image cache promotion preparation panicked"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            None
        }
    }
}

async fn prepare_workspace_image_from_active_sandbox_inner(
    sandbox: &dyn Sandbox,
    promotion: &WorkspaceImagePromotionContext,
    reason: &'static str,
) -> crate::error::RunnerResult<Option<SessionHistorySidecarSourceGuard>> {
    let mut sidecar_source = export_session_history_sidecar(sandbox, promotion, reason).await;
    if let Err(error) = freeze_workspace_drive(sandbox, promotion.run_id()).await {
        if let Some(source) = sidecar_source.take() {
            source.discard().await;
        }
        return Err(error);
    }

    Ok(sidecar_source)
}

impl PreparedWorkspaceImagePromotion {
    pub(crate) async fn publish(mut self) -> bool {
        let action = AssertUnwindSafe(self.publish_inner()).catch_unwind().await;
        match action {
            Ok(WorkspacePromotionAction::Promoted) => true,
            Ok(WorkspacePromotionAction::PreservedExisting) => false,
            Ok(WorkspacePromotionAction::AbandonUnpublished) => {
                let reason = self.reason;
                self.abandon(reason).await;
                false
            }
            Err(_) => {
                warn!(
                    run_id = %self.promotion.run_id(),
                    sandbox_id = %self.promotion.sandbox_id(),
                    profile_name = self.promotion.profile_name(),
                    reuse_key_fingerprint = %crate::paths::short_digest(self.promotion.reuse_key()),
                    reuse_key_kind = crate::types::reuse_key_kind(self.promotion.reuse_key()),
                    reason = self.reason,
                    "workspace image cache promotion publish panicked"
                );
                let reason = self.reason;
                self.abandon(reason).await;
                false
            }
        }
    }

    pub(crate) async fn abandon(mut self, reason: &'static str) {
        if let Some(source) = self.sidecar_source.take() {
            source.discard().await;
        }
        abandon_unpublished_workspace_promotion(Some(self.promotion), reason).await;
    }

    async fn publish_inner(&mut self) -> WorkspacePromotionAction {
        let promotion = &self.promotion;

        let outcome = match self.sidecar_source.as_ref() {
            Some(source) => source.promote(promotion).await,
            None => promotion.promote_without_session_history_sidecar().await,
        };
        if !matches!(outcome, Ok(WorkspaceImagePromotionOutcome::Promoted))
            && let Some(source) = self.sidecar_source.take()
        {
            source.discard().await;
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
                    reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                    reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                    reason = self.reason,
                    error = %e,
                    "workspace image cache promotion failed"
                );
                WorkspacePromotionAction::AbandonUnpublished
            }
        }
    }
}

async fn export_session_history_sidecar(
    sandbox: &dyn Sandbox,
    promotion: &WorkspaceImagePromotionContext,
    reason: &'static str,
) -> Option<SessionHistorySidecarSourceGuard> {
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
        expected_exit_codes: &[],
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
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                error = %e,
                "workspace image cache session history sidecar export errored"
            );
            cleanup_guest_session_history_sidecar_export(sandbox, promotion, &export_path, reason)
                .await;
            return None;
        }
    };
    if !helper_exec_succeeded(&result) {
        warn!(
            run_id = %promotion.run_id(),
            sandbox_id = %promotion.sandbox_id(),
            profile_name = promotion.profile_name(),
            reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
            reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
            reason,
            error = %format_helper_exec_failure("session history sidecar export", &result),
            "workspace image cache session history sidecar export failed"
        );
        cleanup_guest_session_history_sidecar_export(sandbox, promotion, &export_path, reason)
            .await;
        return None;
    }
    let metadata = match serde_json::from_slice::<SessionHistorySidecarExportMetadata>(
        result.stdout.as_slice(),
    ) {
        Ok(metadata)
            if metadata.encoded_size > 0
                && metadata.encoded_size <= RESUME_SESSION_HISTORY_MAX_BYTES =>
        {
            metadata
        }
        Ok(_) | Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                "workspace image cache session history sidecar export returned invalid metadata"
            );
            cleanup_guest_session_history_sidecar_export(sandbox, promotion, &export_path, reason)
                .await;
            return None;
        }
    };
    let Some(entry_guard) = promotion
        .try_acquire_session_history_sidecar_entry_guard()
        .await
    else {
        cleanup_guest_session_history_sidecar_export(sandbox, promotion, &export_path, reason)
            .await;
        return None;
    };
    let tmp_path = entry_guard.session_history_sidecar_tmp_path();
    let source = entry_guard.session_history_sidecar_source(
        tmp_path,
        metadata.representation,
        metadata.encoded_size,
    );
    let sidecar_source = SessionHistorySidecarSourceGuard::new(entry_guard, source);
    let _ = fs::remove_file(sidecar_source.tmp_path()).await;
    let copied = match sandbox
        .copy_file(
            &export_path,
            sidecar_source.tmp_path(),
            CopyFileOptions {
                max_bytes: RESUME_SESSION_HISTORY_MAX_BYTES,
                timeout: SESSION_HISTORY_SIDECAR_COPY_TIMEOUT,
                missing_ok: false,
            },
        )
        .await
    {
        Ok(result) => result,
        Err(e) => {
            cleanup_guest_session_history_sidecar_export(sandbox, promotion, &export_path, reason)
                .await;
            sidecar_source.discard().await;
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                error = %e,
                "workspace image cache session history sidecar copy failed"
            );
            return None;
        }
    };
    cleanup_guest_session_history_sidecar_export(sandbox, promotion, &export_path, reason).await;
    if copied.bytes_copied != metadata.encoded_size {
        sidecar_source.discard().await;
        warn!(
            run_id = %promotion.run_id(),
            sandbox_id = %promotion.sandbox_id(),
            profile_name = promotion.profile_name(),
            reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
            reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
            reason,
            copied_bytes = copied.bytes_copied,
            encoded_size = metadata.encoded_size,
            "workspace image cache session history sidecar copy size mismatch"
        );
        return None;
    }
    Some(sidecar_source)
}

async fn cleanup_guest_session_history_sidecar_export(
    sandbox: &dyn Sandbox,
    promotion: &WorkspaceImagePromotionContext,
    export_path: &str,
    reason: &'static str,
) {
    let command = ["rm -f --".to_string(), quote_shell_arg(export_path)].join(" ");
    let request = ExecRequest {
        cmd: &command,
        timeout: SESSION_HISTORY_SIDECAR_CLEANUP_TIMEOUT,
        env: &[],
        sudo: false,
        expected_exit_codes: &[],
        stdin_bytes: None,
        output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
    };
    match sandbox
        .exec_with_diagnostic_label(&request, "session-history-sidecar-cleanup")
        .await
    {
        Ok(result) if helper_exec_succeeded(&result) => {}
        Ok(result) => warn!(
            run_id = %promotion.run_id(),
            sandbox_id = %promotion.sandbox_id(),
            profile_name = promotion.profile_name(),
            reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
            reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
            reason,
            error = %format_helper_exec_failure("session history sidecar cleanup", &result),
            "workspace image cache session history sidecar cleanup failed"
        ),
        Err(e) => warn!(
            run_id = %promotion.run_id(),
            sandbox_id = %promotion.sandbox_id(),
            profile_name = promotion.profile_name(),
            reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
            reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
            reason,
            error = %e,
            "workspace image cache session history sidecar cleanup errored"
        ),
    }
}

pub(crate) async fn prepare_workspace_image_from_parked_sandbox(
    sandbox: &mut dyn Sandbox,
    promotion: Option<WorkspaceImagePromotionContext>,
    reason: &'static str,
) -> Option<PreparedWorkspaceImagePromotion> {
    let promotion = promotion?;

    match AssertUnwindSafe(sandbox.unpark()).catch_unwind().await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                error = %e,
                "workspace image cache promotion skipped because idle sandbox unpark failed"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            return None;
        }
        Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                reuse_key_fingerprint = %crate::paths::short_digest(promotion.reuse_key()),
                reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key()),
                reason,
                "workspace image cache promotion skipped because idle sandbox unpark panicked"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            return None;
        }
    }

    prepare_workspace_image_from_active_sandbox(sandbox, Some(promotion), reason).await
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
    let reuse_key_fingerprint = crate::paths::short_digest(promotion.reuse_key());
    let reuse_key_kind = crate::types::reuse_key_kind(promotion.reuse_key());
    match promotion.abandon_unpublished(reason).await {
        Ok(abandoned) => abandoned,
        Err(e) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                profile_name,
                reuse_key_fingerprint = %reuse_key_fingerprint,
                reuse_key_kind,
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
