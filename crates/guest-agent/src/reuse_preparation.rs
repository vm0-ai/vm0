//! Safe reclamation of runner-owned runtime state before idle reuse.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
    REUSE_PREPARATION_EXIT_INVALID_REQUEST, ReusePreparationReport, ReusePreparationRequest,
    RootFilesystemCapacity,
};

use crate::nofollow_fs::{Dir, FileIdentity};

const MAX_REQUEST_BYTES: u64 = 64 * 1024;

/// Failure returned by the reuse-preparation helper.
#[derive(Debug)]
pub enum ReusePreparationError {
    /// The typed request or protected runtime paths were invalid.
    InvalidRequest(io::Error),
    /// Rootfs capacity could not be inspected.
    Inspection(io::Error),
    /// Stale runtime entries could not be safely removed.
    Cleanup(io::Error),
}

impl ReusePreparationError {
    /// Return the stable process exit code for this failure category.
    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::InvalidRequest(_) => REUSE_PREPARATION_EXIT_INVALID_REQUEST,
            Self::Inspection(_) => REUSE_PREPARATION_EXIT_INSPECTION_FAILED,
            Self::Cleanup(_) => REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        }
    }
}

impl std::fmt::Display for ReusePreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(error) => write!(f, "invalid reuse-preparation request: {error}"),
            Self::Inspection(error) => write!(f, "rootfs capacity inspection failed: {error}"),
            Self::Cleanup(error) => write!(f, "runtime cleanup failed: {error}"),
        }
    }
}

impl std::error::Error for ReusePreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidRequest(error) | Self::Inspection(error) | Self::Cleanup(error) => {
                Some(error)
            }
        }
    }
}

struct ProtectedRuntime {
    name: OsString,
    identity: FileIdentity,
}

/// Read a bounded request from stdin and prepare the guest for reuse.
pub fn prepare_from_stdin() -> Result<ReusePreparationReport, ReusePreparationError> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(ReusePreparationError::InvalidRequest)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(ReusePreparationError::InvalidRequest(io::Error::new(
            io::ErrorKind::InvalidInput,
            "request exceeds size limit",
        )));
    }
    let request = serde_json::from_slice(&bytes).map_err(|error| {
        ReusePreparationError::InvalidRequest(io::Error::new(io::ErrorKind::InvalidData, error))
    })?;
    prepare(&request)
}

fn prepare(
    request: &ReusePreparationRequest,
) -> Result<ReusePreparationReport, ReusePreparationError> {
    let current_path = Path::new(&request.current_runtime_dir);
    let (runtime_parent, current_name) = split_runtime_path(current_path)?;
    let retained_name = request
        .retained_runtime_dir
        .as_deref()
        .map(Path::new)
        .map(|path| split_retained_runtime_path(path, &runtime_parent))
        .transpose()?;

    let parent = Dir::open_absolute(&runtime_parent).map_err(ReusePreparationError::Cleanup)?;
    let parent_identity = parent.identity().map_err(ReusePreparationError::Cleanup)?;
    let mut protected = vec![open_protected(&parent, current_name, parent_identity)?];
    if let Some(retained_name) = retained_name {
        let retained = open_protected(&parent, retained_name, parent_identity)?;
        if !protected
            .iter()
            .any(|entry| entry.identity == retained.identity)
        {
            protected.push(retained);
        }
    }

    let before = rootfs_capacity().map_err(ReusePreparationError::Inspection)?;
    let protected_identities = protected
        .iter()
        .map(|entry| entry.identity)
        .collect::<Vec<_>>();
    let protected_names = protected
        .iter()
        .map(|entry| entry.name.clone())
        .collect::<Vec<_>>();
    let entries = parent
        .read_dir()
        .map_err(ReusePreparationError::Cleanup)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<Vec<_>>>()
        .map_err(ReusePreparationError::Cleanup)?;
    let mut removed_entries = 0u64;
    for name in entries {
        if protected_names.contains(&name) {
            continue;
        }
        parent
            .remove_child_tree(&name, parent_identity, &protected_identities)
            .map_err(ReusePreparationError::Cleanup)?;
        removed_entries = removed_entries.saturating_add(1);
    }

    for entry in &protected {
        let identity = parent
            .open_child_dir(&entry.name)
            .and_then(|directory| directory.identity())
            .map_err(ReusePreparationError::Cleanup)?;
        if identity != entry.identity {
            return Err(ReusePreparationError::Cleanup(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "protected runtime directory identity changed during cleanup",
            )));
        }
    }

    let after = rootfs_capacity().map_err(ReusePreparationError::Inspection)?;
    Ok(ReusePreparationReport {
        before,
        after,
        removed_entries,
    })
}

fn split_runtime_path(path: &Path) -> Result<(PathBuf, &OsStr), ReusePreparationError> {
    if !path.is_absolute() {
        return Err(invalid_path("current runtime directory must be absolute"));
    }
    let parent = path
        .parent()
        .filter(|parent| *parent != Path::new("/"))
        .ok_or_else(|| invalid_path("current runtime directory must have a non-root parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| invalid_path("current runtime directory must have a basename"))?;
    Ok((parent.to_path_buf(), name))
}

fn split_retained_runtime_path<'a>(
    path: &'a Path,
    expected_parent: &Path,
) -> Result<&'a OsStr, ReusePreparationError> {
    let (parent, name) = split_runtime_path(path)?;
    if parent != expected_parent {
        return Err(invalid_path(
            "retained runtime directory must share the current runtime parent",
        ));
    }
    Ok(name)
}

fn open_protected(
    parent: &Dir,
    name: &OsStr,
    parent_identity: FileIdentity,
) -> Result<ProtectedRuntime, ReusePreparationError> {
    let directory = parent
        .open_child_dir(name)
        .map_err(ReusePreparationError::Cleanup)?;
    let identity = directory
        .identity()
        .map_err(ReusePreparationError::Cleanup)?;
    if identity.device() != parent_identity.device()
        || identity.mount_id() != parent_identity.mount_id()
    {
        return Err(ReusePreparationError::Cleanup(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "protected runtime directory crosses a mount or filesystem boundary",
        )));
    }
    Ok(ProtectedRuntime {
        name: name.to_os_string(),
        identity,
    })
}

fn invalid_path(message: &'static str) -> ReusePreparationError {
    ReusePreparationError::InvalidRequest(io::Error::new(io::ErrorKind::InvalidInput, message))
}

fn rootfs_capacity() -> io::Result<RootFilesystemCapacity> {
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: the path is a static NUL-terminated string and `stats` points to
    // writable memory for the duration of the call.
    let result = unsafe { libc::statvfs(c"/".as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful `statvfs` initialized the full structure.
    let stats = unsafe { stats.assume_init() };
    Ok(RootFilesystemCapacity {
        available_bytes: stats.f_bavail.saturating_mul(stats.f_frsize),
        available_inodes: stats.f_favail,
    })
}
