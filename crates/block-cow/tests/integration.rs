#![cfg(test)]

//! Integration tests for the block-cow crate.
//!
//! These tests require root privileges and standard Linux kernel modules
//! (loop, device-mapper). Run with:
//!
//! ```sh
//! cargo test -p block-cow -- --ignored
//! ```

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::Command;

use block_cow::{CowDevice, CowDeviceConfig};

/// Skip the test early if not running as root.
/// Must be a macro so `return` exits the calling test function.
macro_rules! require_root {
    () => {
        if !nix::unistd::getuid().is_root() {
            eprintln!("skipping: requires root");
            return;
        }
    };
}

/// Create a small ext4 image for testing (64 MiB).
fn create_test_base_image(path: &Path) {
    let f = fs::File::create(path).expect("create base image");
    f.set_len(64 * 1024 * 1024).expect("truncate base image");
    let status = Command::new("mkfs.ext4")
        .args(["-F", "-q", &path.to_string_lossy()])
        .status()
        .expect("mkfs.ext4");
    assert!(status.success(), "mkfs.ext4 failed");
}

fn test_config(tmp: &Path) -> CowDeviceConfig {
    let base = tmp.join("base.ext4");
    create_test_base_image(&base);
    CowDeviceConfig {
        base_image: base,
        cow_dir: tmp.join("cow"),
        chunk_size: None,
    }
}

#[test]
#[ignore]
fn create_and_destroy() {
    require_root!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let config = test_config(tmp.path());

    let mut device = CowDevice::create(&config).expect("create");
    let dev_path = device.device_path().to_owned();
    let cow_file = device.cow_file().to_owned();

    assert!(dev_path.exists(), "device path should exist: {dev_path:?}");
    assert!(cow_file.exists(), "COW file should exist: {cow_file:?}");

    device.destroy().expect("destroy");

    assert!(!dev_path.exists(), "device path should be removed");
    assert!(!cow_file.exists(), "COW file should be removed");
}

#[test]
#[ignore]
fn destroy_keep_cow_preserves_file() {
    require_root!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let config = test_config(tmp.path());

    let mut device = CowDevice::create(&config).expect("create");
    let cow_file = device.cow_file().to_owned();
    let dev_path = device.device_path().to_owned();

    device.destroy_keep_cow().expect("destroy_keep_cow");

    assert!(!dev_path.exists(), "device path should be removed");
    assert!(cow_file.exists(), "COW file should be preserved");
}

#[test]
#[ignore]
fn cow_file_is_sparse() {
    require_root!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let config = test_config(tmp.path());

    let mut device = CowDevice::create(&config).expect("create");
    let cow_file = device.cow_file().to_owned();

    let meta = fs::metadata(&cow_file).expect("metadata");
    let logical_size = meta.len();
    let actual_bytes = meta.blocks() * 512;

    assert_eq!(
        logical_size,
        64 * 1024 * 1024,
        "logical size should be 64 MiB"
    );
    assert!(
        actual_bytes < 1024 * 1024,
        "actual disk usage ({actual_bytes} bytes) should be < 1 MiB for a fresh COW"
    );

    device.destroy().expect("destroy");
}

#[test]
#[ignore]
fn multiple_devices_from_same_base() {
    require_root!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let config = test_config(tmp.path());

    let mut device1 = CowDevice::create(&config).expect("create device 1");
    let mut device2 = CowDevice::create(&config).expect("create device 2");

    assert_ne!(device1.device_path(), device2.device_path());
    assert!(device1.device_path().exists());
    assert!(device2.device_path().exists());

    device1.destroy().expect("destroy device 1");
    device2.destroy().expect("destroy device 2");
}

#[test]
#[ignore]
fn restore_from_existing_cow() {
    require_root!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let config = test_config(tmp.path());

    let mut device = CowDevice::create(&config).expect("create");
    let cow_file = device.cow_file().to_owned();
    let dev_path = device.device_path().to_owned();

    // Write a marker to the raw block device to dirty the COW.
    let marker = b"BLOCK_COW_TEST_MARKER";
    fs::write(&dev_path, marker).expect("write marker to device");

    device.destroy_keep_cow().expect("destroy_keep_cow");
    assert!(cow_file.exists(), "COW file should be preserved");

    // Restore from the saved COW file.
    let mut restored = CowDevice::restore(&config, cow_file.clone()).expect("restore");
    let restored_path = restored.device_path().to_owned();

    // Read back the marker from the restored device.
    // Scope the file handle so it's closed before destroy() — an open fd
    // keeps the dm device busy and `dmsetup remove` would fail.
    let buf = {
        let f = fs::File::open(&restored_path).expect("open restored device");
        use std::os::unix::fs::FileExt;
        let mut buf = vec![0u8; marker.len()];
        f.read_exact_at(&mut buf, 0).expect("read marker");
        buf
    };

    assert_eq!(&buf, marker, "marker should survive restore");

    restored.destroy().expect("destroy restored");
}

#[test]
#[ignore]
fn device_path_format() {
    require_root!();

    let tmp = tempfile::tempdir().expect("tempdir");
    let config = test_config(tmp.path());

    let mut device = CowDevice::create(&config).expect("create");
    let path_str = device.device_path().to_string_lossy();

    assert!(
        path_str.starts_with("/dev/mapper/cow-"),
        "device path should start with /dev/mapper/cow-, got: {path_str}"
    );

    device.destroy().expect("destroy");
}
