use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use super::super::{
    R2ImageCache,
    archive::{
        MAX_TEMPLATE_METADATA_BYTES, TEMPLATE_FILE, TemplateArchiveLimits, pack_template_to_writer,
    },
};
use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};

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

pub(super) async fn small_src_file() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.ext4");
    tokio::fs::write(&path, vec![0u8; 1024]).await.unwrap();
    (dir, path)
}

pub(super) fn regular_template_archive(contents: &[u8]) -> Vec<u8> {
    archive_from_entries(&[(TEMPLATE_FILE, tar::EntryType::Regular, contents)])
}

pub(super) fn template_archive_with_extra(contents: &[u8]) -> Vec<u8> {
    archive_from_entries(&[
        (TEMPLATE_FILE, tar::EntryType::Regular, contents),
        ("extra.txt", tar::EntryType::Regular, b"must not unpack"),
    ])
}

pub(super) fn template_archive_with_trailing_decompressed_data(contents: &[u8]) -> Vec<u8> {
    let mut raw = raw_archive_from_entries(&[(TEMPLATE_FILE, tar::EntryType::Regular, contents)]);
    raw.extend_from_slice(b"trailing decompressed data");
    zstd_bytes(&raw)
}

pub(super) fn empty_template_archive() -> Vec<u8> {
    archive_from_entries(&[])
}

pub(super) fn nested_template_archive() -> Vec<u8> {
    archive_from_entries(&[("template.ext4/payload", tar::EntryType::Regular, b"bad")])
}

pub(super) fn archive_with_type(entry_type: tar::EntryType) -> Vec<u8> {
    archive_from_entries(&[(TEMPLATE_FILE, entry_type, &[])])
}

fn archive_from_entries(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
    zstd_bytes(&raw_archive_from_entries(entries))
}

fn raw_archive_from_entries(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, entry_type, contents) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_path(name).unwrap();
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_size(contents.len() as u64);
        header.set_entry_type(*entry_type);
        header.set_cksum();
        builder.append(&header, Cursor::new(*contents)).unwrap();
    }
    builder.into_inner().unwrap()
}

pub(super) async fn production_template_archive(path: &Path) -> Vec<u8> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::new();
        pack_template_to_writer(&mut bytes, &path).unwrap();
        bytes
    })
    .await
    .unwrap()
}

pub(super) fn sparse_template_archive() -> (Vec<u8>, Vec<u8>) {
    const LOGICAL_BYTES: usize = 64 * 1024;
    const EXTENT_BYTES: usize = 512;

    let mut expected = vec![0u8; LOGICAL_BYTES];
    expected[..EXTENT_BYTES].fill(b'A');
    expected[LOGICAL_BYTES - EXTENT_BYTES..].fill(b'Z');

    let mut header = tar::Header::new_gnu();
    header.set_path(TEMPLATE_FILE).unwrap();
    header.set_mode(0o644);
    header.set_uid(0);
    header.set_gid(0);
    header.set_size((EXTENT_BYTES * 2) as u64);
    header.set_entry_type(tar::EntryType::GNUSparse);
    let gnu = header.as_gnu_mut().unwrap();
    gnu.set_real_size(LOGICAL_BYTES as u64);
    gnu.sparse[0].set_offset(0);
    gnu.sparse[0].set_length(EXTENT_BYTES as u64);
    gnu.sparse[1].set_offset((LOGICAL_BYTES - EXTENT_BYTES) as u64);
    gnu.sparse[1].set_length(EXTENT_BYTES as u64);
    header.set_cksum();

    let mut raw = Vec::new();
    raw.extend_from_slice(header.as_bytes());
    raw.extend(std::iter::repeat_n(b'A', EXTENT_BYTES));
    raw.extend(std::iter::repeat_n(b'Z', EXTENT_BYTES));
    raw.extend_from_slice(&[0u8; 1024]);
    (zstd_bytes(&raw), expected)
}

pub(super) fn excessive_sparse_metadata_archive() -> (Vec<u8>, u64) {
    const BLOCK_BYTES: u64 = 512;
    const DESCRIPTORS_PER_EXTENSION: u64 = 21;

    let extension_count = MAX_TEMPLATE_METADATA_BYTES / BLOCK_BYTES;
    let logical_bytes = extension_count * DESCRIPTORS_PER_EXTENSION * BLOCK_BYTES;
    let mut header = tar::Header::new_gnu();
    header.set_path(TEMPLATE_FILE).unwrap();
    header.set_mode(0o644);
    header.set_uid(0);
    header.set_gid(0);
    header.set_size(logical_bytes);
    header.set_entry_type(tar::EntryType::GNUSparse);
    let gnu = header.as_gnu_mut().unwrap();
    gnu.set_real_size(logical_bytes);
    gnu.set_is_extended(true);
    header.set_cksum();

    let mut raw = Vec::with_capacity(usize::try_from((extension_count + 1) * BLOCK_BYTES).unwrap());
    raw.extend_from_slice(header.as_bytes());
    let mut offset = 0;
    for _ in 0..extension_count {
        let mut extension = tar::GnuExtSparseHeader::new();
        for sparse in extension.sparse_mut() {
            sparse.set_offset(offset);
            sparse.set_length(BLOCK_BYTES);
            offset += BLOCK_BYTES;
        }
        extension.set_is_extended(true);
        raw.extend_from_slice(extension.as_bytes());
    }

    (zstd_bytes(&raw), logical_bytes)
}

pub(super) fn zstd_bytes(raw: &[u8]) -> Vec<u8> {
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
    encoder.write_all(raw).unwrap();
    encoder.finish().unwrap()
}

pub(super) fn deterministic_bytes(length: usize) -> Vec<u8> {
    let mut state = 0x4d59_5df4_d0f3_3173u64;
    let mut bytes = Vec::with_capacity(length);
    for _ in 0..length {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        bytes.push(state as u8);
    }
    bytes
}

pub(super) fn archive_limits(expected_template_bytes: u64) -> TemplateArchiveLimits {
    TemplateArchiveLimits::new(expected_template_bytes).unwrap()
}

pub(super) fn get_object_body(bytes: Vec<u8>) -> Rule {
    get_object_body_with_content_length(bytes, None)
}

pub(super) fn get_object_body_with_content_length(
    bytes: Vec<u8>,
    content_length: Option<i64>,
) -> Rule {
    use std::sync::Arc;

    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let body = Arc::new(bytes);
    let body_for_closure = Arc::clone(&body);
    mock!(Client::get_object).then_output(move || {
        let mut output =
            GetObjectOutput::builder().body(ByteStream::from((*body_for_closure).clone()));
        if let Some(content_length) = content_length {
            output = output.content_length(content_length);
        }
        output.build()
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
