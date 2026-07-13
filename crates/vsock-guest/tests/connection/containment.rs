use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use vsock_proto::{ExecOutputPolicy, ExecTermination};

use super::support::{
    finish_guest_connection, read_exec_result, send_exec_cancel, send_exec_start,
    start_guest_connection_with_cgroup_fixture, unique_tmp_path,
};

#[test]
fn exec_enters_and_cleans_its_cgroup_leaf() {
    let root_guard = unique_tmp_path("exec-cgroup", "");
    let root = PathBuf::from(root_guard.as_str());
    fs::create_dir(&root).unwrap();
    let (handle, mut host_stream) = start_guest_connection_with_cgroup_fixture(root.clone());

    send_exec_start(
        &mut host_stream,
        401,
        "sleep 60",
        60_000,
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    );
    let leaf = wait_for_leaf(&root);
    assert_eq!(fs::read_to_string(leaf.join("cgroup.procs")).unwrap(), "0");

    send_exec_cancel(&mut host_stream, 401);
    let (_, result) = read_exec_result(&mut host_stream, 401);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_empty_root(&root);

    finish_guest_connection(handle, host_stream);
    fs::remove_dir(&root).unwrap();
}

#[test]
fn malformed_containment_state_returns_wait_failed_and_closes_transport() {
    let root_guard = unique_tmp_path("exec-cgroup-fatal", "");
    let root = PathBuf::from(root_guard.as_str());
    fs::create_dir(&root).unwrap();
    let (handle, mut host_stream) = start_guest_connection_with_cgroup_fixture(root.clone());

    send_exec_start(
        &mut host_stream,
        402,
        "sleep 60",
        60_000,
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    );
    let leaf = wait_for_leaf(&root);
    fs::write(leaf.join("cgroup.events"), b"malformed\n").unwrap();

    send_exec_cancel(&mut host_stream, 402);
    let (_, result) = read_exec_result(&mut host_stream, 402);
    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert!(result.diagnostic.contains("exec containment failed"));

    let mut byte = [0_u8; 1];
    let transport_closed = match host_stream.read(&mut byte) {
        Ok(0) => true,
        Ok(_) => false,
        Err(error) => matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof
        ),
    };
    assert!(transport_closed, "fatal containment must close transport");
    drop(host_stream);
    let _ = handle.join().unwrap();
    fs::remove_dir_all(&root).unwrap();
}

fn wait_for_leaf(root: &Path) -> PathBuf {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(path) = fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
        {
            return path;
        }
        assert!(
            Instant::now() < deadline,
            "exec cgroup leaf was not created"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_empty_root(root: &Path) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if fs::read_dir(root).unwrap().next().is_none() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "exec cgroup leaf was not removed"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
