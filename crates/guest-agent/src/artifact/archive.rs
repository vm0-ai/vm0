use super::FileEntry;
#[cfg(target_os = "linux")]
use crate::nofollow_fs::Dir;
use flate2::Compression;
use flate2::write::GzEncoder;
use guest_common::log_warn;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

const LOG_TAG: &str = "sandbox:guest-agent";

/// Walk directory and compute SHA-256 for each file, skipping `.git` and `.vm0`.
#[cfg(target_os = "linux")]
pub(super) fn collect_file_metadata(dir_path: &str) -> Result<Vec<FileEntry>, ArchiveError> {
    let mut files = Vec::new();
    let root_path = Path::new(dir_path);
    let root = open_artifact_root(root_path)?;
    let entries = read_artifact_root(&root, root_path)?;
    walk_entries(&root, "", entries, &mut files);
    Ok(files)
}

#[cfg(not(target_os = "linux"))]
pub(super) fn collect_file_metadata(dir_path: &str) -> Result<Vec<FileEntry>, ArchiveError> {
    Err(ArchiveError::UnsupportedRoot {
        path: PathBuf::from(dir_path),
    })
}

#[cfg(target_os = "linux")]
fn walk_dir(current: &Dir, relative: &str, out: &mut Vec<FileEntry>) {
    let entries = match current.read_dir() {
        Ok(e) => e,
        Err(_) => return,
    };
    walk_entries(current, relative, entries, out);
}

