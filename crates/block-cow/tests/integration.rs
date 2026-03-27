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

use block_cow::{BaseLoopCache, CowDevice, CowDeviceConfig, init_cow_file};

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

struct TestSetup {
    // Drop order matters: cache must be dropped before _tmp so the base
    // loop device is detached before the temp directory (and base image
    // file inside it) is deleted.
    cache: BaseLoopCache,
    _tmp: tempfile::TempDir,
    base_image: std::path::PathBuf,
}

impl TestSetup {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let base = tmp.path().join("base.ext4");
        create_test_base_image(&base);
        Self {
            _tmp: tmp,
            cache: BaseLoopCache::new(),
            base_image: base,
        }
    }

    fn cow_config(&self, name: &str) -> CowDeviceConfig {
        CowDeviceConfig {
            cow_file: self._tmp.path().join(name),
        }
    }
}

#[test]
#[ignore]
fn create_and_destroy() {
    require_root!();

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = setup.cow_config("cow.img");
    init_cow_file(&config.cow_file, handle.sectors).expect("init");

    let mut device = CowDevice::create(&handle.loop_path, handle.sectors, &config).expect("create");
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

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = setup.cow_config("cow.img");
    init_cow_file(&config.cow_file, handle.sectors).expect("init");

    let mut device = CowDevice::create(&handle.loop_path, handle.sectors, &config).expect("create");
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

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = setup.cow_config("cow.img");
    init_cow_file(&config.cow_file, handle.sectors).expect("init");

    let mut device = CowDevice::create(&handle.loop_path, handle.sectors, &config).expect("create");
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

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config1 = setup.cow_config("cow1.img");
    let config2 = setup.cow_config("cow2.img");
    init_cow_file(&config1.cow_file, handle.sectors).expect("init 1");
    init_cow_file(&config2.cow_file, handle.sectors).expect("init 2");

    let mut device1 =
        CowDevice::create(&handle.loop_path, handle.sectors, &config1).expect("create device 1");
    let mut device2 =
        CowDevice::create(&handle.loop_path, handle.sectors, &config2).expect("create device 2");

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

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = setup.cow_config("cow.img");
    init_cow_file(&config.cow_file, handle.sectors).expect("init");

    let mut device = CowDevice::create(&handle.loop_path, handle.sectors, &config).expect("create");
    let cow_file = device.cow_file().to_owned();
    let dev_path = device.device_path().to_owned();

    // Write a marker to the raw block device to dirty the COW.
    let marker = b"BLOCK_COW_TEST_MARKER";
    fs::write(&dev_path, marker).expect("write marker to device");

    device.destroy_keep_cow().expect("destroy_keep_cow");
    assert!(cow_file.exists(), "COW file should be preserved");

    // Restore from the saved COW file — same create() call, file already has data.
    let restore_config = CowDeviceConfig {
        cow_file: cow_file.clone(),
    };
    let mut restored =
        CowDevice::create(&handle.loop_path, handle.sectors, &restore_config).expect("restore");
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

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = setup.cow_config("cow.img");
    init_cow_file(&config.cow_file, handle.sectors).expect("init");

    let mut device = CowDevice::create(&handle.loop_path, handle.sectors, &config).expect("create");
    let path_str = device.device_path().to_string_lossy();

    assert!(
        path_str.starts_with("/dev/mapper/cow-"),
        "device path should start with /dev/mapper/cow-, got: {path_str}"
    );

    device.destroy().expect("destroy");
}

#[test]
#[ignore]
fn pool_shared_loop_device() {
    require_root!();

    let mut setup = TestSetup::new();

    // Two acquires for the same image should return the same loop device.
    let handle1 = setup.cache.acquire(&setup.base_image).expect("acquire 1");
    let handle2 = setup.cache.acquire(&setup.base_image).expect("acquire 2");

    assert_eq!(handle1.loop_path, handle2.loop_path);
    assert_eq!(handle1.sectors, handle2.sectors);

    // Release both — loop should be detached after second release.
    setup.cache.release(handle1.base_key()).expect("release 1");
    setup.cache.release(handle2.base_key()).expect("release 2");
}

#[test]
fn init_cow_file_creates_sparse_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cow = tmp.path().join("cow.img");
    let sectors: u64 = 64 * 1024 * 1024 / 512; // 64 MiB

    init_cow_file(&cow, sectors).expect("init");

    let meta = fs::metadata(&cow).expect("metadata");
    assert_eq!(meta.len(), 64 * 1024 * 1024);
    // Sparse: actual blocks should be near zero.
    assert!(meta.blocks() * 512 < 4096, "file should be sparse");
}

#[test]
fn init_cow_file_creates_parent_dirs() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cow = tmp.path().join("a").join("b").join("cow.img");

    init_cow_file(&cow, 1024).expect("init");
    assert!(cow.exists());
}

#[test]
fn init_cow_file_overflow_returns_error() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let cow = tmp.path().join("overflow.img");

    let result = init_cow_file(&cow, u64::MAX);
    assert!(result.is_err(), "should fail on sector overflow");
}

#[test]
#[ignore]
fn create_fails_with_missing_cow_file() {
    require_root!();

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = CowDeviceConfig {
        cow_file: setup._tmp.path().join("nonexistent.img"),
    };

    let result = CowDevice::create(&handle.loop_path, handle.sectors, &config);
    assert!(result.is_err(), "should fail when COW file does not exist");
}

#[test]
#[ignore]
fn abandon_prevents_cow_file_deletion_on_drop() {
    require_root!();

    let mut setup = TestSetup::new();
    let handle = setup.cache.acquire(&setup.base_image).expect("acquire");
    let config = setup.cow_config("cow.img");
    init_cow_file(&config.cow_file, handle.sectors).expect("init");
    let cow_file = config.cow_file.clone();

    let mut device = CowDevice::create(&handle.loop_path, handle.sectors, &config).expect("create");
    device.abandon();

    // abandon() sets active=false — verify the cow file was NOT deleted.
    assert!(cow_file.exists(), "COW file should survive after abandon");

    // destroy_deferred works on abandoned devices (no active check) and
    // properly cleans up the dm target and cow loop via --force + AUTOCLEAR.
    device.destroy_deferred().expect("deferred cleanup");
}
