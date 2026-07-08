use super::{BinaryLoggingFixture, assert_action_types_present};
use crate::support::{create_tar_gz, write_manifest};
use httpmock::prelude::*;

#[test]
fn binary_records_download_scheduler_attribution() {
    let server = MockServer::start();
    let remote_tar = create_tar_gz(&[("remote.txt", b"remote")]).unwrap();
    let remote_mock = server.mock(|when, then| {
        when.method(GET).path("/remote.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&remote_tar);
    });

    let fixture = BinaryLoggingFixture::new("scheduler-attribution").unwrap();
    let local_tar = create_tar_gz(&[("local.txt", b"local")]).unwrap();
    let local_archive = fixture.dir.path().join("local.tar.gz");
    std::fs::write(&local_archive, local_tar).unwrap();
    let parent_mount = fixture.dir.path().join("mount");
    let child_mount = parent_mount.join("child");
    let remote_url = server.url("/remote.tar.gz");
    let local_url = format!("file://{}", local_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(parent_mount.to_str().unwrap(), Some(&remote_url))],
        Some((child_mount.to_str().unwrap(), Some(&local_url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    remote_mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(parent_mount.join("remote.txt")).unwrap(),
        "remote"
    );
    assert_eq!(
        std::fs::read_to_string(child_mount.join("local.txt")).unwrap(),
        "local"
    );

    let actions = fixture.action_types().unwrap();
    assert_action_types_present(
        &actions,
        &[
            "guest_download_task_count_2",
            "guest_download_remote_url_count_1",
            "guest_download_file_url_count_1",
            "guest_download_skill_child_task_count_0",
            "guest_download_framework_home_instructions_task_absent",
            "guest_download_potential_parent_child_overlap_count_1",
            "guest_download_mount_conflict_deferral_count_1",
            "guest_download_instructions_skill_conflict_deferral_count_0",
            "guest_download_exact_path_conflict_deferral_count_0",
            "guest_download_other_parent_child_conflict_deferral_count_1",
            "storage_download",
            "artifact_download",
            "download_total",
        ],
    );
}

#[test]
fn binary_records_scheduler_attribution_for_failed_download() {
    let server = MockServer::start();
    let remote_mock = server.mock(|when, then| {
        when.method(GET).path("/missing.tar.gz");
        then.status(404);
    });

    let fixture = BinaryLoggingFixture::new("scheduler-attribution-failure").unwrap();
    let local_tar = create_tar_gz(&[("local.txt", b"local")]).unwrap();
    let local_archive = fixture.dir.path().join("local.tar.gz");
    std::fs::write(&local_archive, local_tar).unwrap();
    let parent_mount = fixture.dir.path().join("mount");
    let child_mount = parent_mount.join("child");
    let remote_url = server.url("/missing.tar.gz");
    let local_url = format!("file://{}", local_archive.display());
    let manifest = write_manifest(
        &fixture.dir,
        &[(parent_mount.to_str().unwrap(), Some(&remote_url))],
        Some((child_mount.to_str().unwrap(), Some(&local_url))),
    )
    .unwrap();

    let output = fixture.run_manifest_path(&manifest).unwrap();

    assert!(
        !output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    remote_mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(child_mount.join("local.txt")).unwrap(),
        "local"
    );

    let ops = fixture.ops_entries().unwrap();
    let conflict = ops
        .iter()
        .find(|entry| entry["action_type"] == "guest_download_mount_conflict_deferral_count_1")
        .unwrap_or_else(|| panic!("missing mount conflict count in {ops:?}"));
    assert_eq!(conflict["success"], true);
    let other_parent_child_conflict = ops
        .iter()
        .find(|entry| {
            entry["action_type"] == "guest_download_other_parent_child_conflict_deferral_count_1"
        })
        .unwrap_or_else(|| panic!("missing other parent/child conflict count in {ops:?}"));
    assert_eq!(other_parent_child_conflict["success"], true);
    let total = ops
        .iter()
        .find(|entry| entry["action_type"] == "download_total")
        .unwrap_or_else(|| panic!("missing download_total in {ops:?}"));
    assert_eq!(total["success"], false);
}
