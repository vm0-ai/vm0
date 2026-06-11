use std::fs;
use std::path::{Path, PathBuf};

const TEST_IMAGE_SIZE: u64 = 64 * 1024 * 1024;

pub struct NbdTestFixture {
    tmp: tempfile::TempDir,
    base: PathBuf,
}

impl NbdTestFixture {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let base = tmp.path().join("base.img");
        create_test_base_image(&base);
        Self { tmp, base }
    }

    pub fn base(&self) -> &Path {
        &self.base
    }

    pub fn size(&self) -> u64 {
        TEST_IMAGE_SIZE
    }

    pub fn cow_path(&self, name: impl AsRef<Path>) -> PathBuf {
        self.tmp.path().join(name)
    }
}

pub fn default_device_pool() -> nbd_cow::pool::DevicePoolHandle {
    nbd_cow::pool::DevicePoolHandle::new(nbd_cow::pool::DevicePoolConfig::default())
}

fn create_test_base_image(path: &Path) {
    let f = fs::File::create(path).expect("create base image");
    f.set_len(TEST_IMAGE_SIZE).expect("truncate base image");
}
