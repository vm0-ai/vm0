use std::collections::HashMap;
use std::fs;
use std::path::Path;

use flate2::{Compression, write::GzEncoder};

use super::build_storage_plan;
use crate::storage_fingerprints::{StorageFingerprint, StorageFingerprints};
use crate::storage_manifest::{ArtifactEntry, StorageEntry, StorageManifest};

fn storage(
    mount_path: &Path,
    name: &str,
    version: &str,
    archive_url: String,
    instructions_target_filename: Option<&str>,
) -> StorageEntry {
    StorageEntry {
        name: name.into(),
        mount_path: mount_path.to_string_lossy().into_owned(),
        vas_storage_name: name.into(),
        vas_version_id: version.into(),
        instructions_target_filename: instructions_target_filename.map(str::to_string),
        archive_url,
        archive_size: None,
    }
}

fn artifact(mount_path: &Path, name: &str, version: &str, archive_url: String) -> ArtifactEntry {
    ArtifactEntry {
        mount_path: mount_path.to_string_lossy().into_owned(),
        vas_storage_name: name.into(),
        vas_storage_id: format!("{name}-id"),
        vas_version_id: version.into(),
        archive_url: Some(archive_url),
        empty: None,
        missing_root_policy: None,
        archive_size: None,
    }
}

fn write_archive(dir: &Path, name: &str, files: &[(&str, &[u8])]) -> String {
    let archive_path = dir.join(name);
    let archive = fs::File::create(&archive_path).unwrap();
    let encoder = GzEncoder::new(archive, Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    for (path, contents) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, *contents).unwrap();
    }
    let encoder = builder.into_inner().unwrap();
    encoder.finish().unwrap();
    format!("file://{}", archive_path.display())
}

fn run_plan(plan: super::StoragePlan) {
    let bytes = serde_json::to_vec(&plan.into_guest_manifest()).unwrap();
    assert!(guest_download::run_manifest_bytes(&bytes));
}

#[test]
fn reused_empty_fingerprints_replace_stale_storage_contents() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("data");
    fs::create_dir_all(&mount).unwrap();
    fs::write(mount.join("stale.txt"), "stale").unwrap();
    let archive_url = write_archive(dir.path(), "storage.tar.gz", &[("current.txt", b"current")]);
    let manifest = StorageManifest {
        storages: vec![storage(&mount, "data", "v1", archive_url, None)],
        artifacts: Vec::new(),
    };

    let plan = build_storage_plan(
        &manifest,
        dir.path().join("runtime").to_string_lossy().as_ref(),
        Some(&StorageFingerprints::default()),
    )
    .unwrap();
    run_plan(plan);

    assert!(!mount.join("stale.txt").exists());
    assert_eq!(
        fs::read_to_string(mount.join("current.txt")).unwrap(),
        "current"
    );
}

#[test]
fn cached_artifacts_preserve_existing_root_and_repair_missing_root() {
    let dir = tempfile::tempdir().unwrap();
    let existing_mount = dir.path().join("existing-workspace");
    let missing_mount = dir.path().join("missing-workspace");
    fs::create_dir_all(&existing_mount).unwrap();
    fs::write(existing_mount.join("preserved.txt"), "preserved").unwrap();
    let existing_url = write_archive(
        dir.path(),
        "existing-artifact.tar.gz",
        &[("unexpected.txt", b"unexpected")],
    );
    let missing_url = write_archive(
        dir.path(),
        "missing-artifact.tar.gz",
        &[("repaired.txt", b"repaired")],
    );
    let manifest = StorageManifest {
        storages: Vec::new(),
        artifacts: vec![
            artifact(&existing_mount, "existing", "v1", existing_url),
            artifact(&missing_mount, "missing", "v1", missing_url),
        ],
    };
    let previous = StorageFingerprints {
        storages: HashMap::new(),
        artifacts: HashMap::from([
            (
                existing_mount.to_string_lossy().into_owned(),
                StorageFingerprint::new("existing", "v1"),
            ),
            (
                missing_mount.to_string_lossy().into_owned(),
                StorageFingerprint::new("missing", "v1"),
            ),
        ]),
    };

    let plan = build_storage_plan(
        &manifest,
        dir.path().join("runtime").to_string_lossy().as_ref(),
        Some(&previous),
    )
    .unwrap();
    run_plan(plan);

    assert_eq!(
        fs::read_to_string(existing_mount.join("preserved.txt")).unwrap(),
        "preserved"
    );
    assert!(!existing_mount.join("unexpected.txt").exists());
    assert_eq!(
        fs::read_to_string(missing_mount.join("repaired.txt")).unwrap(),
        "repaired"
    );
}

#[test]
fn changed_instructions_promote_without_removing_cached_child() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".codex");
    let child = home.join("skills/workflow");
    fs::create_dir_all(&child).unwrap();
    fs::write(home.join("AGENTS.md"), "stale instructions").unwrap();
    fs::write(child.join("SKILL.md"), "cached skill").unwrap();
    let instructions_url = write_archive(
        dir.path(),
        "instructions.tar.gz",
        &[
            ("AGENTS.md", b"current instructions"),
            ("skills/untracked/SKILL.md", b"must not escape staging"),
        ],
    );
    let child_url = format!(
        "file://{}",
        dir.path().join("unused-child.tar.gz").display()
    );
    let manifest = StorageManifest {
        storages: vec![
            storage(
                &home,
                "agent-instructions@test",
                "v2",
                instructions_url,
                Some("AGENTS.md"),
            ),
            storage(&child, "workflow", "v1", child_url, None),
        ],
        artifacts: Vec::new(),
    };
    let previous = StorageFingerprints {
        storages: HashMap::from([
            (
                home.to_string_lossy().into_owned(),
                StorageFingerprint::new("agent-instructions@test", "v1"),
            ),
            (
                child.to_string_lossy().into_owned(),
                StorageFingerprint::new("workflow", "v1"),
            ),
        ]),
        artifacts: HashMap::new(),
    };
    let runtime_dir = dir.path().join("runtime");

    let plan = build_storage_plan(
        &manifest,
        runtime_dir.to_string_lossy().as_ref(),
        Some(&previous),
    )
    .unwrap();
    run_plan(plan);

    assert_eq!(
        fs::read_to_string(home.join("AGENTS.md")).unwrap(),
        "current instructions"
    );
    assert_eq!(
        fs::read_to_string(child.join("SKILL.md")).unwrap(),
        "cached skill"
    );
    assert!(!home.join("skills/untracked").exists());
    assert!(!runtime_dir.join("storage-instructions/0").exists());
}
