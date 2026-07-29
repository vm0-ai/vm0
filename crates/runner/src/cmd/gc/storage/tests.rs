use std::time::Duration;

use nix::fcntl::FlockArg;

use super::*;
use crate::cmd::gc::test_support::{
    assert_is_symlink, old_gc_time, set_soft_nofile_limit_for_child, test_home,
};
use crate::lock;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

fn make_storage_entry_at(dir: PathBuf, archive_bytes: &[u8], mtime: SystemTime) -> PathBuf {
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("archive.tar.gz"), archive_bytes).unwrap();
    std::fs::File::open(&dir)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    dir
}

fn make_storage_entry(
    home: &HomePaths,
    name: &str,
    version: &str,
    archive_bytes: &[u8],
    mtime: SystemTime,
) -> PathBuf {
    make_storage_entry_at(home.storage_cache_dir(name, version), archive_bytes, mtime)
}

fn make_storage_staging_entry(
    home: &HomePaths,
    name: &str,
    version: &str,
    archive_bytes: &[u8],
    mtime: SystemTime,
) -> PathBuf {
    let final_dir = home.storage_cache_dir(name, version);
    let tmp_name = format!(
        "{}.tmp",
        final_dir.file_name().and_then(|n| n.to_str()).unwrap()
    );
    make_storage_entry_at(final_dir.with_file_name(tmp_name), archive_bytes, mtime)
}

fn count_storage_cache_versions(home: &HomePaths) -> usize {
    let Ok(name_entries) = std::fs::read_dir(home.storages_dir()) else {
        return 0;
    };

    name_entries
        .filter_map(Result::ok)
        .map(|name_entry| name_entry.path())
        .filter(|path| path.is_dir())
        .map(|name_path| {
            let Ok(version_entries) = std::fs::read_dir(name_path) else {
                return 0;
            };
            version_entries
                .filter_map(Result::ok)
                .map(|version_entry| version_entry.path())
                .filter(|path| {
                    path.is_dir()
                        && !path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.ends_with(".tmp"))
                })
                .count()
        })
        .sum()
}

async fn storage_candidate_for(path: PathBuf) -> StorageCandidate {
    let name = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .unwrap()
        .to_owned();
    let version = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap()
        .to_owned();
    let (size, mtime) = dir_stats(&path).await;
    StorageCandidate {
        path,
        name,
        version,
        size,
        mtime,
    }
}

#[tokio::test]
async fn gc_storage_cache_missing_dir_returns_zero() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    // storages_dir does not exist.
    let report = gc_storage_cache(&home, false).await.unwrap();
    assert_eq!(report, GcReport::default());
}

#[tokio::test]
async fn gc_storage_cache_empty_dir_returns_zero() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.storages_dir()).unwrap();
    let report = gc_storage_cache(&home, false).await.unwrap();
    assert_eq!(report, GcReport::default());
}

#[tokio::test]
async fn gc_storage_cache_under_cap_keeps_all() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let a = make_storage_entry(&home, "foo", "v1", &[0u8; 512], old);
    let b = make_storage_entry(&home, "bar", "v1", &[0u8; 512], old);

    // Cap comfortably above total footprint.
    let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert!(a.exists(), "under-cap entry should survive");
    assert!(b.exists(), "under-cap entry should survive");
}

