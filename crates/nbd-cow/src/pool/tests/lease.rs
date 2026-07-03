use super::*;

#[test]
fn release_consumes_lease_and_enters_cooldown_with_lock_held() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_with_in_flight(3, dir.path());

    pool.release(lease(3, dir.path()));

    assert_eq!(pool.cooldown.len(), 1);
    assert_eq!(pool.cooldown.front().map(CooldownSlot::index), Some(3));
    assert!(pool.in_flight.is_empty());
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_none()
    );
}

#[test]
fn retire_uncertain_enters_cooldown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pool = test_pool_with_in_flight(3, dir.path());

    pool.retire_uncertain(lease(3, dir.path()));

    assert_eq!(pool.cooldown.len(), 1);
    assert_eq!(pool.cooldown.front().map(CooldownSlot::index), Some(3));
    assert!(pool.in_flight.is_empty());
}

#[tokio::test]
async fn dropping_last_handle_closes_actor_command_channel_after_lease_drops() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = test_pool(1, Duration::from_secs(60), dir.path(), always_free);
    let handle = handle_with_scan_result(pool, Ok(claim(0, dir.path())));
    let weak_commands = handle.weak_commands();

    let lease = handle.acquire().await.expect("acquire lease");
    drop(handle);
    assert!(weak_commands.upgrade().is_some());

    drop(lease);
    assert!(weak_commands.upgrade().is_none());
}

#[tokio::test]
async fn detached_retire_returns_in_flight_lease_to_cooldown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = DevicePoolHandle::from_pool(test_pool_with_in_flight(3, dir.path()));

    handle.retire_uncertain_detached(lease(3, dir.path()));

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if handle.snapshot().await.cooldown == vec![3] {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("detached retire did not reach actor");
    handle.cleanup().await;
}

#[tokio::test]
async fn discard_releases_in_flight_lease_without_cooldown() {
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

    handle.discard(lease(3, dir.path())).await;

    let snapshot = handle.snapshot().await;
    assert!(!snapshot.in_flight.contains(&3));
    assert!(snapshot.cooldown.is_empty());
    assert!(
        device_lock::try_acquire_device_claim_in(3, dir.path())
            .expect("lock probe")
            .is_some()
    );

    complete_scan.send(Ok(claim(4, dir.path()))).unwrap();
    let lease = tokio::time::timeout(Duration::from_secs(1), acquire_task)
        .await
        .expect("acquire did not finish after discard")
        .expect("acquire task panicked")
        .expect("acquire failed");
    assert_eq!(lease.index(), 4);
    handle.discard(lease).await;
    handle.cleanup().await;
}

#[tokio::test]
async fn dropped_assigned_lease_retires_to_cooldown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = test_pool(1, Duration::from_secs(60), dir.path(), always_free);
    let handle = handle_with_scan_result(pool, Ok(claim(0, dir.path())));

    let lease = handle.acquire().await.expect("acquire lease");
    assert_eq!(lease.index(), 0);
    drop(lease);

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let snapshot = handle.snapshot().await;
            if snapshot.cooldown == vec![0] && !snapshot.in_flight.contains(&0) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("dropped lease did not return to cooldown");
    handle.cleanup().await;
}
