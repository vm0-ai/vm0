use crate::support::{create_tar_gz, run_guest_download, write_manifest};
use httpmock::prelude::*;
use httpmock::{HttpMockRequest, HttpMockResponse, Mock};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

const REQUEST_START_TIMEOUT: Duration = Duration::from_secs(5);
const BLOCKED_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const NEGATIVE_START_TIMEOUT: Duration = Duration::from_millis(300);

fn gzip_response(body: Vec<u8>) -> HttpMockResponse {
    HttpMockResponse::builder()
        .status(200)
        .header("content-type", "application/gzip")
        .body(body)
        .build()
}

fn error_response(status: u16, body: String) -> HttpMockResponse {
    HttpMockResponse::builder()
        .status(status)
        .body(body)
        .build()
}

fn path_to_string(path: &Path) -> std::io::Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "path is not valid UTF-8")
    })
}

#[derive(Clone)]
struct ActiveRequestCounter {
    active: Arc<AtomicUsize>,
    max_active: Arc<AtomicUsize>,
}

struct ActiveRequestGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ActiveRequestCounter {
    fn new() -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn track(&self) -> ActiveRequestGuard {
        let current = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        let mut observed = self.max_active.load(Ordering::SeqCst);
        while current > observed {
            match self.max_active.compare_exchange(
                observed,
                current,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(actual) => observed = actual,
            }
        }

        ActiveRequestGuard {
            active: Arc::clone(&self.active),
        }
    }

    fn max_active(&self) -> usize {
        self.max_active.load(Ordering::SeqCst)
    }
}

fn wait_for_event(
    receiver: &mpsc::Receiver<String>,
    seen: &mut Vec<String>,
    expected: &str,
    timeout: Duration,
) -> Result<(), String> {
    if seen.iter().any(|event| event == expected) {
        return Ok(());
    }

    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for event {expected}"));
        }
        match receiver.recv_timeout(deadline - now) {
            Ok(event) if event == expected => return Ok(()),
            Ok(event) => seen.push(event),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!("timed out waiting for event {expected}"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("event channel closed before {expected}"));
            }
        }
    }
}

fn wait_for_events(
    receiver: &mpsc::Receiver<String>,
    count: usize,
    timeout: Duration,
) -> Result<Vec<String>, String> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();

    while events.len() < count {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "timed out waiting for {count} events, got {}",
                events.len()
            ));
        }

        match receiver.recv_timeout(deadline - now) {
            Ok(event) => events.push(event),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "timed out waiting for {count} events, got {}",
                    events.len()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "event channel closed after {} of {count} events",
                    events.len()
                ));
            }
        }
    }

    Ok(events)
}

struct ReleaseGate {
    inner: Arc<ReleaseStateMonitor>,
}

#[derive(Clone)]
struct ReleaseWaiter {
    inner: Arc<ReleaseStateMonitor>,
}

struct ReleaseStateMonitor {
    state: Mutex<ReleaseState>,
    released: Condvar,
}

struct ReleaseState {
    permits: usize,
    closed: bool,
}

impl ReleaseGate {
    fn new() -> Self {
        Self {
            inner: Arc::new(ReleaseStateMonitor {
                state: Mutex::new(ReleaseState {
                    permits: 0,
                    closed: false,
                }),
                released: Condvar::new(),
            }),
        }
    }

    fn waiter(&self) -> ReleaseWaiter {
        ReleaseWaiter {
            inner: Arc::clone(&self.inner),
        }
    }

    fn release_one(&self) {
        self.release_many(1);
    }

