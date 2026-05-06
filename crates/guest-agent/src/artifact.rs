//! VAS artifact upload — SHA-256 hashing, tar.gz creation, S3 presigned upload.
//!
//! Flow (caller first walks the mount via [`walk_files`], then invokes
//! [`create_snapshot`] with the pre-walked file list):
//! 1. POST `/storages/prepare` with file list → get presigned URLs
//! 2. If deduplicated, POST `/storages/commit` to update HEAD
//! 3. Create tar.gz archive
//! 4. Create manifest.json
//! 5. PUT archive + manifest to S3
//! 6. POST `/storages/commit`

use crate::constants;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::urls;
use api_contracts::generated::types::webhooks::agent::storages::{
    commit as storage_commit, prepare as storage_prepare,
};
use flate2::Compression;
use flate2::write::GzEncoder;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Serialize, Clone)]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    pub(crate) hash: String,
    pub(crate) size: u64,
}

pub(crate) struct SnapshotResult {
    pub(crate) version_id: String,
}

pub(crate) struct CreateSnapshotRequest<'a> {
    pub(crate) mount_path: &'a str,
    pub(crate) files: Vec<FileEntry>,
    pub(crate) storage_name: &'a str,
    pub(crate) storage_type: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) message: &'a str,
    pub(crate) parent_version_id: &'a str,
}

