use crate::LOG_TAG;
use guest_common::{log_info, log_warn};
use std::cell::OnceCell;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

/// Remove stale files from cleanup paths, preserving directories that belong
/// to unchanged storages.
///
/// For each path in `cleanup_paths`:
/// - If a preserved path is a child: remove only top-level entries that don't
///   overlap with any preserved child path.
/// - If no `preserved` path is a child and the path is a mountpoint: preserve
///   the mountpoint directory and clean its contents.
/// - Otherwise: `remove_dir_all` (clean slate).
pub(crate) fn cleanup_stale_paths(cleanup_paths: &[String], preserved: &[String]) {
    cleanup_stale_paths_with_mountinfo_loader(cleanup_paths, preserved, cleanup_mountinfo);
}

fn cleanup_stale_paths_with_mountinfo_loader<L>(
    cleanup_paths: &[String],
    preserved: &[String],
    load_mountinfo: L,
) where
    L: Fn() -> io::Result<String>,
{
    let detector = CleanupMountPointDetector::new(load_mountinfo);
    cleanup_stale_paths_with_mount_detector(cleanup_paths, preserved, |path| {
        detector.is_mount_point(path)
    });
}

fn cleanup_stale_paths_with_mount_detector<M>(
    cleanup_paths: &[String],
    preserved: &[String],
    is_mount_point: M,
) where
    M: Fn(&Path) -> bool,
{
    cleanup_stale_paths_with_options(cleanup_paths, preserved, is_mount_point, remove_entry);
}

fn cleanup_stale_paths_with_options<M, R>(
    cleanup_paths: &[String],
    preserved: &[String],
    is_mount_point: M,
    remove_entry: R,
) where
    M: Fn(&Path) -> bool,
    R: Fn(&fs::DirEntry) -> io::Result<()>,
{
    // Sort cleanup paths shortest-first so parents are cleaned before children.
    let mut sorted: Vec<&str> = cleanup_paths.iter().map(|s| s.as_str()).collect();
    sorted.sort_by_key(|p| p.len());

    for path in sorted {
        let cleanup_path = Path::new(path);
        let preserved_child_count = count_preserved_children(cleanup_path, preserved);

        if preserved_child_count > 0 {
            clean_directory_contents(cleanup_path, preserved, &remove_entry);
            log_info!(
                LOG_TAG,
                "Selectively cleaned {path} (preserved {} children)",
                preserved_child_count
            );
        } else if is_mount_point(cleanup_path) {
            // Removing a mounted filesystem root can fail on filesystem metadata
            // such as ext4 lost+found. Keep the mountpoint and remove entries.
            clean_directory_contents(cleanup_path, preserved, &remove_entry);
            log_info!(LOG_TAG, "Cleaned mountpoint contents: {path}");
        } else if let Err(e) = fs::remove_dir_all(cleanup_path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log_warn!(LOG_TAG, "Failed to clean {path}: {e}");
            }
        } else {
            log_info!(LOG_TAG, "Cleaned stale path: {path}");
        }
    }
}

fn clean_directory_contents<R>(path: &Path, preserved: &[String], remove_entry: &R)
where
    R: Fn(&fs::DirEntry) -> io::Result<()>,
{
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                log_warn!(LOG_TAG, "Failed to read dir {}: {e}", path.display());
            }
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log_warn!(LOG_TAG, "Failed to read entry in {}: {e}", path.display());
                continue;
            }
        };
        let entry_path = entry.path();

        if entry_overlaps_preserved_path(&entry_path, preserved) {
            continue;
        }

        if let Err(e) = remove_entry(&entry) {
            log_warn!(LOG_TAG, "Failed to remove {}: {e}", entry_path.display());
        }
    }
}

fn remove_entry(entry: &fs::DirEntry) -> io::Result<()> {
    let entry_path = entry.path();
    if entry.file_type()?.is_dir() {
        fs::remove_dir_all(entry_path)
    } else {
        fs::remove_file(entry_path)
    }
}

