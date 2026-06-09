use std::path::Path;

use crate::error::{RunnerError, RunnerResult};

pub(crate) const PROXY_REGISTRY_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const USAGE_PENDING_MAX_BYTES: u64 = 64 * 1024;
pub(crate) const WORKSPACE_METADATA_MAX_BYTES: u64 = 1024 * 1024;

const PRIVATE_FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone, Copy)]
pub(crate) enum OwnerCheck {
    None,
    CurrentEuid,
}

pub(crate) async fn read_to_string(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> RunnerResult<Option<String>> {
    let Some(bytes) = read_to_bytes(path, max_bytes, owner_check).await? else {
        return Ok(None);
    };
    String::from_utf8(bytes).map(Some).map_err(|e| {
        RunnerError::Internal(format!("read state file {} as UTF-8: {e}", path.display()))
    })
}

pub(crate) async fn read_to_bytes_required(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> RunnerResult<Vec<u8>> {
    match read_to_bytes(path, max_bytes, owner_check).await? {
        Some(bytes) => Ok(bytes),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("state file {} not found", path.display()),
        )
        .into()),
    }
}

async fn read_to_bytes(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> RunnerResult<Option<Vec<u8>>> {
    #[cfg(unix)]
    {
        read_to_bytes_unix(path, max_bytes, owner_check).await
    }

    #[cfg(not(unix))]
    {
        let _ = owner_check;
        read_to_bytes_fallback(path, max_bytes).await
    }
}

#[cfg(unix)]
async fn read_to_bytes_unix(
    path: &Path,
    max_bytes: u64,
    owner_check: OwnerCheck,
) -> RunnerResult<Option<Vec<u8>>> {
    let mut options = tokio::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    let file = match options.open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "open state file {}: {e}",
                path.display()
            )));
        }
    };
    validate_open_state_file(&file, path, owner_check)?;
    read_open_file_bytes(file, path, max_bytes).await.map(Some)
}

#[cfg(not(unix))]
async fn read_to_bytes_fallback(path: &Path, max_bytes: u64) -> RunnerResult<Option<Vec<u8>>> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(RunnerError::Internal(format!(
                "open state file {}: {e}",
                path.display()
            )));
        }
    };
    read_open_file_bytes(file, path, max_bytes).await.map(Some)
}

async fn read_open_file_bytes(
    file: tokio::fs::File,
    path: &Path,
    max_bytes: u64,
) -> RunnerResult<Vec<u8>> {
    use tokio::io::AsyncReadExt;

    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        RunnerError::Internal(format!(
            "state file {} read limit is too large",
            path.display()
        ))
    })?;
    let mut limited = file.take(read_limit);
    let mut contents = Vec::new();
    limited
        .read_to_end(&mut contents)
        .await
        .map_err(|e| RunnerError::Internal(format!("read state file {}: {e}", path.display())))?;
    if contents.len() as u64 > max_bytes {
        return Err(RunnerError::Internal(format!(
            "state file {} exceeds {} bytes",
            path.display(),
            max_bytes
        )));
    }
    Ok(contents)
}

#[cfg(unix)]
fn validate_open_state_file<Fd: std::os::fd::AsRawFd>(
    file: &Fd,
    path: &Path,
    owner_check: OwnerCheck,
) -> RunnerResult<()> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `file` owns a live fd.
    let result = unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) };
    if result != 0 {
        return Err(RunnerError::Internal(format!(
            "stat state file {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: successful `fstat` initialized the full `stat` struct.
    let stat = unsafe { stat.assume_init() };
    let file_type = stat.st_mode & libc::S_IFMT;
    if file_type != libc::S_IFREG {
        return Err(RunnerError::Internal(format!(
            "{} is not a regular state file",
            path.display()
        )));
    }
    if matches!(owner_check, OwnerCheck::CurrentEuid) {
        let expected_uid = nix::unistd::geteuid().as_raw();
        if stat.st_uid != expected_uid {
            return Err(RunnerError::Internal(format!(
                "{} is owned by uid {}, but runner euid is {expected_uid}",
                path.display(),
                stat.st_uid
            )));
        }
    }
    Ok(())
}

pub(crate) async fn write_private_atomic(path: &Path, content: &[u8]) -> RunnerResult<()> {
    #[cfg(unix)]
    {
        write_private_atomic_unix(path, content).await
    }

    #[cfg(not(unix))]
    {
        tokio::fs::write(path, content)
            .await
            .map_err(|e| RunnerError::Internal(format!("write state file {}: {e}", path.display())))
    }
}

#[cfg(unix)]
async fn write_private_atomic_unix(path: &Path, content: &[u8]) -> RunnerResult<()> {
    use std::ffi::OsString;
    use tokio::io::AsyncWriteExt;

    let file_name = path.file_name().ok_or_else(|| {
        RunnerError::Internal(format!(
            "{} does not have a file name; refusing to write state file",
            path.display()
        ))
    })?;
    let mut tmp_name = OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let tmp = path.with_file_name(tmp_name);

    let result = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true).mode(PRIVATE_FILE_MODE);
        let mut file = options.open(&tmp).await.map_err(|e| {
            RunnerError::Internal(format!("open state file tmp {}: {e}", tmp.display()))
        })?;
        chmod_private_file_fd(&file, &tmp)?;
        file.write_all(content).await.map_err(|e| {
            RunnerError::Internal(format!("write state file tmp {}: {e}", tmp.display()))
        })?;
        file.flush().await.map_err(|e| {
            RunnerError::Internal(format!("flush state file tmp {}: {e}", tmp.display()))
        })?;
        drop(file);
        tokio::fs::rename(&tmp, path).await.map_err(|e| {
            RunnerError::Internal(format!("rename state file {}: {e}", path.display()))
        })?;
        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

#[cfg(unix)]
fn chmod_private_file_fd<Fd: std::os::fd::AsRawFd>(file: &Fd, path: &Path) -> RunnerResult<()> {
    // SAFETY: `fchmod` operates on the live fd.
    let result = unsafe { libc::fchmod(file.as_raw_fd(), PRIVATE_FILE_MODE as libc::mode_t) };
    if result == 0 {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "chmod state file {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        )))
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[tokio::test]
    async fn read_to_string_rejects_symlink_without_reading_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, "target").unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();

        let error = read_to_string(&link, 1024, OwnerCheck::None)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("open state file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_to_string_rejects_fifo_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        let c_path = CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: `c_path` is a valid nul-terminated path for `mkfifo`.
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        let error = read_to_string(&fifo, 1024, OwnerCheck::None)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("not a regular state file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_to_string_rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        let state_dir = dir.path().join("state.json");
        std::fs::create_dir(&state_dir).unwrap();

        let error = read_to_string(&state_dir, 1024, OwnerCheck::None)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("not a regular state file"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn read_to_string_rejects_oversized_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, b"abcdef").unwrap();

        let error = read_to_string(&path, 5, OwnerCheck::None)
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("exceeds 5 bytes"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn write_private_atomic_writes_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");

        write_private_atomic(&path, b"{}").await.unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
