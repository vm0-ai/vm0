use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use vsock_guest::run;
use vsock_proto::{
    self, MSG_OPERATIONS_RESUMED, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK,
};

use super::support::{
    read_and_discard_message, read_message, send_resume_operations, unique_socket_path,
};

const EXPECTED_RECONNECT_ATTEMPTS: usize = 50;
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(100);

type RunReport = Result<(), (io::ErrorKind, String)>;

#[test]
fn run_exhausts_reconnect_attempts_after_immediate_disconnects() {
    assert_run_exhausts_after_short_lived_connections(
        "reconnect-immediate-disconnect",
        read_and_discard_message,
    );
}

#[test]
fn run_exhausts_reconnect_attempts_after_ping_only_disconnects() {
    assert_run_exhausts_after_short_lived_connections("reconnect-ping-only-disconnect", |stream| {
        read_and_discard_message(stream);

        let ping = vsock_proto::encode(MSG_PING, 7, &[]).unwrap();
        stream.write_all(&ping).unwrap();
        let pong = read_message(stream);
        assert_eq!(pong.msg_type, MSG_PONG);
        assert_eq!(pong.seq, 7);
    });
}

#[test]
fn run_resets_reconnect_attempts_after_real_host_work() {
    let socket_path = unique_socket_path("reconnect-real-work-reset");
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();
    let (done_rx, handle) = spawn_run_thread(socket_path.as_str());

    for accepted in 1..EXPECTED_RECONNECT_ATTEMPTS {
        let mut host_stream = accept_run_connection(&listener, &done_rx, accepted);
        host_stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        read_and_discard_message(&mut host_stream);
        drop(host_stream);
        assert_run_still_running(&done_rx, accepted);
    }

    let mut real_work_stream =
        accept_run_connection(&listener, &done_rx, EXPECTED_RECONNECT_ATTEMPTS);
    real_work_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    read_and_discard_message(&mut real_work_stream);
    send_resume_operations(&mut real_work_stream, 9);
    let resumed = read_message(&mut real_work_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 9);
    drop(real_work_stream);

    let mut shutdown_stream =
        accept_run_connection(&listener, &done_rx, EXPECTED_RECONNECT_ATTEMPTS + 1);
    shutdown_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    read_and_discard_message(&mut shutdown_stream);
    let shutdown = vsock_proto::encode(MSG_SHUTDOWN, 10, &[]).unwrap();
    shutdown_stream.write_all(&shutdown).unwrap();
    let ack = read_message(&mut shutdown_stream);
    assert_eq!(ack.msg_type, MSG_SHUTDOWN_ACK);
    assert_eq!(ack.seq, 10);

    let report = done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(shutdown_stream);
    drop(listener);
    assert_eq!(report, Ok(()));
    handle.join().unwrap().unwrap();
}

fn assert_run_exhausts_after_short_lived_connections(
    label: &str,
    mut handle_connection: impl FnMut(&mut UnixStream),
) {
    let socket_path = unique_socket_path(label);
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();

    let (done_rx, handle) = spawn_run_thread(socket_path.as_str());

    for accepted in 1..=EXPECTED_RECONNECT_ATTEMPTS {
        let mut host_stream = accept_run_connection(&listener, &done_rx, accepted);
        host_stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        handle_connection(&mut host_stream);
        drop(host_stream);

        if accepted < EXPECTED_RECONNECT_ATTEMPTS {
            assert_run_still_running(&done_rx, accepted);
        }
    }

    let report = match done_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(report) => report,
        Err(error) => {
            drain_pending_connections(&listener);
            drop(listener);
            let _ = std::fs::remove_file(socket_path.as_str());
            let result = handle.join().unwrap();
            panic!(
                "run() did not exit after {EXPECTED_RECONNECT_ATTEMPTS} short-lived connections: wait_error={error}, result={result:?}"
            );
        }
    };
    drop(listener);

    let error = handle.join().unwrap().expect_err("run() should fail");
    assert_eq!(
        report,
        Err((io::ErrorKind::ConnectionReset, error.to_string()))
    );
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(error.to_string(), "Max reconnect attempts reached");
}

fn spawn_run_thread(socket_path: &str) -> (mpsc::Receiver<RunReport>, JoinHandle<io::Result<()>>) {
    let guest_socket_path = socket_path.to_owned();
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let result = run(Some(&guest_socket_path));
        let report = result
            .as_ref()
            .map(|_| ())
            .map_err(|error| (error.kind(), error.to_string()));
        let _ = done_tx.send(report);
        result
    });
    (done_rx, handle)
}

fn accept_run_connection(
    listener: &UnixListener,
    done_rx: &mpsc::Receiver<RunReport>,
    attempt: usize,
) -> UnixStream {
    let deadline = Instant::now()
        .checked_add(ACCEPT_TIMEOUT)
        .expect("accept timeout overflowed");

    loop {
        assert_run_still_running(done_rx, attempt.saturating_sub(1));

        let now = Instant::now();
        if now >= deadline {
            panic!("run() did not open reconnect attempt {attempt} within {ACCEPT_TIMEOUT:?}");
        }

        if listener_has_pending_connection(listener, deadline.saturating_duration_since(now))
            .unwrap()
        {
            return listener.accept().unwrap().0;
        }
    }
}

fn assert_run_still_running(done_rx: &mpsc::Receiver<RunReport>, completed_attempts: usize) {
    match done_rx.try_recv() {
        Ok(report) => panic!(
            "run() exited after {completed_attempts} reconnect attempts before exhausting expected attempts: {report:?}"
        ),
        Err(mpsc::TryRecvError::Disconnected) => {
            panic!("run() exited without reporting after {completed_attempts} reconnect attempts")
        }
        Err(mpsc::TryRecvError::Empty) => {}
    }
}

fn listener_has_pending_connection(
    listener: &UnixListener,
    remaining: Duration,
) -> io::Result<bool> {
    let timeout = std::cmp::min(remaining, ACCEPT_POLL_INTERVAL)
        .as_millis()
        .max(1) as libc::c_int;
    let mut pollfd = libc::pollfd {
        fd: listener.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: pollfd points to one initialized listener descriptor entry, and
    // the timeout is a bounded non-negative millisecond value.
    let result = unsafe { libc::poll(&mut pollfd, 1 as libc::nfds_t, timeout) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    if result == 0 {
        return Ok(false);
    }
    if pollfd.revents & libc::POLLNVAL != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "listener fd is invalid",
        ));
    }
    if pollfd.revents & (libc::POLLERR | libc::POLLHUP) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "listener is no longer accepting connections",
        ));
    }
    Ok(pollfd.revents & libc::POLLIN != 0)
}

fn drain_pending_connections(listener: &UnixListener) {
    listener.set_nonblocking(true).unwrap();
    loop {
        match listener.accept() {
            Ok((stream, _)) => drop(stream),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
}
