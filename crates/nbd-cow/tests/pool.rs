#![cfg(test)]

//! Unprivileged DevicePool integration tests for the nbd-cow crate.

#[path = "support/nbd_fixture.rs"]
mod nbd_fixture;

use nbd_cow::error::NbdCowError;
use nbd_fixture::{NbdTestFixture, default_device_pool};

/// After cleanup(), acquire must return NoFreeDevice immediately.
#[tokio::test(flavor = "multi_thread")]
async fn pool_cleanup_rejects_acquire() {
    let pool = default_device_pool();
    pool.cleanup().await;

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");
    let result = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await;
    assert!(
        matches!(result, Err(NbdCowError::NoFreeDevice)),
        "acquire after cleanup should fail with NoFreeDevice"
    );
}

/// Calling cleanup() twice should be a no-op (not panic or corrupt state).
#[tokio::test(flavor = "multi_thread")]
async fn pool_cleanup_is_idempotent() {
    let pool = default_device_pool();
    pool.cleanup().await;
    pool.cleanup().await;

    let fixture = NbdTestFixture::new();
    let cow = fixture.cow_path("cow.img");
    let result = pool
        .create_cow_device(fixture.base(), &cow, fixture.size())
        .await;
    assert!(
        matches!(result, Err(NbdCowError::NoFreeDevice)),
        "create should still fail with NoFreeDevice after repeated cleanup"
    );
}
