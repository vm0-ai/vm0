use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::Duration;

use vsock_guest::run;
use vsock_proto::{self, MSG_PING, MSG_PONG, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_WRITE_FILE};

use super::support::{
    finish_guest_connection, join_guest_connection, read_and_discard_message, read_error_response,
    read_message, start_guest_connection, unique_socket_path, unique_tmp_path,
};

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
fn run_sends_shutdown_ack_and_waits_for_disconnect() {
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

    assert_eq!(
        done_rx.recv_timeout(Duration::from_secs(1)),
        Err(mpsc::RecvTimeoutError::Timeout),
        "run() should retain the connection after MSG_SHUTDOWN_ACK",
    );
    drop(host_stream);

    done_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("run() should exit after host disconnect");
    let result = handle.join().unwrap();
    assert!(
        result.is_ok(),
        "shutdown should stop run() cleanly: {result:?}"
    );
}

#[test]
fn shutdown_rejects_non_empty_payload_without_exiting() {
    let (handle, mut host_stream) = start_guest_connection();

    let shutdown = vsock_proto::encode(MSG_SHUTDOWN, 42, b"legacy command payload").unwrap();
    host_stream.write_all(&shutdown).unwrap();

    let error = read_error_response(&mut host_stream, 42);
    assert_eq!(error, "invalid payload: shutdown payload must be empty");

    let ping = vsock_proto::encode(MSG_PING, 43, &[]).unwrap();
    host_stream.write_all(&ping).unwrap();
    let pong = read_message(&mut host_stream);
    assert_eq!(pong.msg_type, MSG_PONG);
    assert_eq!(pong.seq, 43);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn shutdown_ignores_same_buffer_and_later_frames() {
    let (handle, mut host_stream) = start_guest_connection();
    let path = unique_tmp_path("shutdown-followed-by-write-file", ".txt");
    let later_path = unique_tmp_path("shutdown-followed-by-later-write-file", ".txt");
    let write_payload =
        vsock_proto::encode_write_file(path.as_str(), b"should-not-write", false, false)
            .expect("encode write_file");
    let later_write_payload =
        vsock_proto::encode_write_file(later_path.as_str(), b"should-not-write", false, false)
            .expect("encode later write_file");

    let mut batch = vsock_proto::encode(MSG_SHUTDOWN, 50, &[]).unwrap();
    batch.extend_from_slice(&vsock_proto::encode(MSG_WRITE_FILE, 51, &write_payload).unwrap());
    host_stream.write_all(&batch).unwrap();

    let ack = read_message(&mut host_stream);
    assert_eq!(ack.msg_type, MSG_SHUTDOWN_ACK);
    assert_eq!(ack.seq, 50);

    host_stream
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE, 52, &later_write_payload).unwrap())
        .unwrap();
    drop(host_stream);
    join_guest_connection(handle);
    assert!(!Path::new(path.as_str()).exists());
    assert!(!Path::new(later_path.as_str()).exists());
}
