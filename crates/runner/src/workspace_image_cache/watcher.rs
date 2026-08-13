use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd, RawFd};

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, WatchDescriptor};
use tokio::io::unix::AsyncFd;

use crate::error::{RunnerError, RunnerResult};
use crate::host_file::{self, DirMode};
use crate::types::MAX_HELD_WORKSPACE_STATES;

use super::WorkspaceImageCache;
use super::entry::is_cache_key_name;

const METADATA_FILE_NAME: &str = "metadata.json";
const CURRENT_IMAGE_FILE_NAME: &str = "current.ext4";

const ROOT_WATCH_FLAGS: AddWatchFlags = AddWatchFlags::IN_CREATE
    .union(AddWatchFlags::IN_MOVED_TO)
    .union(AddWatchFlags::IN_DELETE)
    .union(AddWatchFlags::IN_MOVED_FROM)
    .union(AddWatchFlags::IN_DELETE_SELF)
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_ONLYDIR)
    .union(AddWatchFlags::IN_DONT_FOLLOW);

const ENTRY_WATCH_FLAGS: AddWatchFlags = AddWatchFlags::IN_MOVED_TO
    .union(AddWatchFlags::IN_DELETE)
    .union(AddWatchFlags::IN_MOVED_FROM)
    .union(AddWatchFlags::IN_DELETE_SELF)
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_ONLYDIR)
    .union(AddWatchFlags::IN_DONT_FOLLOW);

const WATCH_INVALIDATION_FLAGS: AddWatchFlags = AddWatchFlags::IN_DELETE_SELF
    .union(AddWatchFlags::IN_MOVE_SELF)
    .union(AddWatchFlags::IN_UNMOUNT)
    .union(AddWatchFlags::IN_IGNORED);
const MAX_EVENT_READ_BATCHES_PER_CHANGE: usize = 16;

/// Advisory cache mutation observed from the host-shared filesystem.
///
/// Cache keys identify metadata commits whose existing entry locks should be
/// awaited before authoritative validation. An empty set still requests a full
/// reconciliation for removal, invalidation, or queue-overflow events.
#[derive(Debug)]
pub(crate) struct WorkspaceCacheChange {
    pub(crate) observed_at: tokio::time::Instant,
    pub(crate) committed_cache_keys: BTreeSet<String>,
}

impl WorkspaceCacheChange {
    pub(crate) fn merge(&mut self, other: Self) {
        self.observed_at = self.observed_at.min(other.observed_at);
        for cache_key in other.committed_cache_keys {
            if self.committed_cache_keys.len() == MAX_HELD_WORKSPACE_STATES {
                break;
            }
            self.committed_cache_keys.insert(cache_key);
        }
    }
}

/// Non-recursive inotify observer for one host-shared workspace cache.
pub(crate) struct WorkspaceCacheWatcher {
    inotify: AsyncFd<AsyncInotify>,
    root_watch: WatchDescriptor,
    cache_key_by_watch: BTreeMap<WatchDescriptor, String>,
    watch_by_cache_key: BTreeMap<String, WatchDescriptor>,
    cache: WorkspaceImageCache,
}

struct AsyncInotify(Inotify);

impl AsRawFd for AsyncInotify {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_fd().as_raw_fd()
    }
}

