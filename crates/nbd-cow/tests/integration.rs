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

    let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
        .await
        .expect("create");

    let dev_path = device.device_path().to_owned();
    assert!(dev_path.exists(), "device should exist: {dev_path:?}");
    assert!(
        dev_path.to_string_lossy().contains("/dev/nbd"),
        "path should be /dev/nbdN"
    );

    device.destroy().await.expect("destroy");
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

    let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
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

    device.destroy_keep_cow().await.expect("destroy_keep_cow");
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

    let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
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

    device.destroy().await.expect("destroy");
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

    let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
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

    device.destroy_keep_cow().await.expect("destroy");

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

    let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
        .await
        .expect("create");

    let path_str = device.device_path().to_string_lossy();
    assert!(
        path_str.starts_with("/dev/nbd"),
        "device path should start with /dev/nbd, got: {path_str}"
    );

    device.destroy().await.expect("destroy");
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

    let mut dev1 = nbd_cow::NbdCowDevice::create(&base, &cow1, size)
        .await
        .expect("create 1");
    let mut dev2 = nbd_cow::NbdCowDevice::create(&base, &cow2, size)
        .await
        .expect("create 2");

    assert_ne!(dev1.device_path(), dev2.device_path());
    assert!(dev1.device_path().exists());
    assert!(dev2.device_path().exists());

    dev1.destroy().await.expect("destroy 1");
    dev2.destroy().await.expect("destroy 2");
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

    // Phase 1: create device, write data, destroy_keep_cow
    {
        let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
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
        device.destroy_keep_cow().await.expect("destroy_keep_cow");
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
        let mut device = nbd_cow::NbdCowDevice::create(&base, &cow, size)
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

        device.destroy().await.expect("destroy");
    }

    // After destroy, COW and bitmap should be cleaned up
    assert!(!cow.exists(), "COW file should be removed after destroy");
}
