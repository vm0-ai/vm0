use std::path::{Path, PathBuf};

use super::super::{
    R2Error, R2ImageCache,
    archive::{TEMPLATE_FILE, pack_to_writer, unpack_into_staging},
    download::{finalize_staging, staging_dir},
};
use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};

/// Build a mock `R2ImageCache` from a set of rules. Use `RuleMode::MatchAny`
/// (the issue's operations don't rely on ordered rule exhaustion; per-rule
/// `match_requests` filters disambiguate overlap when present).
pub(super) fn mock_cache(bucket: &str, rules: &[&Rule]) -> R2ImageCache {
    let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, rules);
    R2ImageCache::with_client(client, bucket.to_string())
}

pub(super) async fn wait_for_rule_calls(rule: &Rule, expected: usize) {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            if rule.num_calls() == expected {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {expected} mock call(s)"));
}

/// Write the rootfs file (the only file cached in R2) into `dir`.
pub(super) async fn write_mock_image_files(dir: &Path) -> Vec<PathBuf> {
    let rootfs = dir.join("rootfs.ext4");
    tokio::fs::write(&rootfs, b"rootfs-content".repeat(1024))
        .await
        .unwrap();
    vec![rootfs]
}

/// Helper: full atomic unpack from an on-disk archive (test-only path).
/// Mirrors what `try_download` does after the S3 GET succeeds: open file,
/// stream into staging, finalize. Lets the round-trip tests exercise the
/// same code as production without an S3 mock.
pub(super) async fn unpack_archive_for_test(
    archive: &Path,
    final_dir: &Path,
) -> Result<(), R2Error> {
    let staging = staging_dir(final_dir);
    let _ = tokio::fs::remove_dir_all(&staging).await;
    tokio::fs::create_dir_all(&staging).await?;
    let f = tokio::fs::File::open(archive).await?;
    unpack_into_staging(f, &staging).await?;
    finalize_staging(&staging, final_dir).await?;
    Ok(())
}

/// Helper: pack a synchronous closure on a blocking thread.
pub(super) async fn pack_blocking<F>(archive: &Path, f: F) -> Result<(), R2Error>
where
    F: FnOnce(std::fs::File) -> Result<(), R2Error> + Send + 'static,
{
    let p = archive.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::fs::File::create(&p).unwrap();
        f(out)
    })
    .await
    .unwrap()
}

/// Hand-write a 512-byte ustar header so we can put `..` in the path —
/// `tar::Builder` defends against this on the write side too.
pub(super) fn craft_tar_with_path(name: &[u8], data: &[u8]) -> Vec<u8> {
    craft_tar_entry(name, b'0', &[], data)
}

/// Hand-write a ustar header with a specific typeflag byte. Used to test
/// that `unpack_from_reader` rejects non-regular entries.
/// `typeflag`: `b'2'` = symlink, `b'1'` = hardlink, etc.
/// `link_target`: written into the linkname field (bytes 157..257).
pub(super) fn craft_tar_with_typeflag(name: &[u8], typeflag: u8, link_target: &[u8]) -> Vec<u8> {
    craft_tar_entry(name, typeflag, link_target, &[])
}

fn craft_tar_entry(name: &[u8], typeflag: u8, link_target: &[u8], data: &[u8]) -> Vec<u8> {
    assert!(name.len() < 100);
    assert!(link_target.len() < 100);

    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name);
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    let size_str = format!("{:011o}\0", data.len());
    header[124..136].copy_from_slice(size_str.as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].copy_from_slice(b"        ");
    header[156] = typeflag;
    header[157..157 + link_target.len()].copy_from_slice(link_target);
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let cksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
    let cksum_str = format!("{cksum:06o}\0 ");
    header[148..156].copy_from_slice(cksum_str.as_bytes());

    let padded_data_len = data.len().div_ceil(512) * 512;
    let mut tar = Vec::with_capacity(512 + padded_data_len + 1024);
    tar.extend_from_slice(&header);
    tar.extend_from_slice(data);
    tar.resize(512 + padded_data_len, 0);
    tar.extend_from_slice(&[0u8; 1024]);
    tar
}

/// Write one small file (1 KiB) that `upload()` will pack into a tar.zst.
pub(super) async fn small_src_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rootfs.ext4");
    tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();
    (dir, path)
}

/// Pack a tar.zst archive from a test file in-memory. Used to synthesize
/// a valid body for a mocked `get_object` response.
pub(super) async fn build_test_archive_bytes() -> Vec<u8> {
    packed_archive_bytes(&[("rootfs.ext4", b"hello".as_slice())]).await
}

pub(super) async fn build_template_archive_bytes() -> Vec<u8> {
    packed_archive_bytes(&[(TEMPLATE_FILE, b"hello".as_slice())]).await
}

pub(super) async fn build_template_archive_bytes_with_extra() -> Vec<u8> {
    packed_archive_bytes(&[
        (TEMPLATE_FILE, b"hello".as_slice()),
        ("extra.txt", b"discard me".as_slice()),
    ])
    .await
}

pub(super) async fn build_nested_template_archive_bytes() -> Vec<u8> {
    zstd_bytes(craft_tar_with_path(b"template.ext4/payload", b"bad")).await
}

pub(super) async fn build_empty_archive_bytes() -> Vec<u8> {
    pack_paths_to_bytes(Vec::new()).await
}

async fn packed_archive_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let src = tempfile::tempdir().unwrap();
    let mut paths = Vec::with_capacity(files.len());
    for (name, contents) in files {
        let path = src.path().join(name);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.unwrap();
        }
        tokio::fs::write(&path, contents).await.unwrap();
        paths.push(path);
    }
    // `src` lives until this await returns, which happens after
    // `pack_to_writer` has finished reading files on the blocking thread.
    pack_paths_to_bytes(paths).await
}

async fn pack_paths_to_bytes(files: Vec<PathBuf>) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        let mut buf: Vec<u8> = Vec::new();
        pack_to_writer(&mut buf, &files).unwrap();
        buf
    })
    .await
    .unwrap()
}

pub(super) async fn zstd_bytes(raw_tar: Vec<u8>) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut encoder = zstd::stream::write::Encoder::new(&mut out, 1).unwrap();
        std::io::Write::write_all(&mut encoder, &raw_tar).unwrap();
        encoder.finish().unwrap();
        out
    })
    .await
    .unwrap()
}

pub(super) fn get_object_body(bytes: Vec<u8>) -> Rule {
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let body = Arc::new(bytes);
    let body_for_closure = Arc::clone(&body);
    mock!(Client::get_object).then_output(move || {
        GetObjectOutput::builder()
            .body(ByteStream::from((*body_for_closure).clone()))
            .build()
    })
}

pub(super) fn get_object_body_for_key(
    bucket: &'static str,
    key: &'static str,
    bytes: Vec<u8>,
) -> Rule {
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let body = Arc::new(bytes);
    let body_for_closure = Arc::clone(&body);
    mock!(Client::get_object)
        .match_requests(move |req| req.bucket() == Some(bucket) && req.key() == Some(key))
        .then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*body_for_closure).clone()))
                .build()
        })
}
