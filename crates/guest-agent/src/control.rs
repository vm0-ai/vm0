use std::io;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use guest_common::{log_info, log_warn};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct ControlHandle {
    join: Option<thread::JoinHandle<()>>,
    stream: Arc<Mutex<Option<UnixStream>>>,
    shutdown: CancellationToken,
}

struct StreamSlotCleanup {
    stream: Arc<Mutex<Option<UnixStream>>>,
}

impl Drop for StreamSlotCleanup {
    fn drop(&mut self) {
        let _ = self.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

impl ControlHandle {
    pub fn spawn(shutdown: CancellationToken) -> Option<Self> {
        let endpoint = match std::env::var(process_control_ipc::BOOTSTRAP_ENV) {
            Ok(endpoint) if !endpoint.is_empty() => endpoint,
            _ => return None,
        };
        Self::spawn_endpoint(endpoint, shutdown)
    }

    fn spawn_endpoint(endpoint: String, shutdown: CancellationToken) -> Option<Self> {
        let stream = Arc::new(Mutex::new(None));
        let worker_stream = Arc::clone(&stream);
        let worker_shutdown = shutdown.clone();
        let join = thread::Builder::new()
            .name("guest-agent-process-control".to_owned())
            .spawn(move || run(endpoint, worker_shutdown, worker_stream))
            .map_err(|error| {
                log_warn!(LOG_TAG, "Process control task failed to start: {error}");
            })
            .ok()?;
        Some(Self {
            join: Some(join),
            stream,
            shutdown,
        })
    }

    pub fn join(mut self) {
        self.shutdown_and_join();
    }

    fn shutdown_and_join(&mut self) {
        self.shutdown.cancel();
        let stream = self.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(stream) = stream {
            let _ = stream.shutdown(Shutdown::Both);
        }
        if let Some(join) = self.join.take()
            && let Err(error) = join.join()
        {
            log_warn!(LOG_TAG, "Process control task panicked: {error:?}");
        }
    }
}

impl Drop for ControlHandle {
    fn drop(&mut self) {
        self.shutdown_and_join();
    }
}

fn run(endpoint: String, shutdown: CancellationToken, stream_slot: Arc<Mutex<Option<UnixStream>>>) {
    match run_inner(&endpoint, shutdown, stream_slot) {
        Ok(()) => log_info!(LOG_TAG, "Process control task stopped"),
        Err(error) => log_warn!(LOG_TAG, "Process control task stopped: {error}"),
    }
}

fn run_inner(
    endpoint: &str,
    shutdown: CancellationToken,
    stream_slot: Arc<Mutex<Option<UnixStream>>>,
) -> io::Result<()> {
    let mut stream = process_control_ipc::connect_abstract(endpoint)?;
    let shutdown_stream = stream.try_clone()?;
    *stream_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(shutdown_stream);
    let _stream_slot_cleanup = StreamSlotCleanup {
        stream: Arc::clone(&stream_slot),
    };
    stream.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT))?;
    process_control_ipc::write_hello(&mut stream)?;
    log_info!(LOG_TAG, "Process control task connected");

    while !shutdown.is_cancelled() {
        match process_control_ipc::read_request(&mut stream) {
            Ok(request) => {
                process_control_ipc::write_response(
                    &mut stream,
                    &process_control_ipc::ControlResponse {
                        message_id: request.message_id,
                        status: process_control_ipc::ControlResponseStatus::Accepted,
                        diagnostic: String::new(),
                    },
                )?;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_task_accepts_request_until_shutdown() {
        let nonce = *b"0123456789abcdef";
        let endpoint = process_control_ipc::endpoint_name(42, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let stream_slot = Arc::new(Mutex::new(None));
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || run_inner(&endpoint, worker_shutdown, stream_slot)
        });

        let mut stream =
            process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1))
                .expect("control task should connect");
        process_control_ipc::read_hello(&mut stream).unwrap();
        process_control_ipc::write_request(
            &mut stream,
            &process_control_ipc::ControlRequest {
                message_id: "msg-1".to_owned(),
                payload: b"opaque".to_vec(),
            },
        )
        .unwrap();
        let response = process_control_ipc::read_response(&mut stream).unwrap();
        assert_eq!(response.message_id, "msg-1");
        assert_eq!(
            response.status,
            process_control_ipc::ControlResponseStatus::Accepted
        );

        shutdown.cancel();
        drop(stream);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn control_handle_join_wakes_idle_reader() {
        let nonce = *b"fedcba9876543210";
        let endpoint = process_control_ipc::endpoint_name(43, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let handle = ControlHandle::spawn_endpoint(endpoint, shutdown).unwrap();

        let mut stream =
            process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1))
                .expect("control task should connect");
        process_control_ipc::read_hello(&mut stream).unwrap();

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let joiner = thread::spawn(move || {
            handle.join();
            done_tx.send(()).unwrap();
        });

        if let Err(error) = done_rx.recv_timeout(Duration::from_secs(1)) {
            drop(stream);
            joiner.join().unwrap();
            panic!("control handle join should wake idle reader: {error}");
        }
        joiner.join().unwrap();
    }

    #[test]
    fn control_handle_drop_wakes_idle_reader() {
        let nonce = *b"0011223344556677";
        let endpoint = process_control_ipc::endpoint_name(45, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let handle = ControlHandle::spawn_endpoint(endpoint, shutdown).unwrap();

        let mut stream =
            process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1))
                .expect("control task should connect");
        process_control_ipc::read_hello(&mut stream).unwrap();

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let dropper = thread::spawn(move || {
            drop(handle);
            done_tx.send(()).unwrap();
        });

        if let Err(error) = done_rx.recv_timeout(Duration::from_secs(1)) {
            drop(stream);
            dropper.join().unwrap();
            panic!("control handle drop should wake idle reader: {error}");
        }
        dropper.join().unwrap();
    }

    #[test]
    fn control_task_clears_shutdown_stream_when_reader_exits() {
        let nonce = *b"8899aabbccddeeff";
        let endpoint = process_control_ipc::endpoint_name(44, &nonce);
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let stream_slot = Arc::new(Mutex::new(None));
        let worker_slot = Arc::clone(&stream_slot);
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || run_inner(&endpoint, shutdown, worker_slot)
        });

        let mut stream =
            process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(1))
                .expect("control task should connect");
        process_control_ipc::read_hello(&mut stream).unwrap();
        drop(stream);

        worker.join().unwrap().unwrap();
        assert!(
            stream_slot
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none()
        );
    }
}