fn non_empty_string(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn to_prepare_files(files: &[FileEntry]) -> Vec<storage_prepare::RequestFile> {
    files
        .iter()
        .map(|file| storage_prepare::RequestFile {
            path: file.path.clone(),
            hash: file.hash.clone(),
            size: file.size,
        })
        .collect()
}

fn to_commit_files(files: &[FileEntry]) -> Vec<storage_commit::RequestFile> {
    files
        .iter()
        .map(|file| storage_commit::RequestFile {
            path: file.path.clone(),
            hash: file.hash.clone(),
            size: file.size,
        })
        .collect()
}

/// Walk `mount_path` in a blocking task and collect `FileEntry` records,
/// recording the hash-compute op and emitting a "Found N files" log. Exposed
/// so the checkpoint step can pre-walk once, decide whether to skip, and reuse
/// the result for `create_snapshot` without a second walk.
pub(crate) async fn walk_files(mount_path: &str) -> Result<Vec<FileEntry>, AgentError> {
    log_info!(LOG_TAG, "Computing file hashes...");
    let hash_start = std::time::Instant::now();
    let mount = mount_path.to_string();
    let files = tokio::task::spawn_blocking(move || collect_file_metadata(&mount))
        .await
        .map_err(|e| AgentError::Execution(format!("hash task panicked: {e}")))?;
    record_sandbox_op("artifact_hash_compute", hash_start.elapsed(), true, None);
    log_info!(LOG_TAG, "Found {} files", files.len());
    Ok(files)
}

/// Create a VAS snapshot using direct S3 upload. Caller provides the
/// pre-walked file list (see [`walk_files`]) — this lets the checkpoint step
/// share one walk between its skip-check fingerprint and the snapshot upload.
pub(crate) async fn create_snapshot(
    http: &HttpClient,
    request: CreateSnapshotRequest<'_>,
) -> Result<SnapshotResult, AgentError> {
    let CreateSnapshotRequest {
        mount_path,
        files,
        storage_name,
        storage_type,
        run_id,
        message,
        parent_version_id,
    } = request;

    log_info!(
        LOG_TAG,
        "Creating direct upload snapshot for '{storage_name}'"
    );

    // Step 1: Prepare
    log_info!(LOG_TAG, "Calling prepare endpoint...");
    let prep_start = std::time::Instant::now();
    let prep_payload = storage_prepare::Request {
        run_id: run_id.to_string(),
        storage_name: storage_name.to_string(),
        storage_type: storage_type.to_string(),
        files: to_prepare_files(&files),
        parent_version_id: non_empty_string(parent_version_id),
        force: None,
        base_version: None,
        changes: None,
    };

    let prep_result = http
        .post_json(
            urls::storage_prepare_url(),
            &prep_payload,
            constants::HTTP_MAX_RETRIES,
        )
        .await;
    let prep_resp = match prep_result {
        Ok(Some(v)) => v,
        Ok(None) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint("Empty prepare response".into()));
        }
        Err(e) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(e);
        }
    };
    let prep: storage_prepare::Response = match serde_json::from_value(prep_resp) {
        Ok(prep) => prep,
        Err(e) => {
            let message = e.to_string();
            record_sandbox_op(
                "artifact_prepare_api",
                prep_start.elapsed(),
                false,
                Some(&message),
            );
            return Err(AgentError::Checkpoint(message));
        }
    };

    let version_id = prep.version_id;
    record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), true, None);

    // Step 2: Deduplication check
    if prep.existing {
        log_info!(
            LOG_TAG,
            "Version already exists (deduplicated), updating HEAD"
        );
        log_info!(LOG_TAG, "Validating deduplicated artifact inputs...");
        let validate_start = std::time::Instant::now();
        let validate_mount = mount_path.to_string();
        let validate_files = files.clone();
        let validate_result = match tokio::task::spawn_blocking(move || {
            validate_archive_inputs(&validate_mount, &validate_files)
        })
        .await
        {
            Ok(result) => result,
            Err(e) => {
                record_sandbox_op(
                    "artifact_archive_validate",
                    validate_start.elapsed(),
                    false,
                    None,
                );
                return Err(AgentError::Execution(format!(
                    "archive validation task panicked: {e}"
                )));
            }
        };
        if let Err(e) = validate_result {
            log_error!(LOG_TAG, "Failed to validate deduplicated archive: {e}");
            record_sandbox_op(
                "artifact_archive_validate",
                validate_start.elapsed(),
                false,
                None,
            );
            return Err(AgentError::Checkpoint(
                "Failed to validate archive inputs".into(),
            ));
        }
        record_sandbox_op(
            "artifact_archive_validate",
            validate_start.elapsed(),
            true,
            None,
        );

        let commit_payload = storage_commit::Request {
            run_id: run_id.to_string(),
            storage_name: storage_name.to_string(),
            storage_type: storage_type.to_string(),
            version_id: version_id.clone(),
            parent_version_id: non_empty_string(parent_version_id),
            files: to_commit_files(&files),
            message: None,
        };
        let resp = http
            .post_json(
                urls::storage_commit_url(),
                &commit_payload,
                constants::HTTP_MAX_RETRIES,
            )
            .await?;
        let commit_success = resp
            .map(|v| {
                serde_json::from_value::<storage_commit::Response>(v)
                    .map(|commit| commit.success)
                    .unwrap_or_else(|e| {
                        log_warn!(LOG_TAG, "Failed to parse dedup commit response: {e}");
                        false
                    })
            })
            .unwrap_or(false);
        if !commit_success {
            return Err(AgentError::Checkpoint("Failed to update HEAD".into()));
        }
        return Ok(SnapshotResult { version_id });
    }

    // Step 3: Get presigned URLs
    let uploads = prep
        .uploads
        .ok_or_else(|| AgentError::Checkpoint("No upload URLs in prepare response".into()))?;
    let archive_url = uploads.archive.presigned_url;
    let manifest_url = uploads.manifest.presigned_url;

    // Step 4: Create archive + manifest in temp dir
    let temp_dir = tempfile::tempdir().map_err(AgentError::Io)?;
    let archive_path = temp_dir.path().join("archive.tar.gz");
    let manifest_path = temp_dir.path().join("manifest.json");

    // Create archive (blocking)
    log_info!(LOG_TAG, "Creating archive...");
    let arc_start = std::time::Instant::now();
    let mp = mount_path.to_string();
    let ap = archive_path.clone();
    let archive_files = files.clone();
    let archive_result =
        tokio::task::spawn_blocking(move || create_archive(&mp, &ap, &archive_files))
            .await
            .map_err(|e| AgentError::Execution(format!("archive task panicked: {e}")))?;
    if let Err(e) = archive_result {
        log_error!(LOG_TAG, "Failed to create archive: {e}");
        record_sandbox_op("artifact_archive_create", arc_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Failed to create archive".into()));
    }
    record_sandbox_op("artifact_archive_create", arc_start.elapsed(), true, None);

    // Create manifest
    let manifest = json!({
        "version": 1,
        "files": files,
        "createdAt": guest_common::log::timestamp(),
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| AgentError::Checkpoint(e.to_string()))?,
    )
    .map_err(|e| AgentError::Checkpoint(format!("Failed to write manifest: {e}")))?;

    // Step 5: Upload to S3
    log_info!(LOG_TAG, "Uploading archive to S3...");
    let s3_start = std::time::Instant::now();
    if let Err(e) = http
        .put_presigned_file(&archive_url, &archive_path, "application/gzip")
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }

    log_info!(LOG_TAG, "Uploading manifest to S3...");
    let manifest_data = tokio::fs::read(&manifest_path).await?;
    if let Err(e) = http
        .put_presigned(&manifest_url, manifest_data.into(), "application/json")
        .await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }
    record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), true, None);

    // Step 6: Commit
    log_info!(LOG_TAG, "Calling commit endpoint...");
    let commit_start = std::time::Instant::now();
    let commit_payload = storage_commit::Request {
        run_id: run_id.to_string(),
        storage_name: storage_name.to_string(),
        storage_type: storage_type.to_string(),
        version_id: version_id.clone(),
        parent_version_id: non_empty_string(parent_version_id),
        files: to_commit_files(&files),
        message: Some(message.to_string()),
    };
    let resp = match http
        .post_json(
            urls::storage_commit_url(),
            &commit_payload,
            constants::HTTP_MAX_RETRIES,
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
            return Err(e);
        }
    };
    let commit_success = resp
        .map(|v| {
            serde_json::from_value::<storage_commit::Response>(v)
                .map(|commit| commit.success)
                .unwrap_or_else(|e| {
                    log_warn!(LOG_TAG, "Failed to parse commit response: {e}");
                    false
                })
        })
        .unwrap_or(false);

    if !commit_success {
        record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Commit failed".into()));
    }

    record_sandbox_op("artifact_commit_api", commit_start.elapsed(), true, None);
    let short_id = version_id.get(..8).unwrap_or(&version_id);
    log_info!(LOG_TAG, "Direct upload snapshot created: {short_id}");

    Ok(SnapshotResult { version_id })
}

