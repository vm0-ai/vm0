use std::path::PathBuf;

use super::super::{R2Error, archive::pack_to_writer, download::staging_dir};
use super::fixtures::{
    craft_tar_with_path, craft_tar_with_typeflag, pack_blocking, unpack_archive_for_test,
    write_mock_image_files,
};

// ---- pack / unpack round-trip --------------------------------------

#[tokio::test]
async fn pack_then_unpack_round_trips_rootfs() {
    let src_dir = tempfile::tempdir().unwrap();
    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash-abc");

    let src_files = write_mock_image_files(src_dir.path()).await;

    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    let files_for_pack = src_files.clone();
    tokio::task::spawn_blocking(move || {
        let f = std::fs::File::create(&archive_path).unwrap();
        pack_to_writer(f, &files_for_pack)
    })
    .await
    .unwrap()
    .unwrap();

    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    let dst = final_dir.join("rootfs.ext4");
    let src = src_dir.path().join("rootfs.ext4");
    assert!(dst.exists(), "rootfs.ext4 should exist after unpack");
    let dst_meta = std::fs::metadata(&dst).unwrap();
    let src_meta = std::fs::metadata(&src).unwrap();
    assert_eq!(dst_meta.len(), src_meta.len(), "rootfs size mismatch");

    // Staging directory should no longer exist after the rename.
    assert!(!staging_dir(&final_dir).exists());
}

#[tokio::test]
async fn unpack_atomic_no_partial_final_dir_on_failure() {
    // A truncated tar.zst (random bytes that aren't a valid zstd stream)
    // should fail mid-unpack and leave final_dir absent.
    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash-bad");

    let bad_archive = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(bad_archive.path(), b"not a valid zstd stream").unwrap();

    let result = unpack_archive_for_test(bad_archive.path(), &final_dir).await;
    assert!(result.is_err(), "unpack of garbage should fail");
    assert!(
        !final_dir.exists(),
        "final_dir must NOT exist after a failed unpack — \
         this is what prevents false-positive cache hits"
    );
}

#[tokio::test]
async fn pack_uses_basename_only() {
    // Files passed to pack_to_writer may have arbitrary parent paths;
    // they should be stored under their basename in the tar so unpack
    // produces a flat directory.
    let src_dir = tempfile::tempdir().unwrap();
    let nested = src_dir.path().join("deeply/nested/path");
    tokio::fs::create_dir_all(&nested).await.unwrap();
    let nested_file = nested.join("rootfs.ext4");
    tokio::fs::write(&nested_file, b"hello").await.unwrap();

    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    let files = vec![nested_file];
    tokio::task::spawn_blocking(move || {
        let f = std::fs::File::create(&archive_path).unwrap();
        pack_to_writer(f, &files)
    })
    .await
    .unwrap()
    .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("out");
    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    assert!(final_dir.join("rootfs.ext4").exists());
    // No nested directory in the unpacked output.
    assert!(!final_dir.join("deeply").exists());
}

/// `tar::Archive::unpack` must reject entries whose path escapes via `..` so
/// attacker-controlled artifacts can't write outside the staging directory
/// (defense-in-depth — R2 bucket is private, but if an IAM key leaked, this
/// would prevent escalation).
#[tokio::test]
async fn unpack_rejects_path_traversal() {
    let raw_tar = craft_tar_with_path(b"../escaped.txt", b"hello");
    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::fs::File::create(&archive_path).unwrap();
        let mut zw = zstd::stream::write::Encoder::new(out, 1).unwrap();
        std::io::Write::write_all(&mut zw, &raw_tar).unwrap();
        zw.finish().unwrap();
    })
    .await
    .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    // tar 0.4 silently SKIPS entries with `..` components (returns Ok(false)
    // from Entry::unpack_in) and Archive::unpack happily continues. So the
    // unpack succeeds with an empty staging dir → finalize_staging renames
    // it to final_dir which exists but is empty. The security invariant is
    // not "must error" — it is "must not write outside dst".
    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    // Critical: nothing escaped to the parent of staging/final_dir.
    assert!(
        !dst_root.path().join("escaped.txt").exists(),
        "escaped.txt MUST NOT appear at the dst_root level"
    );
    // The malicious entry was dropped, so final_dir is empty.
    let entries: Vec<_> = std::fs::read_dir(&final_dir).unwrap().collect();
    assert!(
        entries.is_empty(),
        "malicious entry should be dropped, final_dir empty, got {entries:?}"
    );
}

/// Helper: assert that a tar with the given typeflag is rejected by
/// `unpack_from_reader`. Covers symlink, hardlink, and any other
/// non-regular entry type.
async fn assert_unpack_rejects_typeflag(typeflag: u8, link_target: &[u8]) {
    let raw_tar = craft_tar_with_typeflag(b"rootfs.ext4", typeflag, link_target);
    let archive = tempfile::NamedTempFile::new().unwrap();
    let archive_path = archive.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::fs::File::create(&archive_path).unwrap();
        let mut zw = zstd::stream::write::Encoder::new(out, 1).unwrap();
        std::io::Write::write_all(&mut zw, &raw_tar).unwrap();
        zw.finish().unwrap();
    })
    .await
    .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    let err = unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("rejected non-regular tar entry"),
        "expected rejection error, got: {msg}"
    );
    assert!(
        !final_dir.exists(),
        "final_dir must not be created on error"
    );
}

/// Symlink entries must be rejected — an attacker could point
/// `rootfs.ext4` at `/etc/shadow` to leak host file contents.
#[tokio::test]
async fn unpack_rejects_symlink_entries() {
    assert_unpack_rejects_typeflag(b'2', b"/etc/shadow").await;
}

/// Hardlink entries must be rejected — could alias existing host files.
#[tokio::test]
async fn unpack_rejects_hardlink_entries() {
    assert_unpack_rejects_typeflag(b'1', b"/etc/passwd").await;
}

/// `pack_to_writer` propagates I/O errors from `append_path_with_name` —
/// e.g., source file removed between `expected_files()` enumeration and pack.
#[tokio::test]
async fn pack_errors_on_missing_source_file() {
    let archive = tempfile::NamedTempFile::new().unwrap();
    let nonexistent = PathBuf::from("/definitely/does/not/exist/rootfs.ext4");
    let result = pack_blocking(archive.path(), move |out| {
        pack_to_writer(out, std::slice::from_ref(&nonexistent))
    })
    .await;
    match result {
        Err(R2Error::Io(_)) => {} // expected
        other => panic!("expected R2Error::Io for missing source, got {other:?}"),
    }
}

/// Empty file list: pack succeeds and produces a valid (empty) tar.zst.
/// Round-trip unpack gives an empty `final_dir`. This is degenerate but
/// must not panic — it's the canary for the caller's post-download
/// completeness check (currently: rootfs.ext4 presence) to catch.
#[tokio::test]
async fn pack_unpack_empty_files_list() {
    let archive = tempfile::NamedTempFile::new().unwrap();
    pack_blocking(archive.path(), |out| pack_to_writer(out, &[]))
        .await
        .unwrap();

    let dst_root = tempfile::tempdir().unwrap();
    let final_dir = dst_root.path().join("hash");
    unpack_archive_for_test(archive.path(), &final_dir)
        .await
        .unwrap();

    assert!(final_dir.exists());
    let entries: Vec<_> = std::fs::read_dir(&final_dir).unwrap().collect();
    assert!(
        entries.is_empty(),
        "empty pack → empty unpack, got {entries:?}"
    );
}