#[tokio::test]
async fn gc_storage_cache_ignores_non_directory_entries_for_entry_cap() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 32], old);
    let root_file = home.storages_dir().join("root-file");
    let version_file = entry.parent().unwrap().join("not-a-version");
    std::fs::write(&root_file, b"noise").unwrap();
    std::fs::write(&version_file, b"noise").unwrap();

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert!(entry.exists(), "only real version directories should count");
    assert!(
        root_file.exists(),
        "GC should ignore non-directory root entries"
    );
    assert!(
        version_file.exists(),
        "GC should ignore non-directory version entries"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_storage_cache_skips_symlink_name_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();
    std::fs::create_dir_all(home.storages_dir()).unwrap();

    let outside_name = dir.path().join("outside-storage-name");
    let outside_version = outside_name.join("v1");
    make_storage_entry_at(outside_version.clone(), &[0u8; 128], old_gc_time());
    let name_link = home.storages_dir().join("name-link");
    std::os::unix::fs::symlink(&outside_name, &name_link).unwrap();

    let freed = gc_storage_cache_with_limits(&home, 0, 0, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert_is_symlink(&name_link, "symlinked storage name entry must remain");
    assert!(
        outside_version.exists(),
        "GC must not delete storage versions through a symlinked name entry"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_storage_cache_skips_symlink_version_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let name_dir = home.storages_dir().join("name");
    std::fs::create_dir_all(&name_dir).unwrap();
    let outside_version = dir.path().join("outside-storage-version");
    make_storage_entry_at(outside_version.clone(), &[0u8; 128], old_gc_time());
    let version_link = name_dir.join("v1");
    std::os::unix::fs::symlink(&outside_version, &version_link).unwrap();

    let freed = gc_storage_cache_with_limits(&home, 0, 0, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert_is_symlink(&version_link, "symlinked storage version entry must remain");
    assert!(
        outside_version.exists(),
        "GC must not delete a symlinked storage version target"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_storage_cache_skips_symlink_tmp_staging_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let name_dir = home.storages_dir().join("name");
    std::fs::create_dir_all(&name_dir).unwrap();
    let outside_tmp = dir.path().join("outside-storage-tmp");
    make_storage_entry_at(outside_tmp.clone(), &[0u8; 128], old_gc_time());
    let tmp_link = name_dir.join("v1.tmp");
    std::os::unix::fs::symlink(&outside_tmp, &tmp_link).unwrap();

    let freed = gc_storage_cache_with_limits(&home, 0, 0, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert_is_symlink(&tmp_link, "symlinked storage staging entry must remain");
    assert!(
        outside_tmp.exists(),
        "GC must not delete a symlinked storage staging target"
    );
}

#[tokio::test]
async fn gc_storage_cache_over_cap_evicts_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    // Three entries, strictly increasing mtime.
    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let t_mid = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(3_000_000);
    let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 128], t_old);
    let middle = make_storage_entry(&home, "foo", "v2", &[0u8; 128], t_mid);
    let newest = make_storage_entry(&home, "bar", "v1", &[0u8; 128], t_new);

    let (oldest_size, _) = dir_stats(&oldest).await;
    let (middle_size, _) = dir_stats(&middle).await;
    let (newest_size, _) = dir_stats(&newest).await;

    // Cap picked so only the oldest must be evicted to fit: total
    // (oldest+middle+newest) exceeds cap, but (middle+newest) fits.
    let cap = middle_size + newest_size;
    let freed = gc_storage_cache_with_cap(&home, cap, false).await.unwrap();

    assert!(!oldest.exists(), "oldest entry must be evicted");
    assert!(middle.exists(), "middle entry must survive");
    assert!(newest.exists(), "newest entry must survive");
    assert_eq!(freed, oldest_size);
}

#[tokio::test]
async fn gc_storage_cache_over_entry_cap_evicts_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let t_mid = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(3_000_000);
    let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
    let middle = make_storage_entry(&home, "foo", "v2", &[0u8; 32], t_mid);
    let newest = make_storage_entry(&home, "bar", "v1", &[0u8; 32], t_new);
    let (oldest_size, _) = dir_stats(&oldest).await;

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 2, false)
        .await
        .unwrap();

    assert!(!oldest.exists(), "oldest entry must be evicted");
    assert!(middle.exists(), "middle entry must survive");
    assert!(
        middle.parent().unwrap().exists(),
        "storage name dir must remain while another version exists"
    );
    assert!(newest.exists(), "newest entry must survive");
    assert_eq!(freed, oldest_size);
    assert_eq!(count_storage_cache_versions(&home), 2);
}

#[tokio::test]
async fn gc_storage_cache_tmp_entries_do_not_count_toward_entry_cap() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let real = make_storage_entry(&home, "foo", "v1", &[0u8; 32], old);
    let tmp = make_storage_staging_entry(&home, "foo", "v2", &[0u8; 32], SystemTime::now());

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert!(
        real.exists(),
        ".tmp staging dirs must not consume entry cap"
    );
    assert!(
        tmp.exists(),
        "recent .tmp staging dir must remain protected"
    );
}

#[tokio::test]
async fn gc_storage_cache_entry_cap_preserves_recent_entries() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let fresh_a = make_storage_entry(&home, "foo", "v1", &[0u8; 32], SystemTime::now());
    let fresh_b = make_storage_entry(&home, "foo", "v2", &[0u8; 32], SystemTime::now());

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert!(fresh_a.exists(), "recent entry must survive");
    assert!(fresh_b.exists(), "recent entry must survive");
    assert_eq!(count_storage_cache_versions(&home), 2);
}

#[tokio::test]
async fn gc_storage_cache_entry_cap_skips_locked_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_locked = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let t_unlocked = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    let locked = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_locked);
    let unlocked = make_storage_entry(&home, "bar", "v1", &[0u8; 32], t_unlocked);
    let (unlocked_size, _) = dir_stats(&unlocked).await;

    let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, false)
        .await
        .unwrap();

    assert!(locked.exists(), "locked entry must survive");
    assert!(!unlocked.exists(), "unlocked entry must be evicted");
    assert_eq!(freed, unlocked_size);
    assert_eq!(count_storage_cache_versions(&home), 1);
}

