#![cfg(test)]

//! Integration tests for the nbd-cow crate.
//!
//! Tests marked `#[ignore]` require root privileges and the `nbd` kernel module.
//! Run with:
//!
//! ```sh
//! sudo modprobe nbd nbds_max=256
//! cargo test -p nbd-cow -- --ignored
//! ```
//!
//! Non-ignored tests run unprivileged and exercise the protocol, COW layer,
//! and server dispatch over socketpairs (no real block device needed).

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::Command;

/// Skip the test early if not running as root.
macro_rules! require_root {
    () => {
        if !nix::unistd::getuid().is_root() {
            eprintln!("skipping: requires root");
            return;
        }
    };
}

/// Skip if the nbd kernel module is not loaded.
macro_rules! require_nbd {
    () => {
        let modules = std::fs::read_to_string("/proc/modules").unwrap_or_default();
        if !modules.lines().any(|l| l.starts_with("nbd ")) {
            eprintln!("skipping: nbd kernel module not loaded");
            return;
        }
    };
}

fn create_test_base_image(path: &Path) {
    let f = fs::File::create(path).expect("create base image");
    f.set_len(64 * 1024 * 1024).expect("truncate base image");
}

fn test_device_pool() -> nbd_cow::pool::DevicePoolHandle {
    nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default())
}

fn destroy_policy() -> nbd_cow::DestroyRetryPolicy {
    nbd_cow::DestroyRetryPolicy {
        attempts: 1,
        delay: std::time::Duration::ZERO,
    }
}

fn keep_cow_policy() -> nbd_cow::DestroyRetryPolicy {
    destroy_policy()
}

fn claim_free_device_for_direct_connect() -> nbd_cow::device_lock::NbdDeviceClaim {
    for index in 0..nbd_cow::netlink::nbds_max() {
        if !nbd_cow::netlink::device_appears_free(index) {
            continue;
        }

        match nbd_cow::device_lock::try_acquire_device_claim(index) {
            Ok(Some(claim)) if nbd_cow::netlink::device_appears_free(index) => return claim,
            Ok(Some(_)) | Ok(None) => {}
            Err(e) => eprintln!("skipping nbd{index}: failed to acquire device lock: {e}"),
        }
    }

    panic!("no free NBD device");
}

fn nbd_pid(device_index: u32) -> Option<u32> {
    let pid_path = format!("/sys/block/nbd{device_index}/pid");
    std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|contents| contents.trim().parse().ok())
}

