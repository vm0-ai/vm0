use std::io;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;

use crate::log::log;

use super::sink::ControlSinkState;
use super::{
    CONTROL_ACCEPT_POLL_TIMEOUT, CONTROL_SINK_IO_TIMEOUT, EXEC_CONTROL_LOG_NAME,
    THREAD_EXEC_CONTROL_ACCEPT, is_timeout,
};

pub(super) fn start_control_sink_accept_thread(
    endpoint: &str,
    sink: Arc<ControlSinkState>,
) -> io::Result<()> {
    let listener = process_control_ipc::bind_abstract_listener(endpoint)?;
    thread::Builder::new()
        .name(THREAD_EXEC_CONTROL_ACCEPT.to_owned())
        .spawn(move || accept_control_sink(listener, sink))?;
    Ok(())
}

fn accept_control_sink(listener: std::os::unix::net::UnixListener, sink: Arc<ControlSinkState>) {
    let result = loop {
        if !sink.active.load(Ordering::Acquire) {
            return;
        }
        match process_control_ipc::accept_with_timeout(&listener, CONTROL_ACCEPT_POLL_TIMEOUT) {
            Ok(mut stream) => {
                match sink.begin_handshake(&stream) {
                    Ok(true) => {}
                    Ok(false) => return,
                    Err(error) => break Err(error),
                }
                break stream
                    .set_read_timeout(Some(CONTROL_SINK_IO_TIMEOUT))
                    .and_then(|()| stream.set_write_timeout(Some(CONTROL_SINK_IO_TIMEOUT)))
                    .and_then(|()| process_control_ipc::read_hello(&mut stream))
                    .map(|()| stream);
            }
            Err(error) if is_timeout(&error) => continue,
            Err(error) => break Err(error),
        }
    };
    match result {
        Ok(stream) => {
            log(
                "INFO",
                &format!("{EXEC_CONTROL_LOG_NAME}: control sink connected"),
            );
            sink.connect(stream);
        }
        Err(error) => {
            log(
                "WARN",
                &format!("{EXEC_CONTROL_LOG_NAME}: control sink accept failed: {error}"),
            );
            sink.fail(error.to_string());
        }
    }
}
