use std::thread;
use std::time::Duration;

use vsock_guest::handle_connection;

use super::protocol::read_and_discard_message;

pub(crate) fn start_guest_connection() -> (thread::JoinHandle<()>, std::os::unix::net::UnixStream) {
    let (guest_stream, mut host_stream) = std::os::unix::net::UnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    (handle, host_stream)
}

pub(crate) fn finish_guest_connection(
    handle: thread::JoinHandle<()>,
    host_stream: std::os::unix::net::UnixStream,
) {
    drop(host_stream);
    let _ = handle.join();
}