// ---------------------------------------------------------------------------
// Full device lifecycle tests (require root + nbd module)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn create_and_destroy() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size = 64 * 1024 * 1024;

    let pool = test_device_pool();
    let device = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");

    let dev_path = device.device_path().to_owned();
    assert!(dev_path.exists(), "device should exist: {dev_path:?}");
    assert!(
        dev_path.to_string_lossy().contains("/dev/nbd"),
        "path should be /dev/nbdN"
    );

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");
    // After destroy, the COW file should be removed
    assert!(!cow.exists(), "COW file should be removed after destroy");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn destroy_keep_cow_preserves_file() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size = 64 * 1024 * 1024;

    let pool = test_device_pool();
    let device = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");

    // Write a small amount so the COW file is actually created on disk
    let dev_path = device.device_path().to_owned();
    let status = Command::new("dd")
        .args([
            "if=/dev/urandom",
            &format!("of={}", dev_path.to_string_lossy()),
            "bs=4096",
            "count=1",
            "conv=notrunc",
        ])
        .status()
        .expect("dd write");
    assert!(status.success(), "dd write should succeed");

    // Sync to flush the write buffer to the COW file
    let status = Command::new("sync").status().expect("sync");
    assert!(status.success());
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    device
        .destroy_keep_cow_with_retries(keep_cow_policy())
        .await
        .expect("destroy_keep_cow");
    assert!(cow.exists(), "COW file should be preserved");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn write_and_read_back_via_block_device() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size = 64 * 1024 * 1024;

    let pool = test_device_pool();
    let device = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");
    let dev_path = device.device_path().to_owned();

    // Write a marker via dd
    let marker = "NBD_COW_TEST_MARKER_12345678";
    let status = Command::new("dd")
        .args([
            "if=/dev/zero",
            &format!("of={}", dev_path.to_string_lossy()),
            "bs=4096",
            "count=1",
            "conv=notrunc",
        ])
        .status()
        .expect("dd zero");
    assert!(status.success());

    let status = Command::new("bash")
        .args([
            "-c",
            &format!(
                "echo -n '{}' | dd of={} bs=1 count={} conv=notrunc",
                marker,
                dev_path.to_string_lossy(),
                marker.len()
            ),
        ])
        .status()
        .expect("dd marker");
    assert!(status.success());

    // Read back
    let output = Command::new("dd")
        .args([
            &format!("if={}", dev_path.to_string_lossy()),
            "bs=1",
            &format!("count={}", marker.len()),
        ])
        .output()
        .expect("dd read");
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        marker,
        "marker should survive write/read"
    );

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn cow_file_is_sparse() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size = 64 * 1024 * 1024;

    let pool = test_device_pool();
    let device = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");

    // Write a small amount (16KB)
    let dev_path = device.device_path().to_owned();
    let status = Command::new("dd")
        .args([
            "if=/dev/urandom",
            &format!("of={}", dev_path.to_string_lossy()),
            "bs=4096",
            "count=4",
            "conv=notrunc",
        ])
        .status()
        .expect("dd");
    assert!(status.success());

    // Flush to disk
    let status = Command::new("sync").status().expect("sync");
    assert!(status.success());

    // Give the flush a moment
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    device
        .destroy_keep_cow_with_retries(keep_cow_policy())
        .await
        .expect("destroy");

    // Check COW file is sparse — actual disk usage should be much less than 64MB
    let meta = fs::metadata(&cow).expect("metadata");
    let actual_bytes = meta.blocks() * 512;
    assert!(
        actual_bytes < 1024 * 1024,
        "COW file disk usage ({actual_bytes} bytes) should be < 1 MiB for 16KB write"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn device_path_format() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size = 64 * 1024 * 1024;

    let pool = test_device_pool();
    let device = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");

    let path_str = device.device_path().to_string_lossy();
    assert!(
        path_str.starts_with("/dev/nbd"),
        "device path should start with /dev/nbd, got: {path_str}"
    );

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn multiple_devices_from_same_base() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let size = 64 * 1024 * 1024;

    let cow1 = tmp.path().join("cow1.img");
    let cow2 = tmp.path().join("cow2.img");

    let pool = test_device_pool();
    let dev1 = pool
        .create_cow_device(&base, &cow1, size)
        .await
        .expect("create 1");
    let dev2 = pool
        .create_cow_device(&base, &cow2, size)
        .await
        .expect("create 2");

    assert_ne!(dev1.device_path(), dev2.device_path());
    assert!(dev1.device_path().exists());
    assert!(dev2.device_path().exists());

    dev1.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 1");
    dev2.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 2");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn snapshot_restore_round_trip() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size = 64 * 1024 * 1024;

    let marker = b"NBD_SNAPSHOT_RESTORE_TEST_1234";

    let pool = test_device_pool();

    // Phase 1: create device, write data, destroy_keep_cow
    {
        let device = pool
            .create_cow_device(&base, &cow, size)
            .await
            .expect("create");

        let dev_path = device.device_path().to_owned();

        // Write a full 4K block with the marker at the start (block-aligned I/O)
        let mut write_buf = vec![0u8; 4096];
        write_buf[..marker.len()].copy_from_slice(marker);

        let status = Command::new("dd")
            .args([
                "if=/dev/stdin",
                &format!("of={}", dev_path.to_string_lossy()),
                "bs=4096",
                "count=1",
                "conv=notrunc",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(&write_buf).unwrap();
                child.wait()
            })
            .expect("dd write");
        assert!(status.success(), "dd write should succeed");

        // Sync to flush to COW file
        let status = Command::new("sync").status().expect("sync");
        assert!(status.success());
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        device.log_status().await;
        device
            .destroy_keep_cow_with_retries(keep_cow_policy())
            .await
            .expect("destroy_keep_cow");
    }

    // Verify COW file and bitmap exist
    assert!(cow.exists(), "COW file should be preserved");
    let mut bitmap_name = cow.as_os_str().to_os_string();
    bitmap_name.push(".bitmap");
    let bitmap = std::path::PathBuf::from(bitmap_name);
    assert!(bitmap.exists(), "bitmap file should be created");

    // Verify COW file has data (direct file read, independent of NBD)
    {
        use std::os::unix::fs::FileExt;
        let cow_fd = fs::File::open(&cow).expect("open COW file for verification");
        let mut verify_buf = vec![0u8; marker.len()];
        cow_fd
            .read_at(&mut verify_buf, 0)
            .expect("read COW file at offset 0");
        assert_eq!(
            &verify_buf, marker,
            "COW file should contain marker data at offset 0"
        );
    }

    // Phase 2: create new device with same base + COW — data should persist
    {
        let device = pool
            .create_cow_device(&base, &cow, size)
            .await
            .expect("restore create");

        let dev_path = device.device_path().to_owned();
        device.log_status().await;

        // Read first 4K block from the device
        let output = Command::new("dd")
            .args([
                &format!("if={}", dev_path.to_string_lossy()),
                "bs=4096",
                "count=1",
            ])
            .output()
            .expect("dd read");
        assert!(
            output.status.success(),
            "dd read failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stdout.len() >= marker.len(),
            "dd read returned {} bytes, expected at least {}",
            output.stdout.len(),
            marker.len()
        );
        assert_eq!(
            output.stdout.get(..marker.len()),
            Some(marker.as_slice()),
            "marker should survive snapshot restore"
        );

        device
            .destroy_with_retries(destroy_policy())
            .await
            .expect("destroy");
    }

    // After destroy, COW and bitmap should both be cleaned up
    assert!(!cow.exists(), "COW file should be removed after destroy");
    assert!(
        !bitmap.exists(),
        "bitmap file should be removed after destroy"
    );
}