fn count_preserved_children(path: &Path, preserved: &[String]) -> usize {
    preserved
        .iter()
        .filter(|preserved_path| {
            let preserved_path = Path::new(preserved_path);
            preserved_path != path && preserved_path.starts_with(path)
        })
        .count()
}

fn entry_overlaps_preserved_path(entry_path: &Path, preserved: &[String]) -> bool {
    preserved.iter().any(|preserved_path| {
        let preserved_path = Path::new(preserved_path);
        preserved_path == entry_path || preserved_path.starts_with(entry_path)
    })
}

struct CleanupMountPointDetector<L>
where
    L: Fn() -> io::Result<String>,
{
    load_mountinfo: L,
    mount_points: OnceCell<Option<HashSet<PathBuf>>>,
}

impl<L> CleanupMountPointDetector<L>
where
    L: Fn() -> io::Result<String>,
{
    fn new(load_mountinfo: L) -> Self {
        Self {
            load_mountinfo,
            mount_points: OnceCell::new(),
        }
    }

    fn is_mount_point(&self, path: &Path) -> bool {
        let path = match absolute_path_without_following_final_symlink(path) {
            Ok(path) => path,
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to resolve cleanup path {}: {e}",
                    path.display()
                );
                return false;
            }
        };

        self.mount_points()
            .is_some_and(|mount_points| mount_points.contains(&path))
    }

    fn mount_points(&self) -> Option<&HashSet<PathBuf>> {
        let load_mountinfo = &self.load_mountinfo;
        self.mount_points
            .get_or_init(|| match load_mountinfo() {
                Ok(mountinfo) => Some(mount_points_from_mountinfo(&mountinfo)),
                Err(e) => {
                    log_warn!(LOG_TAG, "Failed to read /proc/self/mountinfo: {e}");
                    None
                }
            })
            .as_ref()
    }
}

fn cleanup_mountinfo() -> io::Result<String> {
    fs::read_to_string("/proc/self/mountinfo")
}

fn absolute_path_without_following_final_symlink(path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn mount_points_from_mountinfo(mountinfo: &str) -> HashSet<PathBuf> {
    mountinfo
        .lines()
        .filter_map(mount_point_from_mountinfo_line)
        .collect()
}

fn mount_point_from_mountinfo_line(line: &str) -> Option<PathBuf> {
    let encoded_mount_point = line.split_whitespace().nth(4)?;
    Some(decode_mountinfo_path(encoded_mount_point))
}

fn decode_mountinfo_path(encoded: &str) -> PathBuf {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        let Some(&byte) = bytes.get(i) else {
            break;
        };
        if byte == b'\\' {
            let escape = (bytes.get(i + 1), bytes.get(i + 2), bytes.get(i + 3));
            let (Some(&first), Some(&second), Some(&third)) = escape else {
                decoded.push(byte);
                i += 1;
                continue;
            };
            if !is_octal_digit(first) || !is_octal_digit(second) || !is_octal_digit(third) {
                decoded.push(byte);
                i += 1;
                continue;
            }

            let value =
                ((first - b'0') as u16) * 64 + ((second - b'0') as u16) * 8 + (third - b'0') as u16;
            if value <= u8::MAX as u16 {
                decoded.push(value as u8);
                i += 4;
            } else {
                decoded.push(byte);
                i += 1;
            }
        } else {
            decoded.push(byte);
            i += 1;
        }
    }

    PathBuf::from(OsString::from_vec(decoded))
}