#[tokio::test]
async fn gc_storage_cache_grace_protects_recent() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    // One old entry (eligible) and one fresh entry (age-protected).
    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let old_entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], t_old);
    // Fresh entry: mtime = now, inside GC_MIN_AGE grace window.
    let fresh = make_storage_entry(&home, "foo", "v2", &[0u8; 256], SystemTime::now());

    let (old_size, _) = dir_stats(&old_entry).await;

    // Cap forces eviction; only the old entry is eligible.
    let freed = gc_storage_cache_with_cap(&home, 128, false).await.unwrap();

    assert!(!old_entry.exists(), "old entry must be evicted");
    assert!(fresh.exists(), "fresh entry must survive grace window");
    assert_eq!(freed, old_size);
}

#[tokio::test]
async fn gc_storage_cache_skips_locked_entry() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let t_older = SystemTime::UNIX_EPOCH + Duration::from_secs(500_000);
    // Locked entry is the older one; without the lock it would be
    // evicted first. With the lock, the unlocked entry should be
    // evicted instead.
    let locked = make_storage_entry(&home, "foo", "v1", &[0u8; 256], t_older);
    let unlocked = make_storage_entry(&home, "bar", "v1", &[0u8; 256], t_old);

    // Hold a shared flock on the locked entry, simulating a reader.
    let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

    let (unlocked_size, _) = dir_stats(&unlocked).await;

    let freed = gc_storage_cache_with_cap(&home, 128, false).await.unwrap();

    assert!(locked.exists(), "locked entry must survive");
    assert!(!unlocked.exists(), "unlocked entry must be evicted");
    assert_eq!(freed, unlocked_size);
}

#[tokio::test]
async fn gc_storage_cache_dry_run_reports_bytes_without_deleting() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 128], t_old);
    let newest = make_storage_entry(&home, "foo", "v2", &[0u8; 128], t_new);

    let (oldest_size, _) = dir_stats(&oldest).await;
    let (newest_size, _) = dir_stats(&newest).await;

    // Cap fits the newest alone, so a real run would evict only the
    // oldest. The dry-run must report the same byte count.
    let freed = gc_storage_cache_with_cap(&home, newest_size, true)
        .await
        .unwrap();

    assert!(oldest.exists(), "dry-run must not delete");
    assert!(newest.exists(), "dry-run must not delete");
    assert_eq!(
        freed, oldest_size,
        "dry-run must report the bytes a real run would free"
    );
}

#[tokio::test]
async fn gc_storage_cache_entry_cap_dry_run_does_not_delete() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let t_new = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000);
    let oldest = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
    let newest = make_storage_entry(&home, "foo", "v2", &[0u8; 32], t_new);
    let oldest_lock = home.storage_lock("foo", "v1");
    let (oldest_size, _) = dir_stats(&oldest).await;

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 1, true)
        .await
        .unwrap();

    assert!(oldest.exists(), "dry-run must not delete oldest entry");
    assert!(newest.exists(), "dry-run must not delete newest entry");
    assert!(
        oldest_lock.exists(),
        "dry-run must not remove the lock file it would clean up"
    );
    assert_eq!(freed, oldest_size);
    assert_eq!(count_storage_cache_versions(&home), 2);
}

#[tokio::test]
async fn gc_storage_cache_removes_lock_after_eviction() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
    let lock_path = home.storage_lock("foo", "v1");
    drop(lock::open_lock_file(&lock_path).unwrap());
    assert!(lock_path.exists(), "test setup must create the lock file");

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 0, false)
        .await
        .unwrap();

    assert!(freed > 0);
    assert!(!entry.exists(), "entry should be evicted");
    assert!(
        !lock_path.exists(),
        "matching storage lock should be removed with the evicted entry"
    );
}

#[tokio::test]
async fn gc_storage_cache_removes_empty_name_dir_after_eviction() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 32], t_old);
    let name_dir = entry.parent().unwrap().to_path_buf();

    let freed = gc_storage_cache_with_limits(&home, 1 << 20, 0, false)
        .await
        .unwrap();

    assert!(freed > 0);
    assert!(!entry.exists(), "entry should be evicted");
    assert!(
        !name_dir.exists(),
        "empty storage name dir should be removed with its last version"
    );
}

