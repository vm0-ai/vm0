//! Integration coverage for the guest-download slot scheduler.
//!
//! The scheduler may run up to four downloads at once, but archives whose
//! mount paths are equal or have an ancestor/descendant relationship must not
//! extract concurrently. These tests also cover slot refill behavior: when an
//! active download blocks a conflicting queued task, a later independent task
//! should still be able to fill an available slot.
//!
//! The harness uses request-start events and explicit release gates to create
//! deterministic scheduler pressure. Bounded waits are assertion deadlines and
//! failure detectors; they are not sleeps used to make scheduling happen.

use crate::binary_logging::BinaryLoggingFixture;
#[cfg(unix)]
use crate::process;
use crate::process::ChildExecution;
use crate::support::{create_tar_gz, write_manifest};
use httpmock::prelude::*;
use httpmock::{HttpMockRequest, HttpMockResponse, Mock};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::{Duration, Instant};

const REQUEST_START_TIMEOUT: Duration = Duration::from_secs(5);
const BLOCKED_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const NEGATIVE_START_TIMEOUT: Duration = Duration::from_millis(300);
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONDER_CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);
const CHILD_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(1);

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

// Records request starts and responder concurrency for scheduler assertions
// and completion-timeout diagnostics.
#[derive(Clone)]
struct RequestObservations {
    state: Arc<Mutex<RequestObservationState>>,
}

struct ActiveRequestGuard {
    state: Arc<Mutex<RequestObservationState>>,
}

struct RequestObservationState {
    started: Vec<String>,
    active: usize,
    max_active: usize,
}

#[derive(Debug)]
struct RequestSnapshot {
    started: Vec<String>,
    active: usize,
    max_active: usize,
}

impl RequestSnapshot {
    fn describe(&self) -> String {
        format!(
            "started={:?}, active={}, max_active={}",
            self.started, self.active, self.max_active
        )
    }
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.active -= 1;
    }
}

impl RequestObservations {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RequestObservationState {
                started: Vec::new(),
                active: 0,
                max_active: 0,
            })),
        }
    }

    fn track(&self, request_name: &str) -> ActiveRequestGuard {
        let mut state = self.lock_state();
        state.started.push(request_name.to_owned());
        state.active += 1;
        state.max_active = state.max_active.max(state.active);
        drop(state);

        ActiveRequestGuard {
            state: Arc::clone(&self.state),
        }
    }

    fn max_active(&self) -> usize {
        self.lock_state().max_active
    }

    fn active(&self) -> usize {
        self.lock_state().active
    }

    fn snapshot(&self) -> RequestSnapshot {
        let state = self.lock_state();
        RequestSnapshot {
            started: state.started.clone(),
            active: state.active,
            max_active: state.max_active,
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, RequestObservationState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn wait_until_idle(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            let active = self.active();
            if active == 0 {
                return Ok(());
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "{active} mock archive responders remained active after {timeout:?}"
                ));
            }
            std::thread::sleep(remaining.min(CHILD_WAIT_POLL_INTERVAL));
        }
    }
}

// These helpers use recv_timeout as bounded assertions: timeouts fail the test
// with context instead of driving scheduler progress.
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