/// Walk directory and compute SHA-256 for each file, skipping `.git` and `.vm0`.
#[cfg(unix)]
pub(crate) fn collect_file_metadata(dir_path: &str) -> Vec<FileEntry> {
    let mut files = Vec::new();
    let root = match open_archive_dir(Path::new(dir_path)) {
        Ok(root) => root,
        Err(e) => {
            log_warn!(LOG_TAG, "Could not read artifact root {dir_path}: {e}");
            return files;
        }
    };
    walk_dir(&root, "", &mut files);
    files
}

#[cfg(not(unix))]
pub(crate) fn collect_file_metadata(dir_path: &str) -> Vec<FileEntry> {
    log_warn!(
        LOG_TAG,
        "Artifact metadata collection requires Unix no-follow path opening: {dir_path}"
    );
    Vec::new()
}

#[cfg(unix)]
fn walk_dir(current: &File, relative: &str, out: &mut Vec<FileEntry>) {
    let entries = match read_dir_fd(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == ".vm0" {
            continue;
        }

        let rel = if relative.is_empty() {
            name_str.to_string()
        } else {
            format!("{relative}/{name_str}")
        };

        if let Ok(dir) = open_archive_child_dir(current, &name) {
            walk_dir(&dir, &rel, out);
            continue;
        }

        let Ok(file) = open_archive_child_file(current, &name) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        match compute_file_hash_from_reader(file) {
            Ok((hash, size)) => out.push(FileEntry {
                path: rel,
                hash,
                size,
            }),
            Err(e) => {
                log_warn!(LOG_TAG, "Could not process file {rel}: {e}");
            }
        }
    }
}

#[cfg(test)]
fn compute_file_hash(path: &Path) -> Result<(String, u64), std::io::Error> {
    compute_file_hash_from_reader(std::fs::File::open(path)?)
}

fn compute_file_hash_from_reader(mut reader: impl Read) -> Result<(String, u64), std::io::Error> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let Some(chunk) = buf.get(..n) else { break };
        hasher.update(chunk);
        total += n as u64;
    }
    let hash = hex::encode(hasher.finalize());
    Ok((hash, total))
}

#[derive(Debug, Error)]
enum ArchiveError {
    #[error("failed to create archive output {}: {source}", path.display())]
    CreateOutput { path: PathBuf, source: io::Error },
    #[error("invalid archive path {path:?}: path must be relative and stay within the artifact")]
    InvalidPath { path: String },
    #[error("failed to read metadata for {path:?}: {source}")]
    Metadata { path: String, source: io::Error },
    #[error("archive path {path:?} is not a regular file")]
    NonRegular { path: String },
    #[error(
        "archive file {path:?} size changed after manifest collection: expected {expected}, got {actual}"
    )]
    SizeChanged {
        path: String,
        expected: u64,
        actual: u64,
    },
    #[error(
        "archive file {path:?} content changed after manifest collection: expected sha256 {expected}, got {actual}"
    )]
    HashMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("failed to open {path:?}: {source}")]
    Open { path: String, source: io::Error },
    #[error("failed to append {path:?} to archive: {source}")]
    Append { path: String, source: io::Error },
    #[error("failed to verify archived content for {path:?}: {source}")]
    Verify { path: String, source: io::Error },
    #[error("failed to finish tar archive: {source}")]
    FinishTar { source: io::Error },
    #[error("failed to finish gzip stream: {source}")]
    FinishGzip { source: io::Error },
}

