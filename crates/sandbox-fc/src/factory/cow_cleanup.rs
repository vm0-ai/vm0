use std::time::Duration;

use tracing::warn;

use nbd_cow::{DestroyRetryPolicy, PooledNbdCowDevice};

/// Maximum attempts to destroy a COW device after killing Firecracker.
/// After kill_process_group + child.wait(), the kernel may still be
/// releasing file descriptors (particularly the NBD device fd).
const DESTROY_RETRIES: u32 = 5;

/// Delay between COW device destroy retries.
const DESTROY_RETRY_DELAY: Duration = Duration::from_millis(500);

pub(crate) fn cow_destroy_retry_policy() -> DestroyRetryPolicy {
    DestroyRetryPolicy {
        attempts: DESTROY_RETRIES,
        delay: DESTROY_RETRY_DELAY,
    }
}

pub(super) async fn destroy_cow_device_with_retries(
    id: &str,
    cow_device: PooledNbdCowDevice,
) -> bool {
    match cow_device
        .destroy_with_retries_detailed(cow_destroy_retry_policy())
        .await
    {
        Ok(()) => true,
        Err(e) if e.backing_files_safe_to_delete() => {
            warn!(
                id = %id,
                error = %e,
                "COW device released but file cleanup failed; continuing directory cleanup"
            );
            true
        }
        Err(e) => {
            warn!(id = %id, error = %e, "destroy failed after retries — abandoned device");
            false
        }
    }
}
