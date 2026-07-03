use std::time::Duration;

use nbd_cow::{DestroyRetryPolicy, PooledDestroyError};

/// Maximum attempts to destroy a COW device after killing Firecracker.
/// After kill_process_group + child.wait(), the kernel may still be
/// releasing file descriptors (particularly the NBD device fd).
const DESTROY_RETRIES: u32 = 5;

/// Delay between COW device destroy retries.
const DESTROY_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CowCleanupOutcome {
    BackingFilesSafeToDelete,
    DeviceMayStillReferenceBackingFiles,
}

impl CowCleanupOutcome {
    pub(crate) fn backing_files_safe_to_delete(self) -> bool {
        matches!(self, Self::BackingFilesSafeToDelete)
    }
}

pub(crate) trait CowDestroyErrorSafety {
    fn backing_files_safe_to_delete(&self) -> bool;
}

impl CowDestroyErrorSafety for PooledDestroyError {
    fn backing_files_safe_to_delete(&self) -> bool {
        self.backing_files_safe_to_delete()
    }
}

pub(crate) fn cow_destroy_retry_policy() -> DestroyRetryPolicy {
    DestroyRetryPolicy {
        attempts: DESTROY_RETRIES,
        delay: DESTROY_RETRY_DELAY,
    }
}

pub(crate) fn classify_cow_destroy_result<E>(
    result: &std::result::Result<(), E>,
) -> CowCleanupOutcome
where
    E: CowDestroyErrorSafety,
{
    match result {
        Ok(()) => CowCleanupOutcome::BackingFilesSafeToDelete,
        Err(e) if e.backing_files_safe_to_delete() => CowCleanupOutcome::BackingFilesSafeToDelete,
        Err(_) => CowCleanupOutcome::DeviceMayStillReferenceBackingFiles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Copy)]
    struct FakeCowDestroyError {
        backing_files_safe_to_delete: bool,
    }

    impl CowDestroyErrorSafety for FakeCowDestroyError {
        fn backing_files_safe_to_delete(&self) -> bool {
            self.backing_files_safe_to_delete
        }
    }

    #[test]
    fn cow_destroy_success_makes_backing_files_safe_to_delete() {
        let result: std::result::Result<(), FakeCowDestroyError> = Ok(());

        let outcome = classify_cow_destroy_result(&result);

        assert_eq!(outcome, CowCleanupOutcome::BackingFilesSafeToDelete);
        assert!(outcome.backing_files_safe_to_delete());
    }

    #[test]
    fn cow_destroy_storage_cleanup_failure_makes_backing_files_safe_to_delete() {
        let result = Err(FakeCowDestroyError {
            backing_files_safe_to_delete: true,
        });

        let outcome = classify_cow_destroy_result(&result);

        assert_eq!(outcome, CowCleanupOutcome::BackingFilesSafeToDelete);
        assert!(outcome.backing_files_safe_to_delete());
    }

    #[test]
    fn cow_destroy_device_cleanup_failure_preserves_backing_files() {
        let result = Err(FakeCowDestroyError {
            backing_files_safe_to_delete: false,
        });

        let outcome = classify_cow_destroy_result(&result);

        assert_eq!(
            outcome,
            CowCleanupOutcome::DeviceMayStillReferenceBackingFiles
        );
        assert!(!outcome.backing_files_safe_to_delete());
    }
}