// ReleaseGate lets tests hold selected mock HTTP responders open after their
// start event, creating deterministic scheduler pressure without sleeps.
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

    fn close(&self) {
        let mut state = self.lock_state();
        state.closed = true;
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
        self.close();
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
    request_name: String,
    observations: RequestObservations,
) -> Mock<'server> {
    server.mock(move |when, then| {
        when.method(GET).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            let _active_guard = observations.track(&request_name);
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
    observations: RequestObservations,
) -> Mock<'server> {
    server.mock(move |when, then| {
        when.method(GET).path(path);
        then.respond_with(move |_req: &HttpMockRequest| {
            let _active_guard = observations.track(&request_name);
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

fn retry_once_archive_server(
    body: Vec<u8>,
    event_tx: mpsc::Sender<String>,
    first_attempt_release: ReleaseWaiter,
    request_name: String,
    observations: RequestObservations,
) -> (MockServer, Arc<AtomicUsize>) {
    let server = MockServer::start();
    let attempts = Arc::new(AtomicUsize::new(0));
    let responder_attempts = Arc::clone(&attempts);
    server.mock(move |when, then| {
        when.method(GET).path("/archive.tar.gz");
        then.respond_with(move |_req: &HttpMockRequest| {
            let _active_guard = observations.track(&request_name);
            let attempt = responder_attempts.fetch_add(1, Ordering::SeqCst) + 1;
            let event = format!("{request_name}-attempt-{attempt}");
            if event_tx.send(event.clone()).is_err() {
                return error_response(409, format!("failed to send {event}"));
            }
            if attempt == 1 {
                if let Err(error) = first_attempt_release.wait(&request_name) {
                    return error_response(408, error);
                }
                return error_response(503, format!("retry {request_name}"));
            }
            gzip_response(body.clone())
        });
    });
    (server, attempts)
}

struct NumberedStorages {
    _servers: Vec<MockServer>,
    storages: Vec<(String, String)>,
}

fn create_numbered_storages(
    dir: &tempfile::TempDir,
    event_tx: &mpsc::Sender<String>,
    mut blocked_request: impl FnMut(usize) -> Option<ReleaseWaiter>,
    observations: RequestObservations,
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
        let observations = observations.clone();
        let request_name = format!("request {i}");

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
                request_name,
                observations,
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
                request_name,
                observations,
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

struct GuestDownloadExecution {
    child: ChildExecution,
    _runtime: BinaryLoggingFixture,
}

impl GuestDownloadExecution {
    #[cfg(unix)]
    fn id(&self) -> std::io::Result<u32> {
        self.child.id()
    }

    fn wait_for_completion(
        mut self,
        scenario: &str,
        timeout: Duration,
        release_gate: &ReleaseGate,
        observations: &RequestObservations,
    ) -> Result<(), String> {
        match self.child.wait_with_timeout(timeout) {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!(
                "{scenario} guest-download exited with {status}; {}",
                observations.snapshot().describe()
            )),
            Err(error) => {
                let snapshot = observations.snapshot();
                release_gate.close();
                let responders = match observations.wait_until_idle(RESPONDER_CLEANUP_TIMEOUT) {
                    Ok(()) => "idle".to_owned(),
                    Err(error) => format!("failed: {error}"),
                };
                Err(format!(
                    "{scenario} {error}; {}; responders={responders}",
                    snapshot.describe()
                ))
            }
        }
    }
}

fn spawn_guest_download(
    scenario: &str,
    dir: &tempfile::TempDir,
    storages: &[(String, String)],
) -> std::io::Result<GuestDownloadExecution> {
    let storage_refs: Vec<(&str, Option<&str>)> = storages
        .iter()
        .map(|(mount, url)| (mount.as_str(), Some(url.as_str())))
        .collect();
    let manifest = write_manifest(dir, &storage_refs, None)?;
    let manifest_path = path_to_string(&manifest)?;
    let runtime = BinaryLoggingFixture::new(scenario)?;
    let child = ChildExecution::spawn(runtime.command().arg(manifest_path))?;
    Ok(GuestDownloadExecution {
        child,
        _runtime: runtime,
    })
}

#[test]
fn completion_timeout_terminates_child_and_releases_responder() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("blocked");
    let body = create_tar_gz(&[("state.json", b"blocked")]).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let release = ReleaseGate::new();
    let observations = RequestObservations::new();
    let blocked_mock = serve_blocked_archive(
        &server,
        "/blocked.tar.gz",
        body,
        move || {
            started_tx
                .send(())
                .map_err(|e| format!("failed to send blocked start event: {e}"))
        },
        release.waiter(),
        "blocked request".to_owned(),
        observations.clone(),
    );
    let storages = vec![(
        path_to_string(&mount).unwrap(),
        server.url("/blocked.tar.gz"),
    )];
    let execution = spawn_guest_download(
        stringify!(completion_timeout_terminates_child_and_releases_responder),
        &dir,
        &storages,
    )
    .unwrap();

    let started = started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let completion = execution.wait_for_completion(
        stringify!(completion_timeout_terminates_child_and_releases_responder),
        Duration::ZERO,
        &release,
        &observations,
    );

    started.unwrap();
    let error = completion.unwrap_err();
    assert!(error.contains(
        "completion_timeout_terminates_child_and_releases_responder guest-download timed out"
    ));
    assert!(error.contains("started=[\"blocked request\"], active=1, max_active=1"));
    assert!(error.contains("kill=signal sent"));
    assert!(error.contains("reap=completed with"));
    assert!(error.contains("responders=idle"));
    assert_eq!(observations.active(), 0);
    blocked_mock.assert();
}

#[cfg(unix)]
#[test]
fn dropping_unconsumed_execution_terminates_child_and_releases_responder() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("blocked");
    let body = create_tar_gz(&[("state.json", b"blocked")]).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let release = ReleaseGate::new();
    let observations = RequestObservations::new();
    let blocked_mock = serve_blocked_archive(
        &server,
        "/blocked.tar.gz",
        body,
        move || {
            started_tx
                .send(())
                .map_err(|e| format!("failed to send blocked start event: {e}"))
        },
        release.waiter(),
        "blocked request".to_owned(),
        observations.clone(),
    );
    let storages = vec![(
        path_to_string(&mount).unwrap(),
        server.url("/blocked.tar.gz"),
    )];
    let execution = spawn_guest_download(
        stringify!(dropping_unconsumed_execution_terminates_child_and_releases_responder),
        &dir,
        &storages,
    )
    .unwrap();
    let child_id = execution.id().unwrap();

    started_rx.recv_timeout(REQUEST_START_TIMEOUT).unwrap();
    drop(execution);
    release.close();
    observations
        .wait_until_idle(RESPONDER_CLEANUP_TIMEOUT)
        .unwrap();

    process::verify_child_reaped(child_id).unwrap();
    assert_eq!(observations.active(), 0);
    blocked_mock.assert();
}

#[test]
fn queued_independent_download_starts_when_slot_frees() {
    let dir = tempfile::tempdir().unwrap();
    let (event_tx, event_rx) = mpsc::channel();
    let slow_release = ReleaseGate::new();
    let observations = RequestObservations::new();
    let numbered = create_numbered_storages(
        &dir,
        &event_tx,
        |i| (i == 0).then(|| slow_release.waiter()),
        observations.clone(),
    )
    .unwrap();
    let execution = spawn_guest_download(
        stringify!(queued_independent_download_starts_when_slot_frees),
        &dir,
        &numbered.storages,
    )
    .unwrap();

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
    let completion = execution.wait_for_completion(
        stringify!(queued_independent_download_starts_when_slot_frees),
        COMPLETION_TIMEOUT,
        &slow_release,
        &observations,
    );

    slow_started.unwrap();
    queued_started.unwrap();
    completion.unwrap();
    assert!(
        observations.max_active() <= 4,
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
    let observations = RequestObservations::new();
    let numbered = create_numbered_storages(
        &dir,
        &event_tx,
        |_| Some(release.waiter()),
        observations.clone(),
    )
    .unwrap();
    let execution = spawn_guest_download(
        stringify!(download_concurrency_cap_limits_initial_starts),
        &dir,
        &numbered.storages,
    )
    .unwrap();

    let initial_starts = wait_for_events(&event_rx, 4, REQUEST_START_TIMEOUT);
    let fifth_before_release = event_rx.recv_timeout(NEGATIVE_START_TIMEOUT);
    release.release_many(5);
    let completion = execution.wait_for_completion(
        stringify!(download_concurrency_cap_limits_initial_starts),
        COMPLETION_TIMEOUT,
        &release,
        &observations,
    );

    assert_eq!(initial_starts.unwrap().len(), 4);
    assert!(matches!(
        fifth_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    completion.unwrap();
}

#[test]
fn retry_backoff_releases_attempt_slot_but_retains_mount_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let (event_tx, event_rx) = mpsc::channel();
    let retry_release = ReleaseGate::new();
    let observations = RequestObservations::new();
    let parent_mount = dir.path().join("parent");
    let mut storages = Vec::new();
    let mut retry_servers = Vec::new();

    for i in 0..4 {
        let filename = format!("retry-{i}.txt");
        let content = format!("retry-{i}");
        let body = create_tar_gz(&[(&filename, content.as_bytes())]).unwrap();
        let request_name = format!("retry-{i}");
        let retry_server = retry_once_archive_server(
            body,
            event_tx.clone(),
            retry_release.waiter(),
            request_name,
            observations.clone(),
        );
        let mount = if i == 0 {
            parent_mount.clone()
        } else {
            dir.path().join(format!("retry-{i}"))
        };
        storages.push((
            path_to_string(&mount).unwrap(),
            retry_server.0.url("/archive.tar.gz"),
        ));
        retry_servers.push(retry_server);
    }

    let healthy_server = MockServer::start();
    let healthy_mount = dir.path().join("healthy");
    let healthy_body = create_tar_gz(&[("healthy.txt", b"healthy")]).unwrap();
    let healthy_mock = serve_archive(
        &healthy_server,
        "/healthy.tar.gz",
        healthy_body,
        {
            let event_tx = event_tx.clone();
            move || {
                event_tx
                    .send("healthy".to_owned())
                    .map_err(|e| format!("failed to send healthy start: {e}"))
            }
        },
        "healthy".to_owned(),
        observations.clone(),
    );
    storages.push((
        path_to_string(&healthy_mount).unwrap(),
        healthy_server.url("/healthy.tar.gz"),
    ));

    let overlapping_server = MockServer::start();
    let overlapping_mount = parent_mount.join("child");
    let overlapping_body = create_tar_gz(&[("child.txt", b"child")]).unwrap();
    let overlapping_mock = serve_archive(
        &overlapping_server,
        "/overlapping.tar.gz",
        overlapping_body,
        move || {
            event_tx
                .send("overlapping".to_owned())
                .map_err(|e| format!("failed to send overlapping start: {e}"))
        },
        "overlapping".to_owned(),
        observations.clone(),
    );
    storages.push((
        path_to_string(&overlapping_mount).unwrap(),
        overlapping_server.url("/overlapping.tar.gz"),
    ));

    let execution = spawn_guest_download(
        stringify!(retry_backoff_releases_attempt_slot_but_retains_mount_reservation),
        &dir,
        &storages,
    )
    .unwrap();

    let mut initial_starts = wait_for_events(&event_rx, 4, REQUEST_START_TIMEOUT).unwrap();
    initial_starts.sort();
    assert_eq!(
        initial_starts,
        [
            "retry-0-attempt-1",
            "retry-1-attempt-1",
            "retry-2-attempt-1",
            "retry-3-attempt-1",
        ]
    );

    retry_release.release_many(4);
    assert_eq!(
        event_rx.recv_timeout(REQUEST_START_TIMEOUT).unwrap(),
        "healthy"
    );

    let mut seen_events = Vec::new();
    while !seen_events.iter().any(|event| event == "retry-0-attempt-2") {
        let event = event_rx.recv_timeout(REQUEST_START_TIMEOUT).unwrap();
        assert_ne!(
            event, "overlapping",
            "overlapping mount started while its parent retained a retry reservation"
        );
        seen_events.push(event);
    }
    wait_for_event(
        &event_rx,
        &mut seen_events,
        "overlapping",
        REQUEST_START_TIMEOUT,
    )
    .unwrap();
    execution
        .wait_for_completion(
            stringify!(retry_backoff_releases_attempt_slot_but_retains_mount_reservation),
            COMPLETION_TIMEOUT,
            &retry_release,
            &observations,
        )
        .unwrap();

    assert!(observations.max_active() <= 4);
    for (_, attempts) in retry_servers {
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
    healthy_mock.assert_calls(1);
    overlapping_mock.assert_calls(1);
    for i in 0..4 {
        let mount = if i == 0 {
            parent_mount.clone()
        } else {
            dir.path().join(format!("retry-{i}"))
        };
        assert_eq!(
            std::fs::read_to_string(mount.join(format!("retry-{i}.txt"))).unwrap(),
            format!("retry-{i}")
        );
    }
    assert_eq!(
        std::fs::read_to_string(healthy_mount.join("healthy.txt")).unwrap(),
        "healthy"
    );
    assert_eq!(
        std::fs::read_to_string(overlapping_mount.join("child.txt")).unwrap(),
        "child"
    );
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
    let observations = RequestObservations::new();

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
        observations.clone(),
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
        "child request".to_owned(),
        observations.clone(),
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
        "independent request".to_owned(),
        observations.clone(),
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
    let execution = spawn_guest_download(
        stringify!(queued_conflict_does_not_block_later_independent_download),
        &dir,
        &storages,
    )
    .unwrap();

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
    let completion = execution.wait_for_completion(
        stringify!(queued_conflict_does_not_block_later_independent_download),
        COMPLETION_TIMEOUT,
        &parent_release,
        &observations,
    );

    parent_started.unwrap();
    independent_started.unwrap();
    assert!(matches!(
        child_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    child_after_release.unwrap();
    completion.unwrap();
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
    let observations = RequestObservations::new();

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
        observations.clone(),
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
        "child request".to_owned(),
        observations.clone(),
    );

    let url_parent = parent_server.url("/parent.tar.gz");
    let url_child = child_server.url("/child.tar.gz");
    let storages = vec![
        (parent_mount.to_str().unwrap().to_owned(), url_parent),
        (child_mount.to_str().unwrap().to_owned(), url_child),
    ];
    let execution = spawn_guest_download(
        stringify!(parent_child_mount_paths_are_serialized_for_overlapping_archives),
        &dir,
        &storages,
    )
    .unwrap();

    let parent_started = parent_started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let child_before_release = child_started_rx.recv_timeout(NEGATIVE_START_TIMEOUT);
    parent_release.release_one();
    let child_after_release =
        if matches!(child_before_release, Err(mpsc::RecvTimeoutError::Timeout)) {
            child_started_rx.recv_timeout(REQUEST_START_TIMEOUT)
        } else {
            Ok(())
        };
    let completion = execution.wait_for_completion(
        stringify!(parent_child_mount_paths_are_serialized_for_overlapping_archives),
        COMPLETION_TIMEOUT,
        &parent_release,
        &observations,
    );

    parent_started.unwrap();
    assert!(matches!(
        child_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    child_after_release.unwrap();
    completion.unwrap();
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

#[cfg(unix)]
#[test]
fn symlink_aliased_mount_paths_are_serialized_without_blocking_independent_download() {
    let physical_server = MockServer::start();
    let alias_server = MockServer::start();
    let independent_server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let physical_mount = dir.path().join("physical");
    let alias_mount = dir.path().join("alias");
    let independent_mount = dir.path().join("independent");
    std::fs::create_dir_all(&physical_mount).unwrap();
    std::os::unix::fs::symlink(&physical_mount, &alias_mount).unwrap();

    let physical_tar = create_tar_gz(&[("state.json", b"physical")]).unwrap();
    let alias_tar = create_tar_gz(&[("state.json", b"alias")]).unwrap();
    let independent_tar = create_tar_gz(&[("data.txt", b"independent")]).unwrap();
    let (physical_started_tx, physical_started_rx) = mpsc::channel();
    let (alias_started_tx, alias_started_rx) = mpsc::channel();
    let (independent_started_tx, independent_started_rx) = mpsc::channel();
    let physical_release = ReleaseGate::new();
    let observations = RequestObservations::new();

    let physical_mock = serve_blocked_archive(
        &physical_server,
        "/physical.tar.gz",
        physical_tar,
        move || {
            physical_started_tx
                .send(())
                .map_err(|e| format!("failed to send physical start event: {e}"))
        },
        physical_release.waiter(),
        "physical request".to_owned(),
        observations.clone(),
    );
    let alias_mock = serve_archive(
        &alias_server,
        "/alias.tar.gz",
        alias_tar,
        move || {
            alias_started_tx
                .send(())
                .map_err(|e| format!("failed to send alias start event: {e}"))
        },
        "alias request".to_owned(),
        observations.clone(),
    );
    let independent_mock = serve_archive(
        &independent_server,
        "/independent.tar.gz",
        independent_tar,
        move || {
            independent_started_tx
                .send(())
                .map_err(|e| format!("failed to send independent start event: {e}"))
        },
        "independent request".to_owned(),
        observations.clone(),
    );

    let storages = vec![
        (
            path_to_string(&physical_mount).unwrap(),
            physical_server.url("/physical.tar.gz"),
        ),
        (
            path_to_string(&alias_mount).unwrap(),
            alias_server.url("/alias.tar.gz"),
        ),
        (
            path_to_string(&independent_mount).unwrap(),
            independent_server.url("/independent.tar.gz"),
        ),
    ];
    let execution = spawn_guest_download(
        stringify!(
            symlink_aliased_mount_paths_are_serialized_without_blocking_independent_download
        ),
        &dir,
        &storages,
    )
    .unwrap();

    let physical_started = physical_started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let independent_started = independent_started_rx.recv_timeout(REQUEST_START_TIMEOUT);
    let alias_before_release = alias_started_rx.recv_timeout(NEGATIVE_START_TIMEOUT);
    physical_release.release_one();
    let alias_after_release =
        if matches!(alias_before_release, Err(mpsc::RecvTimeoutError::Timeout)) {
            alias_started_rx.recv_timeout(REQUEST_START_TIMEOUT)
        } else {
            Ok(())
        };
    let completion = execution.wait_for_completion(
        stringify!(
            symlink_aliased_mount_paths_are_serialized_without_blocking_independent_download
        ),
        COMPLETION_TIMEOUT,
        &physical_release,
        &observations,
    );

    physical_started.unwrap();
    independent_started.unwrap();
    assert!(matches!(
        alias_before_release,
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    alias_after_release.unwrap();
    completion.unwrap();
    physical_mock.assert();
    alias_mock.assert();
    independent_mock.assert();
    assert_eq!(
        std::fs::read_to_string(physical_mount.join("state.json")).unwrap(),
        "alias"
    );
    assert_eq!(
        std::fs::read_to_string(independent_mount.join("data.txt")).unwrap(),
        "independent"
    );
}
