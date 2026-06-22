use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use sandbox::Sandbox;
use tracing::warn;

use crate::paths::diagnostic_session_fingerprint;
use crate::workspace_image_cache::{
    WorkspaceImagePromotionContext, WorkspaceImagePromotionOutcome,
};
use crate::workspace_mount::flush_and_unmount_workspace_drive;

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
            let session_fingerprint =
                diagnostic_session_fingerprint(promotion.cli_agent_session_id());
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_fingerprint = %session_fingerprint,
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
    match flush_and_unmount_workspace_drive(sandbox, promotion.run_id()).await {
        Ok(()) => {}
        Err(e) => {
            let session_fingerprint =
                diagnostic_session_fingerprint(promotion.cli_agent_session_id());
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_fingerprint = %session_fingerprint,
                reason,
                error = %e,
                "workspace image cache promotion skipped because guest unmount failed"
            );
            return WorkspacePromotionAction::AbandonUnpublished;
        }
    }

    match promotion.promote().await {
        Ok(WorkspaceImagePromotionOutcome::Promoted) => WorkspacePromotionAction::Promoted,
        Ok(WorkspaceImagePromotionOutcome::PreservedExisting) => {
            WorkspacePromotionAction::PreservedExisting
        }
        Ok(WorkspaceImagePromotionOutcome::SkippedUnpublished) => {
            WorkspacePromotionAction::AbandonUnpublished
        }
        Err(e) => {
            let session_fingerprint =
                diagnostic_session_fingerprint(promotion.cli_agent_session_id());
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_fingerprint = %session_fingerprint,
                reason,
                error = %e,
                "workspace image cache promotion failed"
            );
            WorkspacePromotionAction::AbandonUnpublished
        }
    }
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
            let session_fingerprint =
                diagnostic_session_fingerprint(promotion.cli_agent_session_id());
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_fingerprint = %session_fingerprint,
                reason,
                error = %e,
                "workspace image cache promotion skipped because idle sandbox unpark failed"
            );
            abandon_unpublished_workspace_promotion(Some(promotion), reason).await;
            return false;
        }
        Err(_) => {
            let session_fingerprint =
                diagnostic_session_fingerprint(promotion.cli_agent_session_id());
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_fingerprint = %session_fingerprint,
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
    let session_fingerprint = diagnostic_session_fingerprint(promotion.cli_agent_session_id());
    match promotion.abandon_unpublished(reason).await {
        Ok(abandoned) => abandoned,
        Err(e) => {
            warn!(
                run_id = %run_id,
                sandbox_id = %sandbox_id,
                profile_name,
                session_fingerprint = %session_fingerprint,
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
