//! Filesystem helpers for private local queue state.

use std::fs::File;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::host_file::{self, DirMode};

pub(crate) fn ensure_profile_jobs_dir(group_dir: &Path, profile: &str) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::profile_jobs_dir(group_dir, profile)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    ensure_queue_dir(&dir, "local queue profile jobs directory")?;
    Ok(dir)
}

pub(crate) fn ensure_results_dir(group_dir: &Path) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::results_dir(group_dir);
    ensure_queue_dir(&dir, "local queue results directory")?;
    Ok(dir)
}

pub(crate) fn ensure_claims_dir(group_dir: &Path) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::claims_dir(group_dir);
    ensure_queue_dir(&dir, "local queue claims directory")?;
    Ok(dir)
}

pub(crate) fn ensure_cancels_dir(group_dir: &Path) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::cancels_dir(group_dir);
    ensure_queue_dir(&dir, "local queue cancels directory")?;
    Ok(dir)
}

fn ensure_group_dir(group_dir: &Path) -> io::Result<()> {
    host_file::ensure_dir(
        group_dir,
        DirMode::SharedTrustedParent,
        "local queue group directory",
    )
}

fn ensure_queue_dir(path: &Path, context: &str) -> io::Result<()> {
    host_file::ensure_dir(path, DirMode::Private, context)
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8], context: &str) -> io::Result<()> {
    let mut file = open_private_file(path, false, true, context)?;
    file.write_all(bytes)
        .map_err(|e| io::Error::new(e.kind(), format!("write {context} {}: {e}", path.display())))
}

pub(crate) fn write_private_marker(path: &Path, context: &str) -> io::Result<()> {
    write_private_file(path, b"", context)
}

pub(crate) fn create_private_marker(path: &Path, context: &str) -> io::Result<()> {
    open_private_file(path, true, false, context).map(|_| ())
}

pub(crate) fn open_private_new_file(path: &Path, context: &str) -> io::Result<File> {
    open_private_file(path, true, false, context)
}

fn open_private_file(
    path: &Path,
    create_new: bool,
    truncate: bool,
    context: &str,
) -> io::Result<File> {
    let parent = host_file::file_parent(path);
    host_file::validate_dir(parent, DirMode::Private, context)?;

    let mut options = File::options();
    options
        .write(true)
        .mode(host_file::PRIVATE_FILE_MODE)
        .custom_flags(host_file::private_file_open_flags());
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(truncate);
    }

    let file = options
        .open(path)
        .map_err(|e| io::Error::new(e.kind(), format!("open {context} {}: {e}", path.display())))?;
    if let Err(e) = host_file::secure_regular_private_file(&file, path, context) {
        if create_new {
            let _ = std::fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn ensure_profile_jobs_dir_keeps_existing_group_dir_mode() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("group");
        std::fs::create_dir(&group_dir).unwrap();
        std::fs::set_permissions(&group_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let job_dir = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();

        assert_eq!(mode(&group_dir), 0o755);
        assert_eq!(mode(&job_dir), 0o700);
    }

    #[test]
    fn ensure_profile_jobs_dir_creates_missing_group_dir_as_shared_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("groups").join("org").join("group");

        let job_dir = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();

        assert_eq!(mode(&group_dir), host_file::SHARED_TRUSTED_DIR_MODE);
        assert_eq!(mode(&job_dir), host_file::PRIVATE_DIR_MODE);
    }

    #[test]
    fn ensure_profile_jobs_dir_rejects_intermediate_group_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        let group_dir = link.join("group");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE)
            .expect_err("intermediate group symlink should be rejected");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("group").exists());
    }
}