/// Create a tar.gz archive containing only the listed manifest files.
///
/// This ensures the archive matches the manifest exactly — no symlinks or other
/// entries that `walk_dir` skipped will be included, and files that changed
/// after manifest collection fail the snapshot instead of producing a mismatched
/// archive.
fn create_archive(
    dir_path: &str,
    tar_path: &Path,
    files: &[FileEntry],
) -> Result<(), ArchiveError> {
    let output = File::create(tar_path).map_err(|source| ArchiveError::CreateOutput {
        path: tar_path.to_owned(),
        source,
    })?;
    let encoder = GzEncoder::new(output, Compression::default());
    let mut builder = tar::Builder::new(encoder);
    let root = Path::new(dir_path);

    for file in files {
        append_archive_file(root, &mut builder, file)?;
    }

    let encoder = builder
        .into_inner()
        .map_err(|source| ArchiveError::FinishTar { source })?;
    encoder
        .finish()
        .map_err(|source| ArchiveError::FinishGzip { source })?;
    Ok(())
}

fn validate_archive_inputs(dir_path: &str, files: &[FileEntry]) -> Result<(), ArchiveError> {
    let root = Path::new(dir_path);
    for file in files {
        validate_archive_file(root, file)?;
    }
    Ok(())
}

fn validate_archive_file(root: &Path, entry: &FileEntry) -> Result<(), ArchiveError> {
    let (file, _) = open_manifest_file(root, entry)?;
    let mut reader = ArchiveFileReader::new(file, entry.size);
    io::copy(&mut reader, &mut io::sink()).map_err(|source| ArchiveError::Verify {
        path: entry.path.clone(),
        source,
    })?;
    let actual_hash = reader
        .finish_hash()
        .map_err(|source| ArchiveError::Verify {
            path: entry.path.clone(),
            source,
        })?;
    if actual_hash != entry.hash {
        return Err(ArchiveError::HashMismatch {
            path: entry.path.clone(),
            expected: entry.hash.clone(),
            actual: actual_hash,
        });
    }
    Ok(())
}

fn append_archive_file<W: io::Write>(
    root: &Path,
    builder: &mut tar::Builder<W>,
    entry: &FileEntry,
) -> Result<(), ArchiveError> {
    let (file, metadata) = open_manifest_file(root, entry)?;

    let mut header = tar::Header::new_gnu();
    header.set_metadata(&metadata);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_mode(archive_mode(&metadata));
    header.set_size(entry.size);
    header.set_cksum();
    let mut reader = ArchiveFileReader::new(file, entry.size);
    builder
        .append_data(&mut header, Path::new(entry.path.as_str()), &mut reader)
        .map_err(|source| ArchiveError::Append {
            path: entry.path.clone(),
            source,
        })?;
    let actual_hash = reader
        .finish_hash()
        .map_err(|source| ArchiveError::Verify {
            path: entry.path.clone(),
            source,
        })?;
    if actual_hash != entry.hash {
        return Err(ArchiveError::HashMismatch {
            path: entry.path.clone(),
            expected: entry.hash.clone(),
            actual: actual_hash,
        });
    }
    Ok(())
}