    fn release_many(&self, count: usize) {
        let mut state = self.lock_state();
        state.permits += count;
        drop(state);
        self.inner.released.notify_all();
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ReleaseState> {
        match self.inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Drop for ReleaseGate {
    fn drop(&mut self) {
        let mut state = self.lock_state();
        state.closed = true;
        drop(state);
        self.inner.released.notify_all();
    }
}

impl ReleaseWaiter {
    fn wait(&self, request_name: &str) -> Result<(), String> {
        let deadline = Instant::now() + BLOCKED_REQUEST_TIMEOUT;
        let mut state = match self.inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };

        loop {
            if state.closed {
                return Ok(());
            }

            if state.permits > 0 {
                state.permits -= 1;
                return Ok(());
            }

            let now = Instant::now();
            if now >= deadline {
                return Err(format!("timed out waiting to release {request_name}"));
            }

            let wait_result = self.inner.released.wait_timeout(state, deadline - now);
            let (next_state, wait_status) = match wait_result {
                Ok(result) => result,
                Err(poisoned) => poisoned.into_inner(),
            };
            state = next_state;

            if wait_status.timed_out() && state.permits == 0 && !state.closed {
                return Err(format!("timed out waiting to release {request_name}"));
            }
        }
    }
}

fn serve_archive<'server>(
    server: &'server MockServer,
    path: &'static str,
    body: Vec<u8>,
    on_start: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    active_requests: Option<ActiveRequestCounter>,
) -> Mock<'server> {
    server.mock(move |when, then| {
        when.method(GET).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            let _active_guard = active_requests.as_ref().map(ActiveRequestCounter::track);
            if let Err(error) = on_start() {
                return error_response(409, error);
            }
            gzip_response(body.clone())
        });
    })
}

fn serve_blocked_archive<'server>(
    server: &'server MockServer,
    path: &'static str,
    body: Vec<u8>,
    on_start: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    release: ReleaseWaiter,
    request_name: String,
    active_requests: Option<ActiveRequestCounter>,
) -> Mock<'server> {
    server.mock(move |when, then| {
        when.method(GET).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            let _active_guard = active_requests.as_ref().map(ActiveRequestCounter::track);
            if let Err(error) = on_start() {
                return error_response(409, error);
            }
            if let Err(error) = release.wait(&request_name) {
                return error_response(408, error);
            }
            gzip_response(body.clone())
        });
    })
}

struct NumberedStorages {
    _servers: Vec<MockServer>,
    storages: Vec<(String, String)>,
}

fn create_numbered_storages(
    dir: &tempfile::TempDir,
    event_tx: &mpsc::Sender<String>,
    mut blocked_request: impl FnMut(usize) -> Option<ReleaseWaiter>,
    active_requests: Option<ActiveRequestCounter>,
) -> std::io::Result<NumberedStorages> {
    let mut servers = Vec::new();
    let mut storages = Vec::new();

    for i in 0..5 {
        let server = MockServer::start();
        let filename = format!("file_{i}.txt");
        let content = format!("content_{i}");
        let body = create_tar_gz(&[(&filename, content.as_bytes())])?;
        let event_tx = event_tx.clone();
        let event = format!("start-{i}");
        let active_requests = active_requests.clone();

        if let Some(release) = blocked_request(i) {
            serve_blocked_archive(
                &server,
                "/storage.tar.gz",
                body,
                move || {
                    event_tx
                        .send(event.clone())
                        .map_err(|e| format!("failed to send {event}: {e}"))
                },
                release,
                format!("request {i}"),
                active_requests,
            );
        } else {
            serve_archive(
                &server,
                "/storage.tar.gz",
                body,
                move || {
                    event_tx
                        .send(event.clone())
                        .map_err(|e| format!("failed to send {event}: {e}"))
                },
                active_requests,
            );
        }

        let mount = dir.path().join(format!("mount_{i}"));
        storages.push((path_to_string(&mount)?, server.url("/storage.tar.gz")));
        servers.push(server);
    }

    Ok(NumberedStorages {
        _servers: servers,
        storages,
    })
}

fn spawn_guest_download(
    dir: &tempfile::TempDir,
    storages: &[(String, String)],
) -> std::io::Result<std::thread::JoinHandle<bool>> {
    let storage_refs: Vec<(&str, Option<&str>)> = storages
        .iter()
        .map(|(mount, url)| (mount.as_str(), Some(url.as_str())))
        .collect();
    let manifest = write_manifest(dir, &storage_refs, None)?;
    let manifest_path = path_to_string(&manifest)?;
    Ok(std::thread::spawn(move || {
        run_guest_download(&manifest_path)
    }))
}