fn is_octal_digit(byte: u8) -> bool {
    (b'0'..=b'7').contains(&byte)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::ffi::OsStr;

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn mountinfo_line(path: &Path) -> String {
        format!(
            "36 25 0:32 / {} rw,relatime - ext4 /dev/vdb rw\n",
            path.display()
        )
    }

    #[test]
    fn cleanup_removes_path_without_preserved_children() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mount");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("stale.txt"), "old").unwrap();

        cleanup_stale_paths(&[path_string(&path)], &[]);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_preserves_unchanged_children() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("claude");
        let child = parent.join("skills").join("foo");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("CLAUDE.md"), "old instructions").unwrap();
        fs::write(child.join("skill.md"), "keep me").unwrap();

        let parent_str = path_string(&parent);
        let child_str = path_string(&child);

        cleanup_stale_paths(&[parent_str], &[child_str]);

        // Parent dir still exists (not fully removed)
        assert!(parent.exists());
        // Child preserved
        assert!(child.join("skill.md").exists());
        // Stale file at parent level removed
        assert!(!parent.join("CLAUDE.md").exists());
    }

    #[test]
    fn cleanup_mountinfo_detector_loads_mountinfo_once_for_multiple_paths() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("stale.txt"), "old").unwrap();
        fs::write(second.join("stale.txt"), "old").unwrap();

        let mountinfo = format!("{}{}", mountinfo_line(&first), mountinfo_line(&second));
        let load_count = Cell::new(0);

        cleanup_stale_paths_with_mountinfo_loader(
            &[path_string(&first), path_string(&second)],
            &[],
            || {
                load_count.set(load_count.get() + 1);
                Ok(mountinfo.clone())
            },
        );

        assert_eq!(load_count.get(), 1);
        assert!(first.exists());
        assert!(second.exists());
        assert!(!first.join("stale.txt").exists());
        assert!(!second.join("stale.txt").exists());
    }

    #[test]
    fn cleanup_preserved_children_do_not_load_mountinfo() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let child = parent.join("cache");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("stale.txt"), "old").unwrap();
        fs::write(child.join("keep.txt"), "keep").unwrap();
        let load_count = Cell::new(0);

        cleanup_stale_paths_with_mountinfo_loader(
            &[path_string(&parent)],
            &[path_string(&child)],
            || {
                load_count.set(load_count.get() + 1);
                Ok(String::new())
            },
        );

        assert_eq!(load_count.get(), 0);
        assert!(parent.exists());
        assert!(child.join("keep.txt").exists());
        assert!(!parent.join("stale.txt").exists());
    }

    #[test]
    fn cleanup_mountinfo_read_failure_is_cached_for_pass() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let load_count = Cell::new(0);

        cleanup_stale_paths_with_mountinfo_loader(
            &[path_string(&first), path_string(&second)],
            &[],
            || {
                load_count.set(load_count.get() + 1);
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "mountinfo unavailable",
                ))
            },
        );

        assert_eq!(load_count.get(), 1);
        assert!(!first.exists());
        assert!(!second.exists());
    }

    #[test]
    fn cleanup_does_not_treat_preserved_sibling_prefix_as_child() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let cleanup_path = parent.join("cache");
        let preserved_sibling = parent.join("cache-old");
        fs::create_dir_all(&cleanup_path).unwrap();
        fs::create_dir_all(&preserved_sibling).unwrap();
        fs::write(cleanup_path.join("stale.txt"), "old").unwrap();
        fs::write(preserved_sibling.join("keep.txt"), "keep").unwrap();

        cleanup_stale_paths_with_mount_detector(
            &[path_string(&cleanup_path)],
            &[path_string(&preserved_sibling)],
            |_| false,
        );

        assert!(!cleanup_path.exists());
        assert!(preserved_sibling.join("keep.txt").exists());
    }

    #[test]
    fn cleanup_does_not_treat_entry_sibling_prefix_as_preserved() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let stale_sibling = parent.join("cache");
        let preserved_child = parent.join("cache-old");
        fs::create_dir_all(&stale_sibling).unwrap();
        fs::create_dir_all(&preserved_child).unwrap();
        fs::write(stale_sibling.join("stale.txt"), "old").unwrap();
        fs::write(preserved_child.join("keep.txt"), "keep").unwrap();

        cleanup_stale_paths(&[path_string(&parent)], &[path_string(&preserved_child)]);

        assert!(parent.exists());
        assert!(!stale_sibling.exists());
        assert!(preserved_child.join("keep.txt").exists());
    }

    #[test]
    fn cleanup_handles_nonexistent_path() {
        disable_system_log();
        // Should not panic
        cleanup_stale_paths(&["/nonexistent/path/12345".into()], &[]);
    }

    #[test]
    fn cleanup_mountpoint_removes_contents_but_keeps_root() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        fs::create_dir_all(path.join("old-dir")).unwrap();
        fs::write(path.join("old-dir").join("nested.txt"), "old").unwrap();
        fs::write(path.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_mount_detector(&[path_string(&path)], &[], |candidate| {
            candidate == path
        });

        assert!(path.exists());
        assert!(!path.join("agent.txt").exists());
        assert!(!path.join("old-dir").exists());
    }

    #[test]
    fn cleanup_mountpoint_continues_after_protected_root_entry() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        let metadata_dir = path.join("lost+found");
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(path.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_options(
            &[path_string(&path)],
            &[],
            |candidate| candidate == path,
            |entry| {
                if entry.file_name() == OsStr::new("lost+found") {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "protected filesystem metadata",
                    ))
                } else {
                    remove_entry(entry)
                }
            },
        );

        assert!(path.exists());
        assert!(metadata_dir.exists());
        assert!(!path.join("agent.txt").exists());
    }

    #[test]
    fn cleanup_does_not_globally_skip_lost_found() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        fs::create_dir_all(path.join("lost+found")).unwrap();
        fs::create_dir_all(path.join("stale").join("lost+found")).unwrap();

        cleanup_stale_paths_with_mount_detector(&[path_string(&path)], &[], |candidate| {
            candidate == path
        });

        assert!(path.exists());
        assert!(!path.join("lost+found").exists());
        assert!(!path.join("stale").exists());
    }

    #[test]
    fn cleanup_non_mount_lost_found_is_removed_with_parent() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        fs::create_dir_all(path.join("lost+found")).unwrap();
        fs::create_dir_all(path.join("stale").join("lost+found")).unwrap();

        cleanup_stale_paths_with_mount_detector(&[path_string(&path)], &[], |_| false);

        assert!(!path.exists());
    }

    #[test]
    fn cleanup_mountpoint_preserves_cached_child() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace");
        let child = path.join("cache");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("keep.txt"), "keep").unwrap();
        fs::write(path.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_mount_detector(
            &[path_string(&path)],
            &[path_string(&child)],
            |candidate| candidate == path,
        );

        assert!(path.exists());
        assert!(child.join("keep.txt").exists());
        assert!(!path.join("agent.txt").exists());
    }

    #[test]
    fn cleanup_parent_before_child_ordering_with_mountpoint_root() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("workspace");
        let child = parent.join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(child.join("stale.txt"), "old").unwrap();
        fs::write(parent.join("agent.txt"), "old").unwrap();

        cleanup_stale_paths_with_mount_detector(
            &[path_string(&child), path_string(&parent)],
            &[],
            |candidate| candidate == parent,
        );

        assert!(parent.exists());
        assert!(!parent.join("agent.txt").exists());
        assert!(!child.exists());
    }

    #[test]
    fn mountinfo_contains_exact_mount_point() {
        let mountinfo = "\
36 25 0:32 / /home/user/workspace rw,relatime - ext4 /dev/vdb rw
37 25 0:33 / /home/user rw,relatime - ext4 /dev/root rw
";

        assert!(mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace")));
    }

    #[test]
    fn mountinfo_does_not_match_mount_point_prefix() {
        let mountinfo = "\
36 25 0:32 / /home/user/workspace-old rw,relatime - ext4 /dev/vdb rw
37 25 0:33 / /home/user rw,relatime - ext4 /dev/root rw
";

        assert!(
            !mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace"))
        );
    }

    #[test]
    fn mountinfo_decodes_escaped_mount_point_path() {
        let mountinfo = r"36 25 0:32 / /home/user/work\040space rw,relatime - ext4 /dev/vdb rw";

        assert!(
            mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/work space"))
        );
    }

    #[test]
    fn mountinfo_returns_false_for_non_mount_path() {
        let mountinfo = "36 25 0:32 / /home/user rw,relatime - ext4 /dev/root rw";

        assert!(
            !mount_points_from_mountinfo(mountinfo).contains(Path::new("/home/user/workspace"))
        );
    }
}