fn open_manifest_file(root: &Path, entry: &FileEntry) -> Result<(File, Metadata), ArchiveError> {
    let file_path = entry.path.as_str();
    let rel_path = archive_relative_path(file_path)?;
    let full_path = root.join(rel_path);

    let metadata = fs::symlink_metadata(&full_path).map_err(|source| ArchiveError::Metadata {
        path: file_path.to_string(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(ArchiveError::NonRegular {
            path: file_path.to_string(),
        });
    }

    let file = open_archive_file(root, rel_path).map_err(|source| ArchiveError::Open {
        path: file_path.to_string(),
        source,
    })?;
    let metadata = file.metadata().map_err(|source| ArchiveError::Metadata {
        path: file_path.to_string(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(ArchiveError::NonRegular {
            path: file_path.to_string(),
        });
    }
    if metadata.len() != entry.size {
        return Err(ArchiveError::SizeChanged {
            path: file_path.to_string(),
            expected: entry.size,
            actual: metadata.len(),
        });
    }

    Ok((file, metadata))
}

fn archive_relative_path(path: &str) -> Result<&Path, ArchiveError> {
    let rel_path = Path::new(path);
    if rel_path.as_os_str().is_empty()
        || rel_path.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_)
                    | Component::RootDir
                    | Component::CurDir
                    | Component::ParentDir
            )
        })
    {
        return Err(ArchiveError::InvalidPath {
            path: path.to_string(),
        });
    }
    Ok(rel_path)
}

#[cfg(unix)]
fn archive_mode(metadata: &Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o7777
}

struct ArchiveFileReader<R> {
    inner: R,
    remaining: u64,
    hasher: Sha256,
}

impl<R> ArchiveFileReader<R> {
    fn new(inner: R, size: u64) -> Self {
        Self {
            inner,
            remaining: size,
            hasher: Sha256::new(),
        }
    }

    fn finish_hash(mut self) -> io::Result<String>
    where
        R: Read,
    {
        if self.remaining != 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file ended before manifest size was fully archived",
            ));
        }

        let mut extra = [0u8; 1];
        if self.inner.read(&mut extra)? != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "file grew after manifest size was verified",
            ));
        }

        Ok(hex::encode(self.hasher.finalize()))
    }
}

impl<R: Read> Read for ArchiveFileReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }

        let limit = self.remaining.min(buf.len() as u64) as usize;
        let read_buf = buf
            .get_mut(..limit)
            .ok_or_else(|| io::Error::other("archive read buffer limit is out of range"))?;
        let n = self.inner.read(read_buf)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file ended before manifest size was fully archived",
            ));
        }
        let hashed = buf
            .get(..n)
            .ok_or_else(|| io::Error::other("archive read size is out of range"))?;
        self.hasher.update(hashed);
        self.remaining -= n as u64;
        Ok(n)
    }
}

#[cfg(not(unix))]
fn archive_mode(metadata: &Metadata) -> u32 {
    if metadata.permissions().readonly() {
        0o444
    } else {
        0o644
    }
}

#[cfg(unix)]
fn read_dir_fd(dir: &File) -> io::Result<fs::ReadDir> {
    use std::os::fd::AsRawFd;

    fs::read_dir(PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd())))
}

#[cfg(unix)]
fn open_archive_dir(path: &Path) -> io::Result<File> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(unix)]
fn open_archive_child_dir(parent: &File, name: &std::ffi::OsStr) -> io::Result<File> {
    open_archive_child(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
}

#[cfg(unix)]
fn open_archive_child_file(parent: &File, name: &std::ffi::OsStr) -> io::Result<File> {
    open_archive_child(
        parent,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )
}

#[cfg(unix)]
fn open_archive_child(parent: &File, name: &std::ffi::OsStr, flags: i32) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name = CString::new(name.as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn open_archive_file(root: &Path, rel_path: &Path) -> io::Result<File> {
    let mut dir = open_archive_dir(root)?;
    let mut components = rel_path.components().peekable();

    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "archive path contains non-normal component",
            ));
        };
        let is_last = components.peek().is_none();
        if is_last {
            return open_archive_child_file(&dir, name);
        } else {
            dir = open_archive_child_dir(&dir, name)?;
        }
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "archive path is empty",
    ))
}