#[test]
fn queued_independent_download_starts_when_slot_frees() {
    let dir = tempfile::tempdir().unwrap();
    let (event_tx, event_rx) = mpsc::channel();
    let slow_release = ReleaseGate::new();
    let active_requests = ActiveRequestCounter::new();
    let numbered = create_numbered_storages(
        &dir,
        &event_tx,
        |i| (i == 0).then(|| slow_release.waiter()),
        Some(active_requests.clone()),
    )
    .unwrap();
    let handle = spawn_guest_download(&dir, &numbered.storages).unwrap();

    let mut seen_events = Vec::new();
    let slow_started = wait_for_event(
        &event_rx,
        &mut seen_events,
        "start-0",
        REQUEST_START_TIMEOUT,
    );
    let queued_started = wait_for_event(
        &event_rx,
        &mut seen_events,
        "start-4",
        REQUEST_START_TIMEOUT,
    );
    slow_release.release_one();
    let result = handle.join().unwrap();

    slow_started.unwrap();
    queued_started.unwrap();
    assert!(result);
    assert!(
        active_requests.max_active() <= 4,
        "observed more than 4 active downloads"
    );

    for i in 0..5 {
        let mount = dir.path().join(format!("mount_{i}"));
        let content = std::fs::read_to_string(mount.join(format!("file_{i}.txt"))).unwrap();
        assert_eq!(content, format!("content_{i}"));
    }
}

