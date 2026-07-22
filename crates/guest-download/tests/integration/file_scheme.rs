use crate::support::{
    TarEntry, create_tar_gz, create_tar_gz_entries, run_guest_download, write_manifest,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// file:// scheme — runner-staged local archives (epic #10800)
// ---------------------------------------------------------------------------

// Successful file:// extraction: the local tarball is read and its contents are
// extracted into the mount path. The staged tarball is intentionally left in
// place — /tmp is wiped on VM teardown, and deleting it early breaks runs where
// two manifest entries share the same staged path.
#[test]
fn file_scheme_extraction_success() {
    let tar_gz = create_tar_gz(&[("hello.txt", b"hello from file")]).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("hello.txt")).unwrap(),
        "hello from file"
    );
    // Staged tarball is preserved — runner cleans /tmp on VM teardown.
    assert!(staged.exists());
}

// Security regression: file:// archives use the same extraction path as HTTP,
// but this is the production path for runner-staged storage cache tarballs.
#[test]
fn file_scheme_malicious_entries_are_skipped_while_safe_entries_extract() {
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::Symlink("evil_symlink", "../outside.txt"),
        TarEntry::Hardlink("evil_hardlink", "../outside.txt"),
        TarEntry::Raw {
            path: b"../path_escape.txt",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"escaped",
        },
    ])
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let outside_file = dir.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").unwrap();

    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
    assert!(!dir.path().join("path_escape.txt").exists());
    assert!(mount.join("evil_symlink").symlink_metadata().is_err());
    assert!(!mount.join("evil_hardlink").exists());
}

#[test]
fn file_scheme_staged_instructions_promote_without_touching_skill_child() {
    let instructions_tar_gz = create_tar_gz(&[
        ("AGENTS.md", b"runtime instructions"),
        ("CLAUDE.md", b"old alternate from archive"),
        ("extra.txt", b"ignored"),
        ("skills/evil/SKILL.md", b"ignored staged skill"),
    ])
    .unwrap();
    let skill_tar_gz = create_tar_gz(&[("SKILL.md", b"workflow skill")]).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let instructions_archive = dir.path().join("instructions.tar.gz");
    let skill_archive = dir.path().join("skill.tar.gz");
    std::fs::write(&instructions_archive, &instructions_tar_gz).unwrap();
    std::fs::write(&skill_archive, &skill_tar_gz).unwrap();

    let final_home = dir.path().join(".codex");
    let extract_path = dir
        .path()
        .join("runtime")
        .join("storage-instructions")
        .join("0");
    let skill_mount = final_home.join("skills").join("workflow");
    std::fs::create_dir_all(&final_home).unwrap();
    std::fs::write(final_home.join("CLAUDE.md"), "stale alternate").unwrap();

    let manifest_path = dir.path().join("manifest.json");
    let manifest = json!({
        "storages": [
            {
                "mountPath": final_home,
                "extractPath": extract_path,
                "archiveUrl": format!("file://{}", instructions_archive.display()),
                "instructionsTargetFilename": "AGENTS.md"
            },
            {
                "mountPath": skill_mount,
                "archiveUrl": format!("file://{}", skill_archive.display())
            }
        ],
        "artifacts": []
    });
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    let result = run_guest_download(manifest_path.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(final_home.join("AGENTS.md")).unwrap(),
        "runtime instructions"
    );
    assert_eq!(
        std::fs::read_to_string(skill_mount.join("SKILL.md")).unwrap(),
        "workflow skill"
    );
    assert!(!final_home.join("CLAUDE.md").exists());
    assert!(!final_home.join("extra.txt").exists());
    assert!(!final_home.join("skills").join("evil").exists());
    assert!(!extract_path.exists());
}

// Security regression: this exercises the ancestor symlink guard directly. The
// archive does not create the symlink; it is already present in the target.
#[test]
fn file_scheme_preexisting_symlink_ancestor_blocks_nested_entry() {
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::File("escape/payload.txt", b"malicious"),
    ])
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&mount).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, mount.join("escape")).unwrap();

    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert!(!outside.join("payload.txt").exists());
    assert!(
        mount
            .join("escape")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

// Storage with a missing file:// target fails the run. The runner only rewrites
// archive_url to file:// after vsock-staging succeeds, so a missing file means a
// broken runner contract: fatal and not retriable.
#[test]
fn file_scheme_missing_storage_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("never-existed.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(!result);
}

// Artifact downloads require a real archive. Explicit empty artifacts use the
// empty marker instead of a file:// archive, so a missing staged file is fatal.
#[test]
fn file_scheme_missing_artifact_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("never-existed.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("artifact_mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some(&url)))).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(!result);
}
