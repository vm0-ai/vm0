use std::path::Path;
use std::time::{Duration, SystemTime};

use crate::paths::HomePaths;

pub(super) fn test_home(root: &Path) -> HomePaths {
    HomePaths::with_root(root.to_path_buf())
}

pub(super) fn old_gc_time() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000)
}

pub(super) fn set_mtime(path: &Path, mtime: SystemTime) {
    std::fs::File::open(path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
}

#[cfg(unix)]
pub(super) fn assert_is_symlink(path: &Path, message: &str) {
    assert!(
        std::fs::symlink_metadata(path)
            .unwrap()
            .file_type()
            .is_symlink(),
        "{message}"
    );
}