impl WorkspaceCacheWatcher {
    pub(crate) fn new(cache: WorkspaceImageCache) -> RunnerResult<Self> {
        host_file::ensure_dir(
            cache.workspace_image_cache_dir(),
            DirMode::Private,
            "workspace image cache root",
        )
        .map_err(|error| watcher_io_error("prepare root", error.kind()))?;
        let inotify = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)
            .map_err(|error| watcher_error("initialize", error))?;
        let root_watch = inotify
            .add_watch(cache.workspace_image_cache_dir(), ROOT_WATCH_FLAGS)
            .map_err(|error| watcher_error("watch root", error))?;
        let inotify = AsyncFd::new(AsyncInotify(inotify))
            .map_err(|error| watcher_io_error("register descriptor", error.kind()))?;
        let mut watcher = Self {
            inotify,
            root_watch,
            cache_key_by_watch: BTreeMap::new(),
            watch_by_cache_key: BTreeMap::new(),
            cache,
        };
        watcher.reconcile_entry_watches(&mut BTreeSet::new())?;
        Ok(watcher)
    }

    /// Waits for and coalesces all currently readable relevant mutations.
    pub(crate) async fn next_change(&mut self) -> RunnerResult<WorkspaceCacheChange> {
        loop {
            let mut ready = self
                .inotify
                .readable()
                .await
                .map_err(|error| watcher_io_error("wait for events", error.kind()))?;
            ready.clear_ready();
            drop(ready);

            let observed_at = tokio::time::Instant::now();
            let mut changed = false;
            let mut reconcile_entry_watches = false;
            let mut committed_cache_keys = BTreeSet::new();
            let mut drained_all_events = false;
            for _ in 0..MAX_EVENT_READ_BATCHES_PER_CHANGE {
                let events = match self.inotify.get_ref().0.read_events() {
                    Ok(events) => events,
                    Err(Errno::EAGAIN) => {
                        drained_all_events = true;
                        break;
                    }
                    Err(error) => return Err(watcher_error("read events", error)),
                };
                for event in events {
                    if event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW) {
                        changed = true;
                        reconcile_entry_watches = true;
                        continue;
                    }
                    if event.wd == self.root_watch {
                        if event.mask.intersects(WATCH_INVALIDATION_FLAGS) {
                            return Err(RunnerError::Internal(
                                "workspace cache root watch invalidated".to_string(),
                            ));
                        }
                        let Some(cache_key) = event
                            .name
                            .as_deref()
                            .and_then(OsStr::to_str)
                            .filter(|name| is_cache_key_name(name))
                        else {
                            continue;
                        };
                        if event
                            .mask
                            .intersects(AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
                        {
                            reconcile_entry_watches = true;
                        }
                        if event
                            .mask
                            .intersects(AddWatchFlags::IN_DELETE | AddWatchFlags::IN_MOVED_FROM)
                        {
                            changed = true;
                            reconcile_entry_watches = true;
                            self.forget_entry_watch(cache_key);
                        }
                        continue;
                    }

                    let Some(cache_key) = self.cache_key_by_watch.get(&event.wd).cloned() else {
                        continue;
                    };
                    if event.mask.intersects(WATCH_INVALIDATION_FLAGS) {
                        self.forget_watch_descriptor(event.wd);
                        changed = true;
                        reconcile_entry_watches = true;
                        continue;
                    }
                    let Some(name) = event.name.as_deref() else {
                        continue;
                    };
                    if name == OsStr::new(METADATA_FILE_NAME)
                        && event.mask.contains(AddWatchFlags::IN_MOVED_TO)
                    {
                        changed = true;
                        if committed_cache_keys.len() < MAX_HELD_WORKSPACE_STATES {
                            committed_cache_keys.insert(cache_key);
                        }
                    } else if (name == OsStr::new(METADATA_FILE_NAME)
                        || name == OsStr::new(CURRENT_IMAGE_FILE_NAME))
                        && event
                            .mask
                            .intersects(AddWatchFlags::IN_DELETE | AddWatchFlags::IN_MOVED_FROM)
                    {
                        changed = true;
                    }
                }
            }
            if !drained_all_events {
                // Bound one reactor turn even when producers keep the queue
                // continuously readable. Reconciliation covers events beyond
                // the batch budget, which remain queued for the next turn.
                changed = true;
                reconcile_entry_watches = true;
            }

            if reconcile_entry_watches {
                self.reconcile_entry_watches(&mut committed_cache_keys)?;
            }
            if changed || !committed_cache_keys.is_empty() {
                return Ok(WorkspaceCacheChange {
                    observed_at,
                    committed_cache_keys,
                });
            }
        }
    }

    fn reconcile_entry_watches(
        &mut self,
        committed_cache_keys: &mut BTreeSet<String>,
    ) -> RunnerResult<()> {
        let stale_cache_keys = self
            .watch_by_cache_key
            .keys()
            .filter(|cache_key| {
                match std::fs::symlink_metadata(
                    self.cache.workspace_image_cache_entry_dir(cache_key),
                ) {
                    Ok(metadata) => !metadata.is_dir(),
                    Err(_) => true,
                }
            })
            .cloned()
            .collect::<Vec<_>>();
        for cache_key in stale_cache_keys {
            self.forget_entry_watch(&cache_key);
        }

        if self.watch_by_cache_key.len() == MAX_HELD_WORKSPACE_STATES {
            return Ok(());
        }
        let entries = std::fs::read_dir(self.cache.workspace_image_cache_dir())
            .map_err(|error| watcher_io_error("scan entries", error.kind()))?;
        for entry in entries {
            if self.watch_by_cache_key.len() == MAX_HELD_WORKSPACE_STATES {
                break;
            }
            let entry = entry.map_err(|error| watcher_io_error("read entry", error.kind()))?;
            if !entry
                .file_type()
                .map_err(|error| watcher_io_error("read entry type", error.kind()))?
                .is_dir()
            {
                continue;
            }
            let Some(cache_key) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_cache_key_name(&cache_key) {
                continue;
            }
            if self.watch_by_cache_key.contains_key(&cache_key) {
                continue;
            }
            let entry_dir = self.cache.workspace_image_cache_entry_dir(&cache_key);
            let watch = match self
                .inotify
                .get_ref()
                .0
                .add_watch(&entry_dir, ENTRY_WATCH_FLAGS)
            {
                Ok(watch) => watch,
                Err(Errno::ENOENT | Errno::ENOTDIR) => continue,
                Err(error) => return Err(watcher_error("watch entry", error)),
            };
            self.cache_key_by_watch.insert(watch, cache_key.clone());
            self.watch_by_cache_key.insert(cache_key.clone(), watch);
            if std::fs::symlink_metadata(self.cache.workspace_image_cache_metadata(&cache_key))
                .is_ok()
                && committed_cache_keys.len() < MAX_HELD_WORKSPACE_STATES
            {
                committed_cache_keys.insert(cache_key);
            }
        }
        Ok(())
    }

    fn forget_entry_watch(&mut self, cache_key: &str) {
        if let Some(watch) = self.watch_by_cache_key.remove(cache_key) {
            self.cache_key_by_watch.remove(&watch);
            let _ = self.inotify.get_ref().0.rm_watch(watch);
        }
    }

    fn forget_watch_descriptor(&mut self, watch: WatchDescriptor) {
        if let Some(cache_key) = self.cache_key_by_watch.remove(&watch) {
            self.watch_by_cache_key.remove(&cache_key);
        }
    }
}

