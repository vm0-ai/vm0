use crate::support::{create_tar_gz, run_guest_download, write_manifest};
use httpmock::prelude::*;
use httpmock::{HttpMockRequest, HttpMockResponse};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

fn gzip_response(body: Vec<u8>) -> HttpMockResponse {
    HttpMockResponse::builder()
        .status(200)
        .header("content-type", "application/gzip")
        .body(body)
        .build()
}

struct ActiveRequestGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn track_active_request(
    active: &Arc<AtomicUsize>,
    max_active: &Arc<AtomicUsize>,
) -> ActiveRequestGuard {
    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
    let mut observed = max_active.load(Ordering::SeqCst);
    while current > observed {
        match max_active.compare_exchange(observed, current, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => break,
            Err(actual) => observed = actual,
        }
    }

    ActiveRequestGuard {
        active: Arc::clone(active),
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

struct ReleaseOnDrop {
    sender: mpsc::Sender<()>,
    count: usize,
}

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        for _ in 0..self.count {
            let _ = self.sender.send(());
        }
    }
}

#[test]
fn queued_independent_download_starts_when_slot_frees() {
    let dir = tempfile::tempdir().unwrap();
    let (event_tx, event_rx) = mpsc::channel();
    let (slow_release_tx, slow_release_rx) = mpsc::channel();
    let _slow_release_guard = ReleaseOnDrop {
        sender: slow_release_tx.clone(),
        count: 1,
    };
    let slow_release_rx = Arc::new(Mutex::new(slow_release_rx));
    let active = Arc::new(AtomicUsize::new(0));
    let max_active = Arc::new(AtomicUsize::new(0));

    let mut servers = Vec::new();
    let mut storages = Vec::new();

    for i in 0..5 {
        let server = MockServer::start();
        let filename = format!("file_{i}.txt");
        let content = format!("content_{i}");
        let body = Arc::new(create_tar_gz(&[(&filename, content.as_bytes())]).unwrap());
        let event_tx = event_tx.clone();
        let active = Arc::clone(&active);
        let max_active = Arc::clone(&max_active);
        let slow_release_rx = Arc::clone(&slow_release_rx);

        server.mock(move |when, then| {
            when.method(GET).path("/storage.tar.gz");
            then.respond_with(move |_req: &HttpMockRequest| {
                let _active_guard = track_active_request(&active, &max_active);
                let _ = event_tx.send(format!("start-{i}"));
                if i == 0 {
                    slow_release_rx
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(10))
                        .expect("timed out waiting to release slow request");
                }
                gzip_response((*body).clone())
            });
        });

        let mount = dir.path().join(format!("mount_{i}"));
        storages.push((
            mount.to_str().unwrap().to_owned(),
            server.url("/storage.tar.gz"),
        ));
        servers.push(server);
    }

    let storage_refs: Vec<(&str, Option<&str>)> = storages
        .iter()
        .map(|(mount, url)| (mount.as_str(), Some(url.as_str())))
        .collect();
    let manifest = write_manifest(&dir, &storage_refs, None).unwrap();
    let manifest_path = manifest.to_str().unwrap().to_owned();
    let handle = std::thread::spawn(move || run_guest_download(&manifest_path));

    let mut seen_events = Vec::new();
    let slow_started = wait_for_event(
        &event_rx,
        &mut seen_events,
        "start-0",
        Duration::from_secs(5),
    );
    let queued_started = wait_for_event(
        &event_rx,
        &mut seen_events,
        "start-4",
        Duration::from_secs(5),
    );
    slow_release_tx.send(()).unwrap();
    let result = handle.join().unwrap();

    slow_started.unwrap();
    queued_started.unwrap();
    assert!(result);
    assert!(
        max_active.load(Ordering::SeqCst) <= 4,
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
    let (release_tx, release_rx) = mpsc::channel();
    let _release_guard = ReleaseOnDrop {
        sender: release_tx.clone(),
        count: 5,
    };
    let release_rx = Arc::new(Mutex::new(release_rx));
    let mut servers = Vec::new();
    let mut storages = Vec::new();

    for i in 0..5 {
        let server = MockServer::start();
        let filename = format!("file_{i}.txt");
        let content = format!("content_{i}");
        let body = Arc::new(create_tar_gz(&[(&filename, content.as_bytes())]).unwrap());
        let event_tx = event_tx.clone();
        let release_rx = Arc::clone(&release_rx);

        server.mock(move |when, then| {
            when.method(GET).path("/storage.tar.gz");
            then.respond_with(move |_req: &HttpMockRequest| {
                let _ = event_tx.send(format!("start-{i}"));
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .expect("timed out waiting to release blocked request");
                gzip_response((*body).clone())
            });
        });

        let mount = dir.path().join(format!("mount_{i}"));
        storages.push((
            mount.to_str().unwrap().to_owned(),
            server.url("/storage.tar.gz"),
        ));
        servers.push(server);
    }

    let storage_refs: Vec<(&str, Option<&str>)> = storages
        .iter()
        .map(|(mount, url)| (mount.as_str(), Some(url.as_str())))
        .collect();
    let manifest = write_manifest(&dir, &storage_refs, None).unwrap();
    let manifest_path = manifest.to_str().unwrap().to_owned();
    let handle = std::thread::spawn(move || run_guest_download(&manifest_path));

    let initial_starts = wait_for_events(&event_rx, 4, Duration::from_secs(5));
    let fifth_before_release = event_rx.recv_timeout(Duration::from_millis(300));
    for _ in 0..5 {
        release_tx.send(()).unwrap();
    }
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
    let (parent_release_tx, parent_release_rx) = mpsc::channel();
    let _parent_release_guard = ReleaseOnDrop {
        sender: parent_release_tx.clone(),
        count: 1,
    };
    let parent_release_rx = Arc::new(Mutex::new(parent_release_rx));

    let parent_release_rx_for_mock = Arc::clone(&parent_release_rx);
    parent_server.mock(move |when, then| {
        when.method(GET).path("/parent.tar.gz");
        then.respond_with(move |_req: &HttpMockRequest| {
            parent_started_tx.send(()).unwrap();
            parent_release_rx_for_mock
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .expect("timed out waiting to release parent request");
            gzip_response(parent_tar.clone())
        });
    });
    child_server.mock(move |when, then| {
        when.method(GET).path("/child.tar.gz");
        then.respond_with(move |_req: &HttpMockRequest| {
            child_started_tx.send(()).unwrap();
            gzip_response(child_tar.clone())
        });
    });
    independent_server.mock(move |when, then| {
        when.method(GET).path("/independent.tar.gz");
        then.respond_with(move |_req: &HttpMockRequest| {
            independent_started_tx.send(()).unwrap();
            gzip_response(independent_tar.clone())
        });
    });

    let url_parent = parent_server.url("/parent.tar.gz");
    let url_child = child_server.url("/child.tar.gz");
    let url_independent = independent_server.url("/independent.tar.gz");
    let storages: Vec<(&str, Option<&str>)> = vec![
        (parent_mount.to_str().unwrap(), Some(&url_parent)),
        (child_mount.to_str().unwrap(), Some(&url_child)),
        (independent_mount.to_str().unwrap(), Some(&url_independent)),
    ];
    let manifest = write_manifest(&dir, &storages, None).unwrap();
    let manifest_path = manifest.to_str().unwrap().to_owned();
    let handle = std::thread::spawn(move || run_guest_download(&manifest_path));

    let parent_started = parent_started_rx.recv_timeout(Duration::from_secs(5));
    let independent_started = independent_started_rx.recv_timeout(Duration::from_secs(5));
    let child_before_release = child_started_rx.recv_timeout(Duration::from_millis(300));
    parent_release_tx.send(()).unwrap();
    let child_after_release =
        if matches!(child_before_release, Err(mpsc::RecvTimeoutError::Timeout)) {
            child_started_rx.recv_timeout(Duration::from_secs(5))
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
    let (parent_release_tx, parent_release_rx) = mpsc::channel();
    let _parent_release_guard = ReleaseOnDrop {
        sender: parent_release_tx.clone(),
        count: 1,
    };
    let parent_release_rx = Arc::new(Mutex::new(parent_release_rx));

    let parent_release_rx_for_mock = Arc::clone(&parent_release_rx);
    let m_parent = parent_server.mock(move |when, then| {
        when.method(GET).path("/parent.tar.gz");
        then.respond_with(move |_req: &HttpMockRequest| {
            parent_started_tx.send(()).unwrap();
            parent_release_rx_for_mock
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .expect("timed out waiting to release parent request");
            gzip_response(parent_tar.clone())
        });
    });
    let m_child = child_server.mock(move |when, then| {
        when.method(GET).path("/child.tar.gz");
        then.respond_with(move |_req: &HttpMockRequest| {
            child_started_tx.send(()).unwrap();
            gzip_response(child_tar.clone())
        });
    });

    let url_parent = parent_server.url("/parent.tar.gz");
    let url_child = child_server.url("/child.tar.gz");
    let storages: Vec<(&str, Option<&str>)> = vec![
        (parent_mount.to_str().unwrap(), Some(&url_parent)),
        (child_mount.to_str().unwrap(), Some(&url_child)),
    ];
    let manifest = write_manifest(&dir, &storages, None).unwrap();
    let manifest_path = manifest.to_str().unwrap().to_owned();
    let handle = std::thread::spawn(move || run_guest_download(&manifest_path));

    let parent_started = parent_started_rx.recv_timeout(Duration::from_secs(5));
    let child_before_release = child_started_rx.recv_timeout(Duration::from_millis(300));
    parent_release_tx.send(()).unwrap();
    let child_after_release =
        if matches!(child_before_release, Err(mpsc::RecvTimeoutError::Timeout)) {
            child_started_rx.recv_timeout(Duration::from_secs(5))
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
