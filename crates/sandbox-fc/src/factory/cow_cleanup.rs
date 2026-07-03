use tracing::warn;

use nbd_cow::PooledNbdCowDevice;

use crate::cow_cleanup::{
    CowCleanupOutcome, classify_cow_destroy_result, cow_destroy_retry_policy,
};

pub(super) async fn destroy_cow_device_with_retries(
    id: &str,
    cow_device: PooledNbdCowDevice,
) -> CowCleanupOutcome {
    let result = cow_device
        .destroy_with_retries_detailed(cow_destroy_retry_policy())
        .await;
    let outcome = classify_cow_destroy_result(&result);

    match (result, outcome) {
        (Ok(()), outcome) => outcome,
        (Err(e), CowCleanupOutcome::BackingFilesSafeToDelete) => {
            warn!(
                id = %id,
                error = %e,
                "COW device released but file cleanup failed; continuing directory cleanup"
            );
            outcome
        }
        (Err(e), CowCleanupOutcome::DeviceMayStillReferenceBackingFiles) => {
            warn!(id = %id, error = %e, "destroy failed after retries — abandoned device");
            outcome
        }
    }
}
