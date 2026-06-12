use super::*;

#[tokio::test]
async fn acquire_rejects_duplicate_pending_scan_result() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    pool.in_flight.insert(3);
    let handle = handle_with_scan_result(pool, Ok(claim(3, dir.path())));

    let result = handle.acquire().await;

    assert!(matches!(result, Err(NbdCowError::NoFreeDevice)));
    let snapshot = handle.snapshot().await;
    assert!(snapshot.in_flight.contains(&3));
    handle.cleanup().await;
}

#[tokio::test]
async fn waiting_acquires_spawn_demand_scans_up_to_limit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let mut responses = Vec::new();
    let mut pending_scans = 0;

    for _ in 0..(MAX_PENDING + 2) {
        let (respond_to, response) = oneshot::channel();
        pool.handle_acquire(respond_to, pending_scans);
        pending_scans += pool.scans_to_spawn(pending_scans);
        responses.push(response);
    }

    assert_eq!(pool.waiting_acquires.len(), MAX_PENDING + 2);
    assert_eq!(pending_scans, MAX_PENDING);
    pool.cleanup().await;
}

#[tokio::test]
async fn single_waiting_acquire_spawns_single_demand_scan() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let (respond_to, _response) = oneshot::channel();

    pool.handle_acquire(respond_to, 0);
    let pending_scans = pool.scans_to_spawn(0);

    assert_eq!(pool.waiting_acquires.len(), 1);
    assert_eq!(pending_scans, 1);
    pool.cleanup().await;
}

#[tokio::test]
async fn separate_pools_do_not_claim_same_locked_index() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = DevicePoolHandle::from_pool(test_pool(
        1,
        DevicePoolConfig::default().cooldown,
        dir.path(),
        always_free,
    ));
    let second = DevicePoolHandle::from_pool(test_pool(
        1,
        DevicePoolConfig::default().cooldown,
        dir.path(),
        always_free,
    ));

    let first_lease = first.acquire().await.expect("first acquire");
    assert_eq!(first_lease.index(), 0);

    let second_result = second.acquire().await;
    assert!(matches!(second_result, Err(NbdCowError::NoFreeDevice)));

    first.discard(first_lease).await;
    first.cleanup().await;
    second.cleanup().await;
}

#[tokio::test]
async fn demand_error_waits_for_pending_success_before_failing_waiter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let (mut pending, complete_scan) = pending_controlled_scan();
    let (first_tx, mut first_rx) = oneshot::channel();
    let (second_tx, second_rx) = oneshot::channel();
    pool.waiting_acquires.push_back(first_tx);
    pool.waiting_acquires.push_back(second_tx);

    pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));
    pool.ensure_waiting_progress(pending.len());

    assert!(matches!(
        first_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));

    complete_scan.send(Ok(claim(4, dir.path()))).unwrap();
    let scan = pending.join_next().await.unwrap();
    pool.handle_scan_join(Some(scan));
    pool.ensure_waiting_progress(pending.len());

    let first_lease = first_rx.await.unwrap().unwrap();
    assert_eq!(first_lease.index(), 4);
    assert!(matches!(
        second_rx.await.unwrap(),
        Err(NbdCowError::NoFreeDevice)
    ));
}

#[tokio::test]
async fn deferred_error_starts_new_demand_scan_for_remaining_waiter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let (first_tx, first_rx) = oneshot::channel();
    let (second_tx, mut second_rx) = oneshot::channel();
    pool.waiting_acquires.push_back(first_tx);
    pool.waiting_acquires.push_back(second_tx);

    pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));
    pool.ensure_waiting_progress(0);

    assert!(matches!(
        first_rx.await.unwrap(),
        Err(NbdCowError::NoFreeDevice)
    ));
    assert!(matches!(
        second_rx.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(pool.waiting_acquires.len(), 1);
    assert_eq!(pool.scans_to_spawn(0), 1);
    pool.cleanup().await;
}

#[test]
fn scan_success_skips_cancelled_waiter_without_leaking_lock() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let (cancelled_tx, cancelled_rx) = oneshot::channel();
    let (active_tx, mut active_rx) = oneshot::channel();
    drop(cancelled_rx);
    pool.waiting_acquires.push_back(cancelled_tx);
    pool.waiting_acquires.push_back(active_tx);

    pool.handle_scan_join(Some(Ok(Ok(claim(4, dir.path())))));

    let lease = active_rx.try_recv().unwrap().unwrap();
    assert_eq!(lease.index(), 4);
    assert!(pool.waiting_acquires.is_empty());
    assert!(pool.in_flight.contains(&4));
}

#[test]
fn cancelled_waiter_after_scan_completion_drops_claim() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let (cancelled_tx, cancelled_rx) = oneshot::channel();
    drop(cancelled_rx);
    pool.waiting_acquires.push_back(cancelled_tx);

    pool.handle_scan_join(Some(Ok(Ok(claim(4, dir.path())))));

    assert!(pool.waiting_acquires.is_empty());
    assert!(pool.in_flight.is_empty());
    assert!(
        device_lock::try_acquire_device_claim_in(4, dir.path())
            .expect("lock probe")
            .is_some()
    );
}

#[tokio::test]
async fn deferred_error_skips_cancelled_waiter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    let (cancelled_tx, cancelled_rx) = oneshot::channel();
    let (active_tx, active_rx) = oneshot::channel();
    drop(cancelled_rx);
    pool.waiting_acquires.push_back(cancelled_tx);
    pool.waiting_acquires.push_back(active_tx);

    pool.handle_scan_join(Some(Ok(Err(NbdCowError::NoFreeDevice))));
    pool.ensure_waiting_progress(0);

    assert!(matches!(
        active_rx.await.unwrap(),
        Err(NbdCowError::NoFreeDevice)
    ));
    assert!(pool.waiting_acquires.is_empty());
    assert!(pool.deferred_acquire_errors.is_empty());
}

#[tokio::test]
async fn handle_acquire_waiting_for_scan_does_not_block_release() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_for_pending_scan(dir.path());
    pool.in_flight.insert(3);
    let (pending, complete_scan) = pending_controlled_scan();
    let handle = DevicePoolHandle::from_pool_with_pending(pool, pending);
    let acquire_task = tokio::spawn({
        let handle = handle.clone();
        async move { handle.acquire().await }
    });

    wait_for_scan_waiter(&handle).await;
    tokio::time::timeout(
        Duration::from_secs(1),
        handle.release_clean(lease(3, dir.path())),
    )
    .await
    .expect("release blocked behind pending acquire");
    assert_eq!(handle.snapshot().await.cooldown, vec![3]);

    complete_scan.send(Ok(claim(4, dir.path()))).unwrap();
    let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
        .await
        .expect("acquire did not finish after scan")
        .expect("acquire task panicked")
        .expect("acquire failed");
    assert_eq!(lease.index(), 4);
    handle.discard(lease).await;
    handle.cleanup().await;
}