fn watcher_error(action: &str, error: Errno) -> RunnerError {
    RunnerError::Internal(format!("workspace cache watcher {action}: {error}"))
}

fn watcher_io_error(action: &str, kind: std::io::ErrorKind) -> RunnerError {
    RunnerError::Internal(format!("workspace cache watcher {action}: {kind:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::RunnerPaths;

    #[tokio::test]
    async fn reports_metadata_commit_and_removal_from_existing_entry() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let cache_key = "a".repeat(64);
        cache
            .ensure_workspace_cache_entry_dir(&cache_key)
            .await
            .unwrap();
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).unwrap();

        let metadata = cache.workspace_image_cache_metadata(&cache_key);
        let temporary_metadata = metadata.with_extension("tmp");
        tokio::fs::write(&temporary_metadata, b"{}").await.unwrap();
        tokio::fs::rename(&temporary_metadata, &metadata)
            .await
            .unwrap();
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.committed_cache_keys, BTreeSet::from([cache_key]));

        tokio::fs::remove_file(metadata).await.unwrap();
        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert!(change.committed_cache_keys.is_empty());
    }

    #[tokio::test]
    async fn newly_created_entry_with_committed_metadata_is_not_lost() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let mut watcher = WorkspaceCacheWatcher::new(cache.clone()).unwrap();
        let cache_key = "b".repeat(64);
        let entry_dir = cache.workspace_image_cache_entry_dir(&cache_key);
        tokio::fs::create_dir_all(&entry_dir).await.unwrap();
        tokio::fs::write(entry_dir.join(METADATA_FILE_NAME), b"{}")
            .await
            .unwrap();

        let change = tokio::time::timeout(std::time::Duration::from_secs(2), watcher.next_change())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.committed_cache_keys, BTreeSet::from([cache_key]));
    }

    #[test]
    fn setup_error_does_not_expose_cache_path() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RunnerPaths::new(temp.path().join("runner"));
        let cache = WorkspaceImageCache::new(paths);
        let cache_root = cache.workspace_image_cache_dir().to_path_buf();
        std::fs::create_dir_all(cache_root.parent().unwrap()).unwrap();
        std::fs::write(&cache_root, b"not a directory").unwrap();

        let error = match WorkspaceCacheWatcher::new(cache) {
            Ok(_) => panic!("watcher setup should reject a non-directory cache root"),
            Err(error) => error,
        };
        let message = error.to_string();

        assert!(message.contains("workspace cache watcher prepare root"));
        assert!(!message.contains(&cache_root.display().to_string()));
    }
}
