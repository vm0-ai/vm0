#![allow(clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use vsock_proto::{MSG_ERROR, MSG_READY, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, RawMessage};

const SANDBOX_UID: u32 = 42_420;
const SANDBOX_GID: u32 = 42_420;
const SANDBOX_SUPPLEMENTARY_GID: u32 = 42_421;
const SANDBOX_HOME: &str = "/home/user";
const PRIVILEGED_REPORT_DIR: &str = "/root";

#[derive(Debug, Eq, PartialEq)]
struct Identity {
    uid: u32,
    gid: u32,
    groups: BTreeSet<u32>,
    cwd: PathBuf,
    home: String,
    user: String,
    logname: String,
}

struct ReportFile {
    path: PathBuf,
}

impl ReportFile {
    fn new(path: PathBuf) -> Self {
        let _ = fs::remove_file(&path);
        Self { path }
    }

    fn read_identity(&self) -> Identity {
        parse_identity_report(
            &fs::read_to_string(&self.path)
                .unwrap_or_else(|error| panic!("read identity report {:?}: {error}", self.path)),
        )
    }
}

impl Drop for ReportFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[test]
#[ignore = "requires root and a production sandbox account; executed explicitly by Rust CI"]
fn production_write_file_identity_matches_sudo_policy() {
    require_production_configuration();

    let parent = current_identity();
    assert_eq!(parent.uid, 0, "test must run as root");
    assert_ne!(parent.user, "user", "parent USER must differ from sandbox");

    let (handle, mut stream) = start_guest_connection();
    let process_id = std::process::id();

    let sandbox_report_name = format!("vm0-production-identity-{process_id}.txt");
    let sandbox_report = ReportFile::new(Path::new(SANDBOX_HOME).join(&sandbox_report_name));
    send_write_file(&mut stream, 1, &sandbox_report_name, false);

    assert_eq!(
        sandbox_report.read_identity(),
        Identity {
            uid: SANDBOX_UID,
            gid: SANDBOX_GID,
            groups: BTreeSet::from([SANDBOX_GID, SANDBOX_SUPPLEMENTARY_GID]),
            cwd: PathBuf::from(SANDBOX_HOME),
            home: SANDBOX_HOME.to_string(),
            user: "user".to_string(),
            logname: "user".to_string(),
        }
    );

    let sudo_report = ReportFile::new(
        Path::new(PRIVILEGED_REPORT_DIR)
            .join(format!("vm0-production-identity-sudo-{process_id}.txt")),
    );
    let sudo_report_path = sudo_report.path.to_string_lossy().into_owned();
    send_write_file(&mut stream, 2, &sudo_report_path, true);

    assert_eq!(sudo_report.read_identity(), parent);

    drop(stream);
    join_guest_connection(handle);
}

fn require_production_configuration() {
    #[cfg(debug_assertions)]
    panic!("test requires debug assertions off");

    #[cfg(all(not(debug_assertions), feature = "test-support"))]
    panic!("test must exercise the production path without test-support");
}

fn start_guest_connection() -> (JoinHandle<std::io::Result<()>>, UnixStream) {
    let (guest_stream, mut host_stream) = UnixStream::pair().expect("create Unix stream pair");
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set host read timeout");
    let handle = thread::spawn(move || vsock_guest::handle_connection(guest_stream));

    let ready = read_message(&mut host_stream);
    assert_eq!(ready.msg_type, MSG_READY);

    (handle, host_stream)
}

fn join_guest_connection(handle: JoinHandle<std::io::Result<()>>) {
    handle
        .join()
        .expect("guest connection thread panicked")
        .expect("guest connection returned an error");
}

fn send_write_file(stream: &mut UnixStream, sequence: u32, path: &str, sudo: bool) {
    let payload =
        vsock_proto::encode_write_file(path, b"identity probe", sudo, false).expect("encode write");
    let frame = vsock_proto::encode(MSG_WRITE_FILE, sequence, &payload).expect("frame write");
    stream.write_all(&frame).expect("send write request");

    let response = read_message(stream);
    if response.msg_type == MSG_ERROR {
        panic!(
            "write request failed: {}",
            vsock_proto::decode_error(&response.payload).expect("decode write error")
        );
    }
    assert_eq!(response.msg_type, MSG_WRITE_FILE_RESULT);
    assert_eq!(response.seq, sequence);
    let (success, error) =
        vsock_proto::decode_write_file_result(&response.payload).expect("decode write-file result");
    assert!(success, "write-file child failed: {error}");
}

fn read_message(stream: &mut UnixStream) -> RawMessage {
    let mut header = [0_u8; 4];
    stream.read_exact(&mut header).expect("read frame header");
    let body_len = u32::from_be_bytes(header) as usize;
    let mut body = vec![0_u8; body_len];
    stream.read_exact(&mut body).expect("read frame body");

    let mut frame = Vec::with_capacity(header.len() + body.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&body);
    let mut messages = vsock_proto::Decoder::new()
        .decode(&frame)
        .expect("decode frame");
    assert_eq!(messages.len(), 1);
    messages.remove(0)
}

fn parse_identity_report(report: &str) -> Identity {
    let fields: BTreeMap<&str, &str> = report
        .lines()
        .map(|line| line.split_once('=').expect("identity report field"))
        .collect();
    let field = |name: &str| {
        fields
            .get(name)
            .copied()
            .unwrap_or_else(|| panic!("identity report missing {name:?}: {report:?}"))
    };

    Identity {
        uid: field("uid").parse().expect("parse uid"),
        gid: field("gid").parse().expect("parse gid"),
        groups: field("groups")
            .split_whitespace()
            .map(|group| group.parse().expect("parse group"))
            .collect(),
        cwd: PathBuf::from(field("cwd")),
        home: field("home").to_string(),
        user: field("user").to_string(),
        logname: field("logname").to_string(),
    }
}

fn current_identity() -> Identity {
    Identity {
        // SAFETY: These process identity getters have no preconditions.
        uid: unsafe { libc::geteuid() },
        // SAFETY: These process identity getters have no preconditions.
        gid: unsafe { libc::getegid() },
        groups: current_groups(),
        cwd: std::env::current_dir().expect("read current directory"),
        home: std::env::var("HOME").unwrap_or_default(),
        user: std::env::var("USER").unwrap_or_default(),
        logname: std::env::var("LOGNAME").unwrap_or_default(),
    }
}

fn current_groups() -> BTreeSet<u32> {
    // SAFETY: A null pointer with a zero size queries the required group count.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    assert!(
        count >= 0,
        "query current groups: {}",
        std::io::Error::last_os_error()
    );

    let mut groups = vec![0; count as usize];
    if count > 0 {
        // SAFETY: The vector has capacity for exactly `count` group IDs.
        let actual = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
        assert_eq!(actual, count, "read current groups");
    }

    let mut groups: BTreeSet<u32> = groups.into_iter().collect();
    // `id -G` includes the effective primary group as well as supplementary groups.
    // SAFETY: This process identity getter has no preconditions.
    groups.insert(unsafe { libc::getegid() });
    groups
}
