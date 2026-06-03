use std::panic::AssertUnwindSafe;

use futures_util::FutureExt;
use sandbox::Sandbox;
use tracing::warn;

use crate::workspace_image_cache::WorkspaceImagePromotionContext;
use crate::workspace_mount::flush_and_unmount_workspace_drive;

pub(crate) async fn promote_workspace_image_from_active_sandbox(
    sandbox: &dyn Sandbox,
    promotion: Option<&WorkspaceImagePromotionContext>,
    reason: &'static str,
) -> bool {
    let Some(promotion) = promotion else {
        return false;
    };

    match AssertUnwindSafe(promote_workspace_image_from_active_sandbox_inner(
        sandbox, promotion, reason,
    ))
    .catch_unwind()
    .await
    {
        Ok(promoted) => promoted,
        Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = promotion.session_id(),
                reason,
                "workspace image cache promotion panicked"
            );
            false
        }
    }
}

async fn promote_workspace_image_from_active_sandbox_inner(
    sandbox: &dyn Sandbox,
    promotion: &WorkspaceImagePromotionContext,
    reason: &'static str,
) -> bool {
    match flush_and_unmount_workspace_drive(sandbox, promotion.run_id()).await {
        Ok(()) => {}
        Err(e) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = promotion.session_id(),
                reason,
                error = %e,
                "workspace image cache promotion skipped because guest unmount failed"
            );
            return false;
        }
    }

    match promotion.promote().await {
        Ok(promoted) => promoted,
        Err(e) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = promotion.session_id(),
                reason,
                error = %e,
                "workspace image cache promotion failed"
            );
            false
        }
    }
}

pub(crate) async fn promote_workspace_image_from_parked_sandbox(
    sandbox: &mut dyn Sandbox,
    promotion: Option<&WorkspaceImagePromotionContext>,
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
                session_id = promotion.session_id(),
                reason,
                error = %e,
                "workspace image cache promotion skipped because idle sandbox unpark failed"
            );
            return false;
        }
        Err(_) => {
            warn!(
                run_id = %promotion.run_id(),
                sandbox_id = %promotion.sandbox_id(),
                profile_name = promotion.profile_name(),
                session_id = promotion.session_id(),
                reason,
                "workspace image cache promotion skipped because idle sandbox unpark panicked"
            );
            return false;
        }
    }

    promote_workspace_image_from_active_sandbox(sandbox, Some(promotion), reason).await
}
