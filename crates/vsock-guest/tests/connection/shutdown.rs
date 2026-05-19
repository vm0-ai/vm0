use std::io::Write;
use std::thread;
use std::time::Duration;

use vsock_guest::run;
use vsock_proto::{self, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK};

use super::support::{read_and_discard_message, read_message, unique_socket_path};

#[test]
fn run_exits_after_shutdown_even_when_ack_write_fails() {
    use std::net::Shutdown;
    use std::os::unix::net::UnixListener;

    let socket_path = unique_socket_path("shutdown-failed-ack");
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();

    let guest_socket_path = socket_path.as_str().to_owned();
    let handle = thread::spawn(move || run(Some(&guest_socket_path)));

    let (mut host_stream, _) = listener.accept().unwrap();
    drop(listener);
    read_and_discard_message(&mut host_stream);

    host_stream.shutdown(Shutdown::Read).unwrap();
    let msg = vsock_proto::encode(MSG_SHUTDOWN, 1, &[]).unwrap();
    host_stream.write_all(&msg).unwrap();

    // Refuse the ACK write before delivering MSG_SHUTDOWN. The write half is
    // still open, so the shutdown request is delivered, but the guest's final
    // ACK write fails with EPIPE/BrokenPipe.
    drop(host_stream);

    let result = handle.join().unwrap();
    assert!(
        result.is_ok(),
        "shutdown should stop run() cleanly even if ACK write fails: {result:?}",
    );
}

#[test]
fn run_sends_shutdown_ack_and_exits_without_waiting_for_disconnect() {
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    let socket_path = unique_socket_path("shutdown-ack");
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();

    let guest_socket_path = socket_path.as_str().to_owned();
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let result = run(Some(&guest_socket_path));
        let _ = done_tx.send(());
        result
    });

    let (mut host_stream, _) = listener.accept().unwrap();
    drop(listener);
    read_and_discard_message(&mut host_stream);

    let msg = vsock_proto::encode(MSG_SHUTDOWN, 42, &[]).unwrap();
    host_stream.write_all(&msg).unwrap();

    let ack = read_message(&mut host_stream);
    assert_eq!(ack.msg_type, MSG_SHUTDOWN_ACK);
    assert_eq!(ack.seq, 42);

    let finished_before_disconnect = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    drop(host_stream);

    let result = handle.join().unwrap();
    assert!(
        finished_before_disconnect,
        "run() should exit after MSG_SHUTDOWN without waiting for host disconnect",
    );
    assert!(
        result.is_ok(),
        "shutdown should stop run() cleanly: {result:?}"
    );
}