#[test]
fn download_concurrency_cap_limits_initial_starts() {
    let dir = tempfile::tempdir().unwrap();
    let (event_tx, event_rx) = mpsc::channel();
    let release = ReleaseGate::new();
    let numbered =
        create_numbered_storages(&dir, &event_tx, |_| Some(release.waiter()), None).unwrap();
    let handle = spawn_guest_download(&dir, &numbered.storages).unwrap();

    let initial_starts = wait_for_events(&event_rx, 4, REQUEST_START_TIMEOUT);
    let fifth_before_release = event_rx.recv_timeout(NEGATIVE_START_TIMEOUT);
    release.release_many(5);
    let result = handle.join().unwrap();

    assert_eq!(initial_starts.unwrap().len(), 4);
    assert!(matches!(
        fifth_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert!(result);
}

#[test]
fn queued_conflict_does_not_block_later_independent_download() {
    let parent_server = MockServer::start();
    let child_server = MockServer::start();
    let independent_server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let parent_mount = dir.path().join("claude");
    let child_mount = dir.path().join("claude/skills/alpha");
    let independent_mount = dir.path().join("independent");
    let parent_tar = create_tar_gz(&[("config.json", b"parent config")]).unwrap();
    let child_tar = create_tar_gz(&[("skill.json", b"child skill")]).unwrap();
    let independent_tar = create_tar_gz(&[("data.txt", b"independent data")]).unwrap();
    let (parent_started_tx, parent_started_rx) = mpsc::channel();
    let (child_started_tx, child_started_rx) = mpsc::channel();
    let (independent_started_tx, independent_started_rx) = mpsc::channel();
    let parent_release = ReleaseGate::new();

    serve_blocked_archive(
        &parent_server,
        "/parent.tar.gz",
        parent_tar,
        move || {
            parent_started_tx
                .send(())
                .map_err(|e| format!("failed to send parent start event: {e}"))
        },
        parent_release.waiter(),
        "parent request".to_owned(),
        None,
    );
    serve_archive(
        &child_server,
        "/child.tar.gz",
        child_tar,
        move || {
            child_started_tx
                .send(())
                .map_err(|e| format!("failed to send child start event: {e}"))
        },
        None,
    );
    serve_archive(
        &independent_server,
        "/independent.tar.gz",
        independent_tar,
        move || {
            independent_started_tx
                .send(())
                .map_err(|e| format!("failed to send independent start event: {e}"))
        },
        None,
    );

    let url_parent = parent_server.url("/parent.tar.gz");
    let url_child = child_server.url("/child.tar.gz");
    let url_independent = independent_server.url("/independent.tar.gz");
    let storages = vec![
        (parent_mount.to_str().unwrap().to_owned(), url_parent),
        (child_mount.to_str().unwrap().to_owned(), url_child),
        (
            independent_mount.to_str().unwrap().to_owned(),
            url_independent,
        ),
    ];
    let handle = spawn_guest_download(&dir, &storages).unwrap();

    let parent_started = parent_started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let independent_started = independent_started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let child_before_release = child_started_rx.recv_timeout(NEGATIVE_START_TIMEOUT);
    parent_release.release_one();
    let child_after_release =
        if matches!(child_before_release, Err(mpsc::RecvTimeoutError::Timeout)) {
            child_started_rx.recv_timeout(REQUEST_START_TIMEOUT)
        } else {
            Ok(())
        };
    let result = handle.join().unwrap();

    parent_started.unwrap();
    independent_started.unwrap();
    assert!(matches!(
        child_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    child_after_release.unwrap();
    assert!(result);
    assert_eq!(
        std::fs::read_to_string(parent_mount.join("config.json")).unwrap(),
        "parent config"
    );
    assert_eq!(
        std::fs::read_to_string(child_mount.join("skill.json")).unwrap(),
        "child skill"
    );
    assert_eq!(
        std::fs::read_to_string(independent_mount.join("data.txt")).unwrap(),
        "independent data"
    );
}

#[test]
fn parent_child_mount_paths_are_serialized_for_overlapping_archives() {
    let parent_server = MockServer::start();
    let child_server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let parent_mount = dir.path().join("claude");
    let child_mount = dir.path().join("claude/skills/alpha");
    let parent_tar = create_tar_gz(&[
        ("config.json", b"parent config"),
        ("skills/alpha/skill.json", b"parent skill"),
    ])
    .unwrap();
    let child_tar = create_tar_gz(&[("skill.json", b"child skill")]).unwrap();
    let (parent_started_tx, parent_started_rx) = mpsc::channel();
    let (child_started_tx, child_started_rx) = mpsc::channel();
    let parent_release = ReleaseGate::new();

    let m_parent = serve_blocked_archive(
        &parent_server,
        "/parent.tar.gz",
        parent_tar,
        move || {
            parent_started_tx
                .send(())
                .map_err(|e| format!("failed to send parent start event: {e}"))
        },
        parent_release.waiter(),
        "parent request".to_owned(),
        None,
    );
    let m_child = serve_archive(
        &child_server,
        "/child.tar.gz",
        child_tar,
        move || {
            child_started_tx
                .send(())
                .map_err(|e| format!("failed to send child start event: {e}"))
        },
        None,
    );

    let url_parent = parent_server.url("/parent.tar.gz");
    let url_child = child_server.url("/child.tar.gz");
    let storages = vec![
        (parent_mount.to_str().unwrap().to_owned(), url_parent),
        (child_mount.to_str().unwrap().to_owned(), url_child),
    ];
    let handle = spawn_guest_download(&dir, &storages).unwrap();

    let parent_started = parent_started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let child_before_release = child_started_rx.recv_timeout(NEGATIVE_START_TIMEOUT);
    parent_release.release_one();
    let child_after_release =
        if matches!(child_before_release, Err(mpsc::RecvTimeoutError::Timeout)) {
            child_started_rx.recv_timeout(REQUEST_START_TIMEOUT)
        } else {
            Ok(())
        };
    let result = handle.join().unwrap();

    parent_started.unwrap();
    assert!(matches!(
        child_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    child_after_release.unwrap();
    assert!(result);
    m_parent.assert();
    m_child.assert();
    assert_eq!(
        std::fs::read_to_string(parent_mount.join("config.json")).unwrap(),
        "parent config"
    );
    assert_eq!(
        std::fs::read_to_string(child_mount.join("skill.json")).unwrap(),
        "child skill"
    );
}
