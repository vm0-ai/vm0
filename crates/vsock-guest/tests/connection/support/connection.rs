use std::os::unix::net::UnixStream;
use std::thread;
use std::time::Duration;

use vsock_guest::handle_connection;

use super::protocol::read_and_discard_message;

pub(crate) type GuestConnectionHandle = thread::JoinHandle<std::io::Result<()>>;

pub(crate) fn start_guest_connection() -> (GuestConnectionHandle, UnixStream) {
    let (guest_stream, mut host_stream) = UnixStream::pair().unwrap();
    let handle = thread::spawn(move || handle_connection(guest_stream));
    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    (handle, host_stream)
}

pub(crate) fn finish_guest_connection(handle: GuestConnectionHandle, host_stream: UnixStream) {
    drop(host_stream);
    join_guest_connection(handle);
}

pub(crate) fn join_guest_connection(handle: GuestConnectionHandle) {
    let result = handle.join().expect("guest connection thread panicked");
    result.expect("guest connection handler returned an error");
}
