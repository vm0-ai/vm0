use std::os::unix::net::UnixStream;
use std::thread;
use std::time::Duration;

use vsock_guest::{
    handle_connection_with_test_process_containment,
    handle_connection_with_test_process_containment_and_exec_drain_deadline,
};

use super::protocol::read_and_discard_message;

pub(crate) type GuestConnectionHandle = thread::JoinHandle<std::io::Result<()>>;

pub(crate) fn start_guest_connection() -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(handle_connection_with_test_process_containment)
}

pub(crate) fn start_guest_connection_with_exec_drain_deadline(
    exec_drain_deadline: Duration,
) -> (GuestConnectionHandle, UnixStream) {
    start_guest_connection_with_handler(move |stream| {
        handle_connection_with_test_process_containment_and_exec_drain_deadline(
            stream,
            exec_drain_deadline,
        )
    })
}

fn start_guest_connection_with_handler(
    handler: impl FnOnce(UnixStream) -> std::io::Result<()> + Send + 'static,
) -> (GuestConnectionHandle, UnixStream) {
    let (guest_stream, mut host_stream) = UnixStream::pair().unwrap();
    let handle = thread::spawn(move || handler(guest_stream));
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