#[tokio::test]
async fn gc_storage_cache_lock_cleanup_keeps_replaced_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let lock_path = home.storage_lock("foo", "v1");
    let held_lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("new test lock must not be held"),
        LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
    };

    std::fs::remove_file(&lock_path).unwrap();
    drop(lock::open_lock_file(&lock_path).unwrap());
    assert!(
        lock_path.exists(),
        "test setup must recreate the lock path with a new inode"
    );

    remove_storage_lock_after_eviction(&lock_path, &held_lock, "foo", "v1").await;

    assert!(
        lock_path.exists(),
        "cleanup must not remove a lock path recreated after this lock was acquired"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_storage_cache_lock_cleanup_keeps_symlink_lock_path() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let lock_path = home.storage_lock("foo", "v1");
    let alias = home.locks_dir().join("storage-alias.lock");
    let held_lock = match probe_lock(&lock_path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("new test lock must not be held"),
        LockProbe::Error(e) => panic!("new test lock must be probeable: {e}"),
    };

    std::fs::hard_link(&lock_path, &alias).unwrap();
    std::fs::remove_file(&lock_path).unwrap();
    std::os::unix::fs::symlink(&alias, &lock_path).unwrap();

    remove_storage_lock_after_eviction(&lock_path, &held_lock, "foo", "v1").await;

    assert!(
        std::fs::symlink_metadata(&lock_path)
            .unwrap()
            .file_type()
            .is_symlink(),
        "cleanup must not remove a lock path replaced by a symlink"
    );
}

/// Stale `<version>.tmp/` staging directories are crash residue and
/// should be cleaned even when completed cache entries are under cap.
#[tokio::test]
async fn gc_storage_cache_removes_stale_tmp_staging_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let real = make_storage_entry(&home, "foo", "v1", &[0u8; 128], t_old);
    let tmp = make_storage_staging_entry(&home, "foo", "v2", &[0u8; 128], t_old);
    let (tmp_size, _) = dir_stats(&tmp).await;

    let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
        .await
        .unwrap();

    assert_eq!(freed, tmp_size, "stale .tmp bytes must be reported");
    assert!(real.exists(), "real entry must survive");
    assert!(!tmp.exists(), "stale .tmp staging dir must be removed");
}

#[tokio::test]
async fn gc_storage_cache_reports_zero_byte_staging_removal_as_activity() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let tmp = make_storage_staging_entry(&home, "foo", "v2", &[], t_old);
    let (tmp_size, _) = dir_stats(&tmp).await;
    assert_eq!(tmp_size, 0, "fixture must exercise zero-byte cleanup");

    let report = gc_storage_cache(&home, false).await.unwrap();

    assert!(!tmp.exists(), "stale empty staging dir must be removed");
    assert_eq!(report.freed_bytes, 0);
    assert_eq!(report.activity_count, 1);
}

#[tokio::test]
async fn gc_storage_cache_keeps_recent_tmp_staging_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let tmp = make_storage_staging_entry(&home, "foo", "v1", &[0u8; 128], SystemTime::now());

    let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert!(
        tmp.exists(),
        "recent .tmp staging dir must survive grace window"
    );
}

#[tokio::test]
async fn gc_storage_cache_keeps_locked_tmp_staging_dir() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let tmp = make_storage_staging_entry(&home, "foo", "v1", &[0u8; 128], t_old);
    let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

    let freed = gc_storage_cache_with_cap(&home, 1 << 20, false)
        .await
        .unwrap();

    assert_eq!(freed, 0);
    assert!(tmp.exists(), "locked .tmp staging dir must survive");
}

#[tokio::test]
async fn gc_storage_cache_dry_run_reports_stale_tmp_without_deleting() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let t_old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let tmp = make_storage_staging_entry(&home, "foo", "v1", &[0u8; 128], t_old);
    let (tmp_size, _) = dir_stats(&tmp).await;

    let freed = gc_storage_cache_with_cap(&home, 1 << 20, true)
        .await
        .unwrap();

    assert_eq!(freed, tmp_size);
    assert!(
        tmp.exists(),
        "dry-run must not delete stale .tmp staging dir"
    );
}

#[tokio::test]
async fn gc_storage_cache_delete_recheck_skips_candidate_locked_after_scan() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
    let candidate = storage_candidate_for(entry.clone()).await;

    let lock_file = lock::open_lock_file(&home.storage_lock("foo", "v1")).unwrap();
    let _held = Flock::lock(lock_file, FlockArg::LockShared).unwrap();

    let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

    assert_eq!(result.freed, 0);
    assert_eq!(result.remaining_size, None);
    assert!(result.remaining_entry);
    assert!(!result.evicted);
    assert!(
        entry.exists(),
        "candidate locked after scan must survive delete recheck"
    );
}