// ---------------------------------------------------------------------------
// DevicePool-specific tests (require root + nbd module)
// ---------------------------------------------------------------------------

/// Verify connect_device works with a specific device index.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn connect_device_specific_index() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size: u64 = 64 * 1024 * 1024;

    let claim = claim_free_device_for_direct_connect();
    let device_index = claim.index();

    let mut client_fds = Vec::new();
    let mut server_handles = Vec::new();
    let shutdown = tokio_util::sync::CancellationToken::new();

    let cow_layer = nbd_cow::cow::CowLayer::new(
        &base,
        &cow,
        size,
        nbd_cow::BLOCK_SIZE,
        nbd_cow::DEFAULT_FLUSH_THRESHOLD,
    )
    .expect("cow layer");
    let cow_layer = std::sync::Arc::new(tokio::sync::RwLock::new(cow_layer));

    let mut setup_result = Ok::<(), nbd_cow::error::NbdCowError>(());
    for _ in 0..nbd_cow::NUM_CONNECTIONS {
        let (client_fd, server_fd) = match nbd_cow::netlink::create_socketpair() {
            Ok(fds) => fds,
            Err(e) => {
                setup_result = Err(e);
                break;
            }
        };
        client_fds.push(client_fd);
        let cow = cow_layer.clone();
        let token = shutdown.clone();
        server_handles.push(tokio::spawn(async move {
            let _ = nbd_cow::server::dispatch(server_fd, cow, token).await;
        }));
    }

    let connect_tid = unsafe { libc::gettid() } as u32;
    let connect_attempted = setup_result.is_ok();
    let connect_result = setup_result.and_then(|()| {
        nbd_cow::netlink::connect_device(
            device_index,
            &client_fds,
            size,
            nbd_cow::BLOCK_SIZE as u64,
        )
    });
    let connected = connect_result.is_ok();
    let device_has_correct_size = if connected {
        nbd_cow::netlink::verify_device_size(device_index, size).await
    } else {
        false
    };

    // Clean up
    shutdown.cancel();
    for h in server_handles {
        h.abort();
        let _ = h.await;
    }
    drop(client_fds);
    if connected || (connect_attempted && nbd_pid(device_index) == Some(connect_tid)) {
        let _ = nbd_cow::netlink::disconnect(device_index);
    }

    connect_result.expect("socketpair setup or connect_device");
    assert!(device_has_correct_size, "device should have correct size");
}

