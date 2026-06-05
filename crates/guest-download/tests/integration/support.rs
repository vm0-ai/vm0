use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) enum TarEntry<'a> {
    File(&'a str, &'a [u8]),
    Symlink(&'a str, &'a str),
    Hardlink(&'a str, &'a str),
    /// Hand-crafted entry for malicious-input tests that `tar::Builder`
    /// rejects (absolute paths, `..` components, empty linkname). Always
    /// written after all non-Raw entries in the archive.
    Raw {
        path: &'a [u8],
        /// Typeflag byte: `b'0'` regular file, `b'2'` symlink.
        entry_type: u8,
        /// Octal mode string like `b"0000644\0"`.
        mode: &'a [u8; 8],
        /// Empty = no data block appended (size stays zero).
        content: &'a [u8],
    },
}

/// Create a tar.gz archive in memory containing the given files.
pub(crate) fn create_tar_gz(files: &[(&str, &[u8])]) -> std::io::Result<Vec<u8>> {
    let entries: Vec<TarEntry> = files.iter().map(|(p, c)| TarEntry::File(p, c)).collect();
    create_tar_gz_entries(&entries)
}

/// Create a tar.gz archive with mixed file and symlink entries.
pub(crate) fn create_tar_gz_entries(entries: &[TarEntry]) -> std::io::Result<Vec<u8>> {
    /// Strip builder-written EOF, splice hand-crafted tar headers onto the
    /// end, and re-add EOF. Scoped as an inner fn so the indexing-slicing
    /// allow (needed because `allow-indexing-slicing-in-tests` only matches
    /// `#[test]` fns, not helper fns) stays off the rest of the helper.
    #[allow(clippy::indexing_slicing)]
    fn append_raw_entries(tar_data: &mut Vec<u8>, entries: &[TarEntry]) {
        while tar_data.len() >= 512 && tar_data[tar_data.len() - 512..].iter().all(|&b| b == 0) {
            tar_data.truncate(tar_data.len() - 512);
        }
        for entry in entries {
            if let TarEntry::Raw {
                path,
                entry_type,
                mode,
                content,
            } = entry
            {
                let mut header_block = [0u8; 512];
                header_block[..path.len()].copy_from_slice(path);
                header_block[100..108].copy_from_slice(*mode);
                header_block[108..116].copy_from_slice(b"0000000\0"); // uid
                header_block[116..124].copy_from_slice(b"0000000\0"); // gid
                let size_str = format!("{:011o}\0", content.len());
                header_block[124..136].copy_from_slice(size_str.as_bytes());
                header_block[136..148].copy_from_slice(b"00000000000\0"); // mtime
                header_block[156] = *entry_type;
                header_block[257..263].copy_from_slice(b"ustar\0");
                header_block[263..265].copy_from_slice(b"00");
                // Checksum: field filled with spaces, sum all bytes, write result.
                header_block[148..156].copy_from_slice(b"        ");
                let cksum: u32 = header_block.iter().map(|&b| b as u32).sum();
                let cksum_str = format!("{:06o}\0 ", cksum);
                header_block[148..156].copy_from_slice(cksum_str.as_bytes());

                tar_data.extend_from_slice(&header_block);
                if !content.is_empty() {
                    let mut data_block = [0u8; 512];
                    data_block[..content.len()].copy_from_slice(content);
                    tar_data.extend_from_slice(&data_block);
                }
            }
        }
        tar_data.extend_from_slice(&[0u8; 1024]); // EOF
    }

    let mut tar_data = Vec::new();
    let has_raw = entries.iter().any(|e| matches!(e, TarEntry::Raw { .. }));
    {
        let mut builder = tar::Builder::new(&mut tar_data);
        for entry in entries {
            match entry {
                TarEntry::File(path, contents) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(contents.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    builder.append_data(&mut header, path, *contents)?;
                }
                TarEntry::Symlink(path, target) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_cksum();
                    builder.append_link(&mut header, path, target)?;
                }
                TarEntry::Hardlink(path, target) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o644);
                    header.set_entry_type(tar::EntryType::Link);
                    header.set_cksum();
                    builder.append_link(&mut header, path, target)?;
                }
                TarEntry::Raw { .. } => {} // appended after builder finishes
            }
        }
        builder.finish()?;
    }

    if has_raw {
        append_raw_entries(&mut tar_data, entries);
    }

    let mut gz_data = Vec::new();
    let mut encoder = GzEncoder::new(&mut gz_data, Compression::fast());
    encoder.write_all(&tar_data)?;
    encoder.finish()?;
    Ok(gz_data)
}

/// Write a manifest JSON to a temp file and return its path.
/// `storages`: list of (mount_path, archive_url) pairs.
/// `artifact`: optional (mount_path, archive_url) pair.
pub(crate) fn write_manifest(
    dir: &TempDir,
    storages: &[(&str, Option<&str>)],
    artifact: Option<(&str, Option<&str>)>,
) -> std::io::Result<PathBuf> {
    let storages_json: Vec<String> = storages
        .iter()
        .map(|(mount_path, archive_url)| match archive_url {
            Some(url) => format!(r#"{{"mountPath":"{}","archiveUrl":"{}"}}"#, mount_path, url),
            None => format!(r#"{{"mountPath":"{}"}}"#, mount_path),
        })
        .collect();

    let artifact_json = artifact.map(|(mount_path, archive_url)| match archive_url {
        Some(url) => format!(
            r#","artifacts":[{{"mountPath":"{}","archiveUrl":"{}"}}]"#,
            mount_path, url
        ),
        None => format!(r#","artifacts":[{{"mountPath":"{}"}}]"#, mount_path),
    });

    let json = format!(
        r#"{{"storages":[{}]{}}}"#,
        storages_json.join(","),
        artifact_json.unwrap_or_default(),
    );

    let manifest_path = dir.path().join("manifest.json");
    std::fs::write(&manifest_path, json)?;
    Ok(manifest_path)
}

pub(crate) fn run_guest_download(manifest_path: &str) -> bool {
    guest_common::log::clear_system_log_file();
    guest_download::run(manifest_path)
}

pub(crate) fn assert_does_not_contain_any(haystack_name: &str, haystack: &str, forbidden: &[&str]) {
    for needle in forbidden {
        assert!(
            !haystack.contains(needle),
            "{haystack_name} should not contain {needle:?}: {haystack}"
        );
    }
}

pub(crate) fn unique_run_id(test_name: &str) -> String {
    format!(
        "guest-download-{test_name}-{}-{}",
        std::process::id(),
        RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) struct RunFileCleanup {
    paths: Vec<String>,
}

impl RunFileCleanup {
    pub(crate) fn new(paths: Vec<String>) -> Self {
        for path in &paths {
            let _ = std::fs::remove_file(path);
        }
        Self { paths }
    }
}

impl Drop for RunFileCleanup {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
