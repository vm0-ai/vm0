use std::io;
use std::thread;
use std::time::Duration;

use guest_common::{log_info, log_warn};
use tokio_util::sync::CancellationToken;

const LOG_TAG: &str = "sandbox:guest-agent";
const CONTROL_READ_TIMEOUT: Duration = Duration::from_millis(200);
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct ControlHandle {
    join: Option<thread::JoinHandle<()>>,
}

impl ControlHandle {
    pub fn spawn(shutdown: CancellationToken) -> Option<Self> {
        let endpoint = match std::env::var(guest_control::BOOTSTRAP_ENV) {
            Ok(endpoint) if !endpoint.is_empty() => endpoint,
            _ => return None,
        };
        let join = thread::Builder::new()
            .name("guest-agent-process-control".to_owned())
            .spawn(move || run(endpoint, shutdown))
            .map_err(|error| {
                log_warn!(LOG_TAG, "Process control task failed to start: {error}");
            })
            .ok()?;
        Some(Self { join: Some(join) })
    }

    pub fn join(mut self) {
        if let Some(join) = self.join.take()
            && let Err(error) = join.join()
        {
            log_warn!(LOG_TAG, "Process control task panicked: {error:?}");
        }
    }
}

fn run(endpoint: String, shutdown: CancellationToken) {
    match run_inner(&endpoint, shutdown) {
        Ok(()) => log_info!(LOG_TAG, "Process control task stopped"),
        Err(error) => log_warn!(LOG_TAG, "Process control task stopped: {error}"),
    }
}

fn run_inner(endpoint: &str, shutdown: CancellationToken) -> io::Result<()> {
    let mut stream = guest_control::connect_abstract(endpoint)?;
    stream.set_read_timeout(Some(CONTROL_READ_TIMEOUT))?;
    stream.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT))?;
    guest_control::write_hello(&mut stream)?;
    log_info!(LOG_TAG, "Process control task connected");

    while !shutdown.is_cancelled() {
        match guest_control::read_request(&mut stream) {
            Ok(request) => {
                guest_control::write_response(
                    &mut stream,
                    &guest_control::ControlResponse {
                        message_id: request.message_id,
                        status: guest_control::ControlResponseStatus::Accepted,
                        diagnostic: String::new(),
                    },
                )?;
            }
            Err(error) if is_timeout(&error) => continue,
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

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_task_accepts_request_until_shutdown() {
        let nonce = *b"0123456789abcdef";
        let endpoint = guest_control::endpoint_name(42, &nonce);
        let listener = guest_control::bind_abstract_listener(&endpoint).unwrap();
        let shutdown = CancellationToken::new();
        let worker_shutdown = shutdown.clone();
        let worker = thread::spawn({
            let endpoint = endpoint.clone();
            move || run_inner(&endpoint, worker_shutdown)
        });

        let mut stream = guest_control::accept_with_timeout(&listener, Duration::from_secs(1))
            .expect("control task should connect");
        guest_control::read_hello(&mut stream).unwrap();
        guest_control::write_request(
            &mut stream,
            &guest_control::ControlRequest {
                message_id: "msg-1".to_owned(),
                payload: b"opaque".to_vec(),
            },
        )
        .unwrap();
        let response = guest_control::read_response(&mut stream).unwrap();
        assert_eq!(response.message_id, "msg-1");
        assert_eq!(
            response.status,
            guest_control::ControlResponseStatus::Accepted
        );

        shutdown.cancel();
        drop(stream);
        worker.join().unwrap().unwrap();
    }
}