#[cfg(not(unix))]
fn open_archive_file(_root: &Path, _rel_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "artifact archive creation requires Unix no-follow path opening",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::io::Cursor;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs as unix_fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::sync::LazyLock;

    fn extract_archive(tar_path: &Path, extract_dir: &Path) -> io::Result<()> {
        let file = File::open(tar_path)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive.unpack(extract_dir)
    }

    fn make_fifo(path: &Path) -> io::Result<()> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let rc = unsafe { libc::mkfifo(path.as_ptr(), 0o644) };
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    static SNAPSHOT_MOCK_SERVER: LazyLock<httpmock::MockServer> = LazyLock::new(|| {
        let server = httpmock::MockServer::start();
        unsafe {
            std::env::set_var("VM0_API_URL", server.base_url());
        }
        server
    });

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    #[test]
    fn walk_dir_skips_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular file
        std::fs::write(root.join("real.txt"), "hello").unwrap();

        // Symlink to file
        unix_fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();

        // Symlink to directory outside
        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/inner.txt"), "inner").unwrap();
        unix_fs::symlink(root.join("subdir"), root.join("link_dir")).unwrap();

        // Dangling symlink
        unix_fs::symlink("/nonexistent", root.join("dangling")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        // Regular files should be included
        assert!(paths.contains(&"real.txt"));
        assert!(paths.contains(&"subdir/inner.txt"));

        // Symlinks should NOT be included
        assert!(!paths.contains(&"link.txt"));
        assert!(!paths.contains(&"link_dir"));
        assert!(!paths.contains(&"dangling"));

        // link_dir contents should NOT appear (symlink dir skipped, not followed)
        assert!(!paths.iter().any(|p| p.starts_with("link_dir/")));
    }

    #[test]
    fn walk_dir_does_not_follow_directory_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("real.txt"), "real").unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        unix_fs::symlink(&outside, root.join("link_dir")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"real.txt"));
        assert!(!paths.contains(&"link_dir/secret.txt"));
        assert!(!paths.iter().any(|p| p.starts_with("link_dir/")));
    }

    #[test]
    fn walk_dir_skips_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("real.txt"), "hello").unwrap();
        make_fifo(&root.join("pipe")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"real.txt"));
        assert!(!paths.contains(&"pipe"));
    }

    #[test]
    fn walk_dir_handles_hardlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("original.txt"), "content").unwrap();
        std::fs::hard_link(root.join("original.txt"), root.join("hardlink.txt")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        // Both original and hardlink should be recorded as independent files
        assert!(paths.contains(&"original.txt"));
        assert!(paths.contains(&"hardlink.txt"));

        // Both should have the same hash
        let original = files.iter().find(|f| f.path == "original.txt").unwrap();
        let hardlink = files.iter().find(|f| f.path == "hardlink.txt").unwrap();
        assert_eq!(original.hash, hardlink.hash);
        assert_eq!(original.size, hardlink.size);
    }

    #[test]
    fn archive_excludes_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular files
        std::fs::write(root.join("real.txt"), "hello").unwrap();
        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/inner.txt"), "inner").unwrap();

        // Symlinks (should NOT end up in the archive)
        unix_fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        unix_fs::symlink("/nonexistent", root.join("dangling")).unwrap();

        // Collect metadata (skips symlinks)
        let files = collect_file_metadata(root.to_str().unwrap());

        // Create archive using only manifest file list
        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        // Extract and verify archive contents match manifest exactly
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();

        // Manifest files should exist
        assert!(extract_dir.join("real.txt").exists());
        assert!(extract_dir.join("subdir/inner.txt").exists());

        // Symlinks should NOT exist in the archive
        assert!(!extract_dir.join("link.txt").exists());
        assert!(!extract_dir.join("dangling").exists());
    }

    #[test]
    fn archive_handles_special_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Files with spaces and special characters
        std::fs::write(root.join("file with spaces.txt"), "spaces").unwrap();
        std::fs::create_dir(root.join("dir with spaces")).unwrap();
        std::fs::write(root.join("dir with spaces/inner.txt"), "inner").unwrap();
        std::fs::write(root.join("file-with-dashes.txt"), "dashes").unwrap();
        // File with newline in name
        std::fs::write(root.join("line1\nline2.txt"), "newline").unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());

        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        // Extract and verify
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();

        assert!(extract_dir.join("file with spaces.txt").exists());
        assert!(extract_dir.join("dir with spaces/inner.txt").exists());
        assert!(extract_dir.join("file-with-dashes.txt").exists());
        assert!(extract_dir.join("line1\nline2.txt").exists());
    }

    #[test]
    fn archive_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("empty.tar.gz");
        assert!(create_archive("/tmp", &tar_path, &[]).is_ok());
        assert!(tar_path.exists());

        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();
        assert!(std::fs::read_dir(&extract_dir).unwrap().next().is_none());
    }

    #[test]
    fn archive_hardlinks_as_independent_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("original.txt"), "content").unwrap();
        std::fs::hard_link(root.join("original.txt"), root.join("hardlink.txt")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());

        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        extract_archive(&tar_path, &extract_dir).unwrap();

        let original = extract_dir.join("original.txt");
        let hardlink = extract_dir.join("hardlink.txt");
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "content");
        assert_eq!(std::fs::read_to_string(&hardlink).unwrap(), "content");
        assert_ne!(
            std::fs::metadata(&original).unwrap().ino(),
            std::fs::metadata(&hardlink).unwrap().ino()
        );
    }

    #[test]
    fn archive_preserves_executable_mode_in_header() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let script = root.join("script.sh");

        std::fs::write(&script, "echo ok\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(root.to_str().unwrap(), &tar_path, &files).is_ok());

        let file = File::open(&tar_path).unwrap();
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let mut entries = archive.entries().unwrap();
        let entry = entries.next().unwrap().unwrap();

        assert_eq!(entry.path().unwrap().as_ref(), Path::new("script.sh"));
        assert_eq!(entry.header().mode().unwrap() & 0o7777, 0o755);
    }

    #[test]
    fn archive_fails_if_listed_file_size_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        std::fs::write(root.join("target.txt"), "after-size-change").unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("size changed"), "got: {msg}");
    }

    #[test]
    fn archive_fails_if_listed_file_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        std::fs::write(root.join("target.txt"), "after!").unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("content changed"), "got: {msg}");
    }

    #[test]
    fn archive_reader_rejects_extra_bytes_after_declared_size() {
        let mut reader = ArchiveFileReader::new(Cursor::new(b"abcdef".as_slice()), 3);
        let mut archived = Vec::new();

        io::copy(&mut reader, &mut archived).unwrap();
        let err = reader.finish_hash().unwrap_err();

        assert_eq!(archived, b"abc");
        assert!(err.to_string().contains("file grew"), "got: {err}");
    }

    #[test]
    fn validate_archive_inputs_fails_if_listed_file_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        std::fs::write(root.join("target.txt"), "after!").unwrap();

        let err = validate_archive_inputs(root.to_str().unwrap(), &files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("content changed"), "got: {msg}");
    }

    #[test]
    fn validate_archive_inputs_fails_if_listed_file_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        std::fs::write(root.join("outside.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        let archive_files: Vec<FileEntry> = files
            .iter()
            .filter(|f| f.path == "target.txt")
            .cloned()
            .collect();

        std::fs::remove_file(root.join("target.txt")).unwrap();
        unix_fs::symlink(root.join("outside.txt"), root.join("target.txt")).unwrap();

        let err = validate_archive_inputs(root.to_str().unwrap(), &archive_files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("not a regular file"), "got: {msg}");
    }

    #[test]
    fn validate_archive_inputs_fails_if_listed_file_becomes_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        let archive_files: Vec<FileEntry> = files
            .iter()
            .filter(|f| f.path == "target.txt")
            .cloned()
            .collect();

        std::fs::remove_file(root.join("target.txt")).unwrap();
        make_fifo(&root.join("target.txt")).unwrap();

        let err = validate_archive_inputs(root.to_str().unwrap(), &archive_files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("not a regular file"), "got: {msg}");
    }

    #[test]
    fn archive_rejects_invalid_manifest_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let tar_path = root.join("archive.tar.gz");

        for path in [
            "",
            "/absolute.txt",
            ".",
            "./relative.txt",
            "dir/../file.txt",
        ] {
            let files = vec![FileEntry {
                path: path.to_string(),
                hash: "unused".to_string(),
                size: 0,
            }];
            let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();
            assert!(
                err.to_string().contains("invalid archive path"),
                "path {path:?} produced: {err}"
            );
        }
    }

    #[test]
    fn archive_rejects_manifest_path_with_nul() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("bad"), "data").unwrap();
        let tar_path = root.join("archive.tar.gz");
        let files = vec![FileEntry {
            path: "bad\0name".to_string(),
            hash: "unused".to_string(),
            size: 0,
        }];

        let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();

        assert!(
            err.to_string().to_ascii_lowercase().contains("nul"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn dedup_snapshot_validation_failure_does_not_commit() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        std::fs::write(root.join("target.txt"), "after!").unwrap();

        let server = &*SNAPSHOT_MOCK_SERVER;

        let prepare = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/storages/prepare");
            then.status(200).json_body(serde_json::json!({
                "versionId": "v-existing",
                "existing": true
            }));
        });
        let commit = server.mock(|when, then| {
            when.method(httpmock::Method::POST)
                .path("/api/webhooks/agent/storages/commit");
            then.status(200)
                .json_body(serde_json::json!({ "success": true }));
        });

        let http = HttpClient::new().unwrap();
        let result = create_snapshot(
            &http,
            CreateSnapshotRequest {
                mount_path: root.to_str().unwrap(),
                files,
                storage_name: "storage",
                storage_type: "artifact",
                run_id: "run-id",
                message: "message",
                parent_version_id: "",
            },
        )
        .await;

        let Err(err) = result else {
            panic!("create_snapshot unexpectedly succeeded");
        };
        assert!(
            err.to_string()
                .contains("Failed to validate archive inputs")
        );
        prepare.assert_calls(1);
        commit.assert_calls(0);
    }

    #[test]
    fn archive_fails_if_listed_file_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        std::fs::write(root.join("outside.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        let archive_files: Vec<FileEntry> = files
            .iter()
            .filter(|f| f.path == "target.txt")
            .cloned()
            .collect();
        let paths: Vec<&str> = archive_files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["target.txt"]);

        std::fs::remove_file(root.join("target.txt")).unwrap();
        unix_fs::symlink(root.join("outside.txt"), root.join("target.txt")).unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        let err = create_archive(root.to_str().unwrap(), &tar_path, &archive_files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("not a regular file"), "got: {msg}");
    }

    #[test]
    fn archive_fails_if_listed_file_becomes_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        let archive_files: Vec<FileEntry> = files
            .iter()
            .filter(|f| f.path == "target.txt")
            .cloned()
            .collect();
        let paths: Vec<&str> = archive_files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["target.txt"]);

        std::fs::remove_file(root.join("target.txt")).unwrap();
        make_fifo(&root.join("target.txt")).unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        let err = create_archive(root.to_str().unwrap(), &tar_path, &archive_files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("target.txt"), "got: {msg}");
        assert!(msg.contains("not a regular file"), "got: {msg}");
    }

    #[test]
    fn archive_fails_if_parent_dir_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/file.txt"), "before").unwrap();
        std::fs::create_dir(root.join("outside")).unwrap();
        std::fs::write(root.join("outside/file.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        let archive_files: Vec<FileEntry> = files
            .iter()
            .filter(|f| f.path == "subdir/file.txt")
            .cloned()
            .collect();
        let paths: Vec<&str> = archive_files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["subdir/file.txt"]);

        std::fs::remove_dir_all(root.join("subdir")).unwrap();
        unix_fs::symlink(root.join("outside"), root.join("subdir")).unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        let err = create_archive(root.to_str().unwrap(), &tar_path, &archive_files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("subdir/file.txt"), "got: {msg}");
        assert!(msg.contains("failed to open"), "got: {msg}");
    }

    #[test]
    fn archive_fails_if_listed_file_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("gone.txt"), "data").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["gone.txt"]);

        std::fs::remove_file(root.join("gone.txt")).unwrap();

        let tar_path = dir.path().join("archive.tar.gz");
        let err = create_archive(root.to_str().unwrap(), &tar_path, &files).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("gone.txt"), "got: {msg}");
        assert!(msg.contains("metadata"), "got: {msg}");
    }

    #[test]
    fn collect_file_metadata_excludes_git_and_vm0() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular file
        std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();

        // .git directory (should be excluded)
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        std::fs::create_dir(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/objects/pack"), "data").unwrap();

        // .vm0 directory (should be excluded)
        std::fs::create_dir(root.join(".vm0")).unwrap();
        std::fs::write(root.join(".vm0/config.json"), "{}").unwrap();

        // Nested directory with a .git-like name (should NOT be excluded)
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn hello() {}").unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"main.rs"));
        assert!(paths.contains(&"src/lib.rs"));

        // .git and .vm0 contents must NOT be present
        assert!(!paths.iter().any(|p| p.starts_with(".git")));
        assert!(!paths.iter().any(|p| p.starts_with(".vm0")));
    }

    #[test]
    fn compute_file_hash_known_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello world").unwrap();

        let (hash, size) = compute_file_hash(&path).unwrap();
        assert_eq!(size, 11);
        // SHA-256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn compute_file_hash_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        std::fs::write(&path, "").unwrap();

        let (hash, size) = compute_file_hash(&path).unwrap();
        assert_eq!(size, 0);
        // SHA-256 of empty string
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn collect_file_metadata_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let files = collect_file_metadata(dir.path().to_str().unwrap());
        assert!(files.is_empty());
    }

    #[test]
    fn collect_file_metadata_nonexistent_dir() {
        disable_system_log();
        let files = collect_file_metadata("/nonexistent/path/that/does/not/exist");
        assert!(files.is_empty());
    }
}
