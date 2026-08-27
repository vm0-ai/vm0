use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;

use process_control_ipc::{
    read_workload_placement_confirmation, receive_workload_placement,
    write_workload_placement_confirmation,
};

const WORKLOAD_PLACEMENT_MARKER: u8 = 0x57;
const RECEIVER_ANCILLARY_BUFFER_WORDS: usize = 8;
const TRUNCATED_RIGHTS_COUNT: usize = 32;

fn rights_payload_len(descriptor_count: usize) -> io::Result<u32> {
    let payload_len = descriptor_count
        .checked_mul(size_of::<RawFd>())
        .ok_or_else(|| io::Error::other("descriptor payload length overflowed"))?;
    u32::try_from(payload_len).map_err(|_| io::Error::other("descriptor payload is too large"))
}

fn rights_control_len(descriptor_count: usize) -> io::Result<usize> {
    let payload_len = rights_payload_len(descriptor_count)?;
    // SAFETY: CMSG_SPACE performs only the platform alignment calculation.
    Ok(unsafe { libc::CMSG_SPACE(payload_len) as usize })
}

fn send_rights(stream: &UnixStream, marker: u8, descriptors: &[RawFd]) -> io::Result<()> {
    assert!(!descriptors.is_empty());

    let control_len = rights_control_len(descriptors.len())?;
    let control_words = control_len.div_ceil(size_of::<usize>());
    let mut ancillary = vec![0_usize; control_words];
    let payload = [marker];
    let mut iov = libc::iovec {
        iov_base: payload.as_ptr().cast_mut().cast(),
        iov_len: payload.len(),
    };
    // SAFETY: a zeroed msghdr is initialized below before sendmsg reads it.
    let mut message = unsafe { MaybeUninit::<libc::msghdr>::zeroed().assume_init() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = ancillary_length(control_len)?;

    // SAFETY: message owns an aligned ancillary buffer sized by CMSG_SPACE.
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    if header.is_null() {
        return Err(io::Error::other("ancillary header is unavailable"));
    }
    let payload_len = rights_payload_len(descriptors.len())?;
    // SAFETY: CMSG_LEN performs only the platform alignment calculation.
    let header_len = unsafe { libc::CMSG_LEN(payload_len) as usize };
    // SAFETY: header and its data region are inside the initialized ancillary
    // buffer, and the destination is large enough for every descriptor.
    unsafe {
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = ancillary_length(header_len)?;
        std::ptr::copy_nonoverlapping(
            descriptors.as_ptr(),
            libc::CMSG_DATA(header).cast::<RawFd>(),
            descriptors.len(),
        );
    }

    loop {
        // SAFETY: message references live payload, iovec, and ancillary storage.
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
        if sent == 1 {
            return Ok(());
        }
        if sent < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "workload placement marker was not sent",
        ));
    }
}

#[cfg(target_env = "musl")]
fn ancillary_length(length: usize) -> io::Result<libc::socklen_t> {
    libc::socklen_t::try_from(length).map_err(|_| io::Error::other("ancillary length is too large"))
}

#[cfg(not(target_env = "musl"))]
fn ancillary_length(length: usize) -> io::Result<usize> {
    Ok(length)
}

fn open_descriptor_count() -> io::Result<usize> {
    Ok(std::fs::read_dir("/proc/self/fd")?.count())
}

fn assert_raw_rights_sender_round_trips() -> io::Result<()> {
    let placement = std::fs::File::open("/dev/null")?;
    let expected = placement.metadata()?;
    let (sender, receiver) = UnixStream::pair()?;

    let send = std::thread::spawn(move || {
        send_rights(&sender, WORKLOAD_PLACEMENT_MARKER, &[placement.as_raw_fd()])?;
        read_workload_placement_confirmation(&sender)
    });
    let received = std::fs::File::from(receive_workload_placement(&receiver)?);
    write_workload_placement_confirmation(&receiver)?;
    send.join()
        .map_err(|_| io::Error::other("workload placement sender panicked"))??;
    let actual = received.metadata()?;

    assert_eq!(actual.dev(), expected.dev());
    assert_eq!(actual.ino(), expected.ino());
    Ok(())
}

fn assert_rejected_without_descriptor_leak(
    case: &str,
    marker: u8,
    rights_count: usize,
) -> io::Result<()> {
    let placement = std::fs::File::open("/dev/null")?;
    let (sender, receiver) = UnixStream::pair()?;
    let baseline = open_descriptor_count()?;
    let descriptors = vec![placement.as_raw_fd(); rights_count];

    send_rights(&sender, marker, &descriptors)?;
    let Err(error) = receive_workload_placement(&receiver) else {
        return Err(io::Error::other(format!("{case} was accepted")));
    };

    assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{case}");
    assert_eq!(
        open_descriptor_count()?,
        baseline,
        "{case} leaked a receiver-installed descriptor",
    );
    Ok(())
}

#[test]
fn malformed_workload_placement_messages_close_received_descriptors() -> io::Result<()> {
    // Keep all descriptor-accounting cases in this sole integration test so
    // no parallel test in this process can perturb /proc/self/fd.
    let receiver_control_len = size_of::<[usize; RECEIVER_ANCILLARY_BUFFER_WORDS]>();

    // Prove the raw fixture transfers a real descriptor before using it to
    // construct malformed messages.
    assert_raw_rights_sender_round_trips()?;
    assert_rejected_without_descriptor_leak("wrong marker", 0, 1)?;
    assert!(rights_control_len(2)? <= receiver_control_len);
    assert_rejected_without_descriptor_leak("multiple descriptors", WORKLOAD_PLACEMENT_MARKER, 2)?;

    assert!(rights_control_len(TRUNCATED_RIGHTS_COUNT)? > receiver_control_len);
    assert_rejected_without_descriptor_leak(
        "truncated ancillary data",
        WORKLOAD_PLACEMENT_MARKER,
        TRUNCATED_RIGHTS_COUNT,
    )
}
