use super::*;

#[tokio::test]
async fn cleanup_with_outstanding_lease_does_not_panic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_with_in_flight(3, dir.path());

    pool.cleanup().await;

    assert!(!pool.active);
    assert!(pool.in_flight.is_empty());
}

#[tokio::test]
async fn cleanup_with_outstanding_handle_lease_releases_lock_after_drop() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = test_pool(1, Duration::from_secs(60), dir.path(), always_free);
    let handle = handle_with_scan_result(pool, Ok(claim(0, dir.path())));

    let lease = handle.acquire().await.expect("acquire lease");
    handle.cleanup().await;
    assert!(
        device_lock::try_acquire_device_claim_in(0, dir.path())
            .expect("lock probe")
            .is_none()
    );

    drop(lease);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if device_lock::try_acquire_device_claim_in(0, dir.path())
                .expect("lock probe")
                .is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped lease did not release lock after cleanup");
}

#[tokio::test]
async fn cleanup_rejects_acquire() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = DevicePoolHandle::from_pool(test_pool_for_pending_scan(dir.path()));

    handle.cleanup().await;

    let result = handle.acquire().await;
    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
}

#[tokio::test]
async fn cleanup_drops_completed_pending_scan_claim() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = test_pool_for_pending_scan(dir.path());
    let handle = handle_with_scan_result(pool, Ok(claim(4, dir.path())));

    handle.cleanup().await;

    assert!(
        device_lock::try_acquire_device_claim_in(4, dir.path())
            .expect("lock probe")
            .is_some()
    );
}

#[tokio::test]
async fn cleanup_wakes_handle_acquire_waiting_for_scan() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = test_pool_for_pending_scan(dir.path());
    let (pending, _complete_scan) = pending_controlled_scan();
    let handle = DevicePoolHandle::from_pool_with_pending(pool, pending);
    let acquire_task = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });

    wait_for_scan_waiter(&handle).await;
    tokio::time::timeout(Duration::from_secs(1), handle.cleanup())
        .await
        .expect("cleanup blocked behind pending acquire");

    let result = tokio::time::timeout(Duration::from_secs(1), acquire_task)
        .await
        .expect("acquire did not finish after cleanup")
        .expect("acquire task panicked");
    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
}