#[tokio::test]
async fn gc_storage_cache_delete_recheck_treats_missing_candidate_as_removed() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
    let candidate = storage_candidate_for(entry.clone()).await;

    std::fs::remove_dir_all(&entry).unwrap();

    let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

    assert_eq!(result.freed, 0);
    assert_eq!(result.remaining_size, None);
    assert!(!result.remaining_entry);
    assert!(!result.evicted);
}

#[tokio::test]
async fn gc_storage_cache_delete_recheck_treats_file_candidate_as_removed() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
    let candidate = storage_candidate_for(entry.clone()).await;

    std::fs::remove_dir_all(&entry).unwrap();
    std::fs::write(&entry, b"not-a-directory").unwrap();

    let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

    assert_eq!(result.freed, 0);
    assert_eq!(result.remaining_size, None);
    assert!(!result.remaining_entry);
    assert!(!result.evicted);
    assert!(
        entry.is_file(),
        "non-directory replacement must not be treated as a live cache entry"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn gc_storage_cache_delete_recheck_treats_symlink_candidate_as_removed() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old_gc_time());
    let candidate = storage_candidate_for(entry.clone()).await;
    std::fs::remove_dir_all(&entry).unwrap();

    let outside_version = dir.path().join("outside-replacement-version");
    make_storage_entry_at(outside_version.clone(), &[0u8; 256], old_gc_time());
    std::os::unix::fs::symlink(&outside_version, &entry).unwrap();

    let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;

    assert_eq!(result.freed, 0);
    assert_eq!(result.remaining_size, None);
    assert!(!result.remaining_entry);
    assert!(!result.evicted);
    assert_is_symlink(&entry, "symlink replacement must remain untouched");
    assert!(
        outside_version.exists(),
        "eviction recheck must not delete a symlink replacement target"
    );
}

#[tokio::test]
async fn gc_storage_cache_delete_recheck_keeps_candidate_that_became_recent() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry = make_storage_entry(&home, "foo", "v1", &[0u8; 256], old);
    let candidate = storage_candidate_for(entry.clone()).await;

    std::fs::File::open(&entry)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()))
        .unwrap();

    let result = evict_storage_candidate(&home, &candidate, SystemTime::now(), false).await;
    let (fresh_size, _) = dir_stats(&entry).await;

    assert_eq!(result.freed, 0);
    assert_eq!(result.remaining_size, Some(fresh_size));
    assert!(result.remaining_entry);
    assert!(!result.evicted);
    assert!(
        entry.exists(),
        "candidate that became recent after scan must survive delete recheck"
    );
}

const LOW_FD_STORAGE_GC_CHILD_ENV: &str = "VM0_RUNNER_LOW_FD_STORAGE_GC_CHILD";

#[tokio::test]
async fn gc_storage_cache_many_candidates_does_not_exhaust_lock_fds() {
    run_ignored_child_test(
        "cmd::gc::storage::tests::gc_storage_cache_many_candidates_low_fd_child",
        (LOW_FD_STORAGE_GC_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(60),
    )
    .await;
}

#[tokio::test]
#[ignore = "spawned by gc_storage_cache_many_candidates_does_not_exhaust_lock_fds"]
async fn gc_storage_cache_many_candidates_low_fd_child() {
    if !ignored_child_test_env_guard_enabled((LOW_FD_STORAGE_GC_CHILD_ENV, "1")) {
        return;
    }

    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    std::fs::create_dir_all(home.locks_dir()).unwrap();

    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let entry_count = 220usize;
    let keep_count = 20usize;
    let mut entry_size = 0;
    for index in 0..entry_count {
        let entry = make_storage_entry(&home, &format!("low-fd-{index}"), "v1", &[0u8; 4096], old);
        let size = dir_stats(&entry).await.0;
        if index == 0 {
            entry_size = size;
        } else {
            assert_eq!(
                size, entry_size,
                "storage entry {index} must match the first entry's measured size"
            );
        }
    }
    assert!(
        entry_size > 0,
        "test storage entries must consume disk blocks"
    );

    let _nofile_limit = set_soft_nofile_limit_for_child(128);

    let cap = entry_size * keep_count as u64;
    let expected_freed = entry_size * (entry_count - keep_count) as u64;
    let freed = gc_storage_cache_with_cap(&home, cap, false).await.unwrap();
    let remaining = count_storage_cache_versions(&home);

    assert_eq!(
        remaining, keep_count,
        "storage GC left {remaining} versions with cap for {keep_count}; freed {freed}"
    );
    assert_eq!(freed, expected_freed);
}
