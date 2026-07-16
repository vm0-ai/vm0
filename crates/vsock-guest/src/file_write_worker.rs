use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};

use crate::handlers::{
    decode_write_file_message, decode_write_files_message, handle_decoded_write_file_message,
    handle_decoded_write_files_message,
};
use crate::log::log;
use crate::quiesce::OperationGuard;
use crate::writer::GuestWriter;

const THREAD_FILE_WRITE: &str = "vsock-file-write";

#[derive(Clone, Copy)]
pub(crate) enum FileWriteKind {
    File,
    Files,
}

pub(crate) enum FileWriteSubmitError {
    Busy,
    Disconnected,
}

pub(crate) struct FileWriteAdmission {
    active: Arc<AtomicBool>,
}

impl Drop for FileWriteAdmission {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

struct FileWriteRequest {
    kind: FileWriteKind,
    seq: u32,
    payload: Vec<u8>,
    operation_guard: OperationGuard,
    admission: FileWriteAdmission,
}

pub(crate) struct FileWriteWorker {
    sender: Option<SyncSender<FileWriteRequest>>,
    handle: Option<JoinHandle<()>>,
    active: Arc<AtomicBool>,
    connection_cancel: Arc<AtomicBool>,
}

struct ShutdownConnectionOnDrop(GuestWriter);

impl Drop for ShutdownConnectionOnDrop {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

impl FileWriteWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
    ) -> io::Result<Self> {
        // The atomic admission permit bounds active plus queued work to one.
        // The channel still has capacity so the decoder can use try_send and
        // can never wait for the worker to call recv.
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker_cancel = Arc::clone(&connection_cancel);
        let handle = thread::Builder::new()
            .name(THREAD_FILE_WRITE.to_string())
            .spawn(move || {
                // This worker exists for exactly one connection. Any exit,
                // including an unwind, closes that connection so a pending
                // host request cannot wait without a response producer.
                let _shutdown_on_exit = ShutdownConnectionOnDrop(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) = handle_request(request, &writer, &worker_cancel) {
                        log("ERROR", &format!("file-write worker failed: {error}"));
                        break;
                    }
                }
            })?;

        Ok(Self {
            sender: Some(sender),
            handle: Some(handle),
            active: Arc::new(AtomicBool::new(false)),
            connection_cancel,
        })
    }

    pub(crate) fn try_admit(&self) -> Option<FileWriteAdmission> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| FileWriteAdmission {
                active: Arc::clone(&self.active),
            })
    }

    pub(crate) fn submit(
        &self,
        kind: FileWriteKind,
        seq: u32,
        payload: &[u8],
        operation_guard: OperationGuard,
        admission: FileWriteAdmission,
    ) -> Result<(), FileWriteSubmitError> {
        let request = FileWriteRequest {
            kind,
            seq,
            payload: payload.to_vec(),
            operation_guard,
            admission,
        };
        let Some(sender) = &self.sender else {
            return Err(FileWriteSubmitError::Disconnected);
        };
        match sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(FileWriteSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => Err(FileWriteSubmitError::Disconnected),
        }
    }
}

impl Drop for FileWriteWorker {
    fn drop(&mut self) {
        // Signal first so an active helper's cancellable wait kills and reaps
        // its process group before this connection-owned worker is joined.
        self.connection_cancel.store(true, Ordering::Release);
        drop(self.sender.take());
        if let Some(handle) = self.handle.take()
            && handle.join().is_err()
        {
            log("ERROR", "file-write worker panicked");
        }
    }
}

fn handle_request(
    request: FileWriteRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
) -> io::Result<()> {
    let FileWriteRequest {
        kind,
        seq,
        payload,
        operation_guard,
        admission,
    } = request;

    let response = match kind {
        FileWriteKind::File => decode_write_file_message(&payload)
            .map_err(protocol_error)
            .and_then(|decoded| handle_decoded_write_file_message(seq, decoded, connection_cancel)),
        FileWriteKind::Files => decode_write_files_message(&payload)
            .map_err(protocol_error)
            .and_then(|decoded| {
                handle_decoded_write_files_message(seq, decoded, connection_cancel)
            }),
    };
    // Admission may be released at the writer boundary, but do not retain the
    // completed request's large payload while the result frame is being sent.
    drop(payload);

    match response {
        Ok(response) => writer
            .write_frame_after_lock_unless_cancelled(&response, connection_cancel, || {
                operation_guard.release();
                drop(admission);
            })
            .map(|_| ()),
        Err(error) => {
            writer.shutdown_after_lock(|| {
                operation_guard.release();
                drop(admission);
            });
            Err(error)
        }
    }
}

fn protocol_error(error: vsock_proto::ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