#[cfg(target_os = "linux")]
fn walk_entries(current: &Dir, relative: &str, entries: fs::ReadDir, out: &mut Vec<FileEntry>) {
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

        if let Ok(dir) = current.open_child_dir(&name) {
            walk_dir(&dir, &rel, out);
            continue;
        }

        let Ok(file) = current.open_child_file(&name) else {
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
pub(super) enum ArchiveError {
    #[error("failed to open artifact root {}: {source}", path.display())]
    RootOpen { path: PathBuf, source: io::Error },
    #[error("failed to read artifact root {}: {source}", path.display())]
    RootRead { path: PathBuf, source: io::Error },
    #[cfg(not(target_os = "linux"))]
    #[error(
        "artifact root access requires Linux no-follow path opening: {}",
        path.display()
    )]
    UnsupportedRoot { path: PathBuf },
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

impl ArchiveError {
    pub(super) fn is_root_not_found(&self) -> bool {
        matches!(
            self,
            Self::RootOpen { source, .. } | Self::RootRead { source, .. }
                if source.kind() == io::ErrorKind::NotFound
        )
    }
}

/// Create a tar.gz archive containing only the listed manifest files.
///
/// This ensures the archive matches the manifest exactly — no symlinks or other
/// entries that `walk_dir` skipped will be included, and files that changed
/// after manifest collection fail the snapshot instead of producing a mismatched
/// archive.
pub(super) fn create_archive(
    dir_path: &str,
    tar_path: &Path,
    files: &[FileEntry],
) -> Result<(), ArchiveError> {
    let root = Path::new(dir_path);
    if files.is_empty() {
        ensure_readable_artifact_root(root)?;
    }

    let output = File::create(tar_path).map_err(|source| ArchiveError::CreateOutput {
        path: tar_path.to_owned(),
        source,
    })?;
    let encoder = GzEncoder::new(output, Compression::default());
    let mut builder = tar::Builder::new(encoder);

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

/// Validate archive inputs for a deduplicated snapshot.
///
/// This is the deduplicated-snapshot counterpart to [`create_archive`]. When
/// `/storages/prepare` reports an existing version, callers must run this before
/// committing that version as HEAD because the deduplicated path does not build
/// an archive.
///
/// The check reopens each listed file through the same Linux no-follow
/// root/child path opening used for archive creation, then verifies that
/// manifest paths are still non-empty relative paths with no root, prefix, `.`,
/// or `..` components, entries are still regular files, and file size plus
/// SHA-256 still match the pre-walked manifest.
/// Empty manifests still validate readable artifact-root access through the
/// no-follow root-opening path.
///
/// This validates the current artifact state before commit; it does not freeze
/// the filesystem after validation returns.
pub(super) fn validate_archive_inputs(
    dir_path: &str,
    files: &[FileEntry],
) -> Result<(), ArchiveError> {
    let root = Path::new(dir_path);
    if files.is_empty() {
        ensure_readable_artifact_root(root)?;
    }

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

#[cfg(target_os = "linux")]
fn ensure_readable_artifact_root(root: &Path) -> Result<(), ArchiveError> {
    let dir = open_artifact_root(root)?;
    read_artifact_root(&dir, root)?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn ensure_readable_artifact_root(root: &Path) -> Result<(), ArchiveError> {
    Err(ArchiveError::UnsupportedRoot {
        path: root.to_owned(),
    })
}

#[cfg(target_os = "linux")]
fn open_artifact_root(root: &Path) -> Result<Dir, ArchiveError> {
    Dir::open(root).map_err(|source| ArchiveError::RootOpen {
        path: root.to_owned(),
        source,
    })
}

#[cfg(target_os = "linux")]
fn read_artifact_root(root: &Dir, path: &Path) -> Result<fs::ReadDir, ArchiveError> {
    root.read_dir().map_err(|source| ArchiveError::RootRead {
        path: path.to_owned(),
        source,
    })
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

#[cfg(target_os = "linux")]
fn open_archive_file(root: &Path, rel_path: &Path) -> io::Result<File> {
    let mut dir = Dir::open(root)?;
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
            return dir.open_child_file(name);
        } else {
            dir = dir.open_child_dir(name)?;
        }
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "archive path is empty",
    ))
}

#[cfg(not(target_os = "linux"))]
fn open_archive_file(_root: &Path, _rel_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "artifact archive creation requires Linux no-follow path opening",
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::io::Cursor;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs as unix_fs;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

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

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    fn select_manifest_entries(files: &[FileEntry], expected_paths: &[&str]) -> Vec<FileEntry> {
        let selected: Vec<FileEntry> = expected_paths
            .iter()
            .filter_map(|expected_path| {
                files
                    .iter()
                    .find(|file| file.path == *expected_path)
                    .cloned()
            })
            .collect();
        let paths: Vec<&str> = selected.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, expected_paths);
        selected
    }

    fn assert_archive_inputs_rejected(
        root: &Path,
        files: &[FileEntry],
        expected_fragments: &[&str],
    ) -> io::Result<()> {
        let root_str = root.to_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "artifact root is not UTF-8")
        })?;
        let validate_err = match validate_archive_inputs(root_str, files) {
            Ok(()) => {
                return Err(io::Error::other(
                    "validate_archive_inputs unexpectedly succeeded",
                ));
            }
            Err(error) => error,
        };
        assert_error_contains(&validate_err, expected_fragments);

        let output_dir = tempfile::tempdir()?;
        let tar_path = output_dir.path().join("archive.tar.gz");
        let archive_err = match create_archive(root_str, &tar_path, files) {
            Ok(()) => return Err(io::Error::other("create_archive unexpectedly succeeded")),
            Err(error) => error,
        };
        assert_error_contains(&archive_err, expected_fragments);
        Ok(())
    }

    fn assert_error_contains(error: &ArchiveError, expected_fragments: &[&str]) {
        let msg = error.to_string();
        for fragment in expected_fragments {
            assert!(msg.contains(fragment), "got: {msg}");
        }
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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
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
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();

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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();

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
    fn archive_empty_files_requires_existing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let tar_path = dir.path().join("empty.tar.gz");

        let err = create_archive(missing.to_str().unwrap(), &tar_path, &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn archive_empty_files_rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir(&real).unwrap();
        unix_fs::symlink(&real, &link).unwrap();
        let tar_path = dir.path().join("empty.tar.gz");

        let err = create_archive(link.to_str().unwrap(), &tar_path, &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn validate_archive_inputs_empty_files_requires_existing_root() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");

        let err = validate_archive_inputs(missing.to_str().unwrap(), &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn validate_archive_inputs_empty_files_rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir(&real).unwrap();
        unix_fs::symlink(&real, &link).unwrap();

        let err = validate_archive_inputs(link.to_str().unwrap(), &[]).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn archive_hardlinks_as_independent_regular_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("original.txt"), "content").unwrap();
        std::fs::hard_link(root.join("original.txt"), root.join("hardlink.txt")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();

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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
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
    fn archive_inputs_fail_if_listed_file_size_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        std::fs::write(root.join("target.txt"), "after-size-change").unwrap();

        assert_archive_inputs_rejected(root, &files, &["target.txt", "size changed"]).unwrap();
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        std::fs::write(root.join("target.txt"), "after!").unwrap();

        assert_archive_inputs_rejected(root, &files, &["target.txt", "content changed"]).unwrap();
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
    fn archive_inputs_fail_if_listed_file_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        std::fs::write(root.join("outside.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["target.txt"]);

        std::fs::remove_file(root.join("target.txt")).unwrap();
        unix_fs::symlink(root.join("outside.txt"), root.join("target.txt")).unwrap();

        assert_archive_inputs_rejected(root, &archive_files, &["target.txt", "not a regular file"])
            .unwrap();
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_becomes_fifo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("target.txt"), "before").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["target.txt"]);

        std::fs::remove_file(root.join("target.txt")).unwrap();
        make_fifo(&root.join("target.txt")).unwrap();

        assert_archive_inputs_rejected(root, &archive_files, &["target.txt", "not a regular file"])
            .unwrap();
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

    #[test]
    fn archive_inputs_fail_if_parent_dir_becomes_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/file.txt"), "before").unwrap();
        std::fs::create_dir(root.join("outside")).unwrap();
        std::fs::write(root.join("outside/file.txt"), "outside").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["subdir/file.txt"]);

        std::fs::remove_dir_all(root.join("subdir")).unwrap();
        unix_fs::symlink(root.join("outside"), root.join("subdir")).unwrap();

        assert_archive_inputs_rejected(
            root,
            &archive_files,
            &["subdir/file.txt", "failed to open"],
        )
        .unwrap();
    }

    #[test]
    fn archive_inputs_fail_if_listed_file_disappears() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("gone.txt"), "data").unwrap();
        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
        let archive_files = select_manifest_entries(&files, &["gone.txt"]);

        std::fs::remove_file(root.join("gone.txt")).unwrap();

        assert_archive_inputs_rejected(root, &archive_files, &["gone.txt", "metadata"]).unwrap();
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

        let files = collect_file_metadata(root.to_str().unwrap()).unwrap();
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
        let files = collect_file_metadata(dir.path().to_str().unwrap()).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn collect_file_metadata_nonexistent_dir() {
        disable_system_log();
        let err = collect_file_metadata("/nonexistent/path/that/does/not/exist").unwrap_err();
        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }

    #[test]
    fn collect_file_metadata_rejects_symlink_root() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        std::fs::create_dir(&real).unwrap();
        unix_fs::symlink(&real, &link).unwrap();

        let err = collect_file_metadata(link.to_str().unwrap()).unwrap_err();

        assert!(
            err.to_string().contains("failed to open artifact root"),
            "got: {err}"
        );
    }
}
