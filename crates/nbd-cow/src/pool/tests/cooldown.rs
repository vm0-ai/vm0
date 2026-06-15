use super::*;

#[test]
fn tracked_indices_include_cooldown_and_in_flight() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(2, Duration::from_secs(60), dir.path(), always_free);
    pool.in_flight.insert(0);
    pool.release(lease(0, dir.path()));
    pool.in_flight.insert(1);

    let tracked = pool.tracked_indices();

    assert_eq!(tracked.len(), 2);
    assert!(tracked.contains(&0));
    assert!(tracked.contains(&1));
}

#[tokio::test]
async fn cooldown_timer_releases_expired_claim_without_waiter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = DevicePoolHandle::from_pool(test_pool_with_in_flight(3, dir.path()));

    handle.release_clean(lease(3, dir.path())).await;
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_none()
    );

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = handle.snapshot().await;
            if snapshot.cooldown.is_empty()
                && device_lock::try_acquire_device_claim_in(3, dir.path())
                    .expect("lock probe")
                    .is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cooldown timer did not release claim");
    handle.cleanup().await;
}

#[tokio::test]
async fn expired_cooldown_with_waiter_hands_off_same_claim() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(0, Duration::from_millis(20), dir.path(), always_free);
    pool.in_flight.insert(3);
    let handle = DevicePoolHandle::from_pool(pool);

    handle.release_clean(lease(3, dir.path())).await;
    let acquire_task = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });

    let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
        .await
        .expect("cooldown handoff timed out")
        .expect("acquire task panicked")
        .expect("acquire failed");
    assert_eq!(lease.index(), 3);
    handle.discard(lease).await;
    handle.cleanup().await;
}

#[tokio::test]
async fn expired_cooldown_with_failed_recheck_drops_claim_and_scans() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool(0, Duration::from_secs(60), dir.path(), never_free);
    pool.in_flight.insert(3);

    pool.release_claim(claim(3, dir.path()));
    let (respond_to, response) = oneshot::channel();
    pool.waiting_acquires.push_back(respond_to);
    pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));
    assert_eq!(pool.waiting_acquires.len(), 1);
    assert_eq!(pool.deferred_acquire_errors.len(), 1);

    pool.cooldown
        .front_mut()
        .expect("released claim should be cooling down")
        .released_at = Instant::now() - Duration::from_secs(61);
    pool.process_expired_cooldown();
    pool.ensure_waiting_progress(0);

    let result = response.await.expect("waiter should receive scan failure");
    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_some()
    );
}