/// After destroy + release, the pool should not hand back the same device
/// index immediately (cooldown must expire first).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pool_cooldown_prevents_immediate_reuse() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let size = 64 * 1024 * 1024;

    // Use a long cooldown so the released device can't be reused
    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig {
        cooldown: std::time::Duration::from_secs(60),
    });

    let cow1 = tmp.path().join("cow1.img");
    let dev1 = pool
        .create_cow_device(&base, &cow1, size)
        .await
        .expect("create 1");
    let idx1 = dev1.device_index();

    dev1.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 1");

    // Immediately create another device — should get a DIFFERENT index
    // because idx1 is still in cooldown (60s)
    let cow2 = tmp.path().join("cow2.img");
    let dev2 = pool
        .create_cow_device(&base, &cow2, size)
        .await
        .expect("create 2");
    let idx2 = dev2.device_index();

    assert_ne!(
        idx1, idx2,
        "pool should not reuse device {idx1} during cooldown"
    );

    dev2.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy 2");
    pool.cleanup().await;
}

/// After cooldown expires, a released device should become available again.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pool_release_and_reacquire_after_cooldown() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let size = 64 * 1024 * 1024;

    // Very short cooldown so we can test re-acquisition
    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig {
        cooldown: std::time::Duration::from_millis(50),
    });

    let cow = tmp.path().join("cow.img");
    let dev = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");

    dev.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy");

    // Wait for cooldown to expire
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let cow2 = tmp.path().join("cow2.img");
    let dev2 = pool
        .create_cow_device(&base, &cow2, size)
        .await
        .expect("create after cooldown");
    dev2.destroy_with_retries(destroy_policy())
        .await
        .expect("destroy after cooldown");
    pool.cleanup().await;
}

/// Pool warmup should leave the public pooled-device path usable.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pool_warmup_allows_pooled_create() {
    require_root!();
    require_nbd!();

    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    pool.warmup().await;

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let device = pool
        .create_cow_device(&base, &cow, 64 * 1024 * 1024)
        .await
        .expect("create after warmup");

    device
        .destroy_with_retries(destroy_policy())
        .await
        .expect("destroy after warmup");
    pool.cleanup().await;
}

/// After cleanup(), acquire must return NoFreeDevice immediately.
/// This is a pure-logic test — no root or nbd module required.
#[tokio::test(flavor = "multi_thread")]
async fn pool_cleanup_rejects_acquire() {
    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    pool.cleanup().await;

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let result = pool.create_cow_device(&base, &cow, 64 * 1024 * 1024).await;
    assert!(result.is_err(), "acquire after cleanup should fail");
}

/// Calling cleanup() twice should be a no-op (not panic or corrupt state).
/// This is a pure-logic test — no root or nbd module required.
#[tokio::test(flavor = "multi_thread")]
async fn pool_cleanup_is_idempotent() {
    let pool = nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default());
    pool.cleanup().await;
    pool.cleanup().await;

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let result = pool.create_cow_device(&base, &cow, 64 * 1024 * 1024).await;
    assert!(
        result.is_err(),
        "create should still fail after repeated cleanup"
    );
}

/// Dropping an NbdCowDevice without calling destroy() should still
/// disconnect the kernel device (best-effort cleanup via Drop).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn drop_without_destroy_disconnects() {
    require_root!();
    require_nbd!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let base = tmp.path().join("base.img");
    create_test_base_image(&base);
    let cow = tmp.path().join("cow.img");
    let size: u64 = 64 * 1024 * 1024;

    let pool = test_device_pool();
    let device = pool
        .create_cow_device(&base, &cow, size)
        .await
        .expect("create");

    let device_index = device.device_index();

    // Drop without calling destroy — Drop impl should disconnect.
    // Drop aborts dispatch tasks (which hold server-side socket fds)
    // and then calls netlink::disconnect synchronously. However, the
    // aborted tasks' fds are only closed when tokio processes the abort,
    // and the kernel won't fully release the device until all fds close.
    // Yield to let the runtime process the aborts before dropping.
    drop(device);
    tokio::task::yield_now().await;

    // Poll sysfs until the kernel marks the device as free.
    let mut freed = false;
    for i in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if nbd_cow::netlink::device_appears_free(device_index) {
            freed = true;
            eprintln!(
                "device nbd{device_index} freed after {:.1}s",
                (i + 1) as f64 * 0.1
            );
            break;
        }
    }
    if !freed {
        // Diagnostic: print what the pid file shows
        let pid_path = format!("/sys/block/nbd{device_index}/pid");
        let pid_content =
            std::fs::read_to_string(&pid_path).unwrap_or_else(|e| format!("err: {e}"));
        panic!(
            "device nbd{device_index} should be free after drop (waited 5s), pid file: {pid_content}"
        );
    }

    pool.cleanup().await;
}
