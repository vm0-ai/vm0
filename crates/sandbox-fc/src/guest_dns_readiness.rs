use std::fmt;
use std::io;
use std::time::Duration;

use sandbox::SandboxGuestDnsReadinessReason;
use tokio::time::{Instant, timeout_at};
use vsock_host::{ExecOperationRequest, ExecOperationResult, ExecOwnedCapturedOutput, VsockHost};
use vsock_proto::{ExecOutputPolicy, ExecTermination};

use crate::network::{DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};

const RESOLVER_ENV: &[(&str, &str)] = &[("RES_OPTIONS", "attempts:1 timeout:1")];
const LABEL: &str = "guest-dns-readiness";
const PROCESS_TIMEOUT_MS: u32 = 1_100;
const OPERATION_START_AND_RESULT_GRACE_MS: u64 = 1_000;
const OPERATION_WAIT_TIMEOUT: Duration =
    Duration::from_millis(PROCESS_TIMEOUT_MS as u64 + OPERATION_START_AND_RESULT_GRACE_MS);
const STDOUT_LIMIT_BYTES: u32 = 1_024;
const STDERR_LIMIT_BYTES: u32 = 512;
const EXPECTED_TRANSIENT_EXIT_CODES: &[i32] = &[2];

pub(crate) const GUEST_DNS_READINESS_MAX_ATTEMPTS: u16 = 3;
/// IPv4 packet size of the fixed `vm0-readiness.invalid` UDP A query.
pub(crate) const GUEST_DNS_READINESS_PACKET_BYTES: u64 = 67;

const PRODUCTION_POLICY: ReadinessPolicy = ReadinessPolicy {
    total_timeout: Duration::from_secs(7),
    attempt_timeout: OPERATION_WAIT_TIMEOUT,
    max_attempts: GUEST_DNS_READINESS_MAX_ATTEMPTS,
};

#[derive(Clone, Copy)]
struct ReadinessPolicy {
    total_timeout: Duration,
    attempt_timeout: Duration,
    max_attempts: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuestDnsReadinessFailure {
    Deadline,
    Transport(io::ErrorKind),
    TimedOut,
    Cancelled,
    StartFailed,
    WaitFailed,
    ExitNonZero(i32),
    OutputTruncated,
    InvalidOutput,
    UnexpectedAnswer,
}

impl fmt::Display for GuestDnsReadinessFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Deadline => f.write_str("deadline"),
            Self::Transport(kind) => write!(f, "transport_{kind:?}"),
            Self::TimedOut => f.write_str("process_timeout"),
            Self::Cancelled => f.write_str("process_cancelled"),
            Self::StartFailed => f.write_str("process_start_failed"),
            Self::WaitFailed => f.write_str("process_wait_failed"),
            Self::ExitNonZero(exit_code) => write!(f, "exit_nonzero_{exit_code}"),
            Self::OutputTruncated => f.write_str("output_truncated"),
            Self::InvalidOutput => f.write_str("invalid_output"),
            Self::UnexpectedAnswer => f.write_str("unexpected_answer"),
        }
    }
}

impl GuestDnsReadinessFailure {
    fn retryable(self) -> bool {
        matches!(
            self,
            Self::TimedOut | Self::ExitNonZero(2) | Self::UnexpectedAnswer
        )
    }

    pub(crate) fn sandbox_reason(self) -> SandboxGuestDnsReadinessReason {
        match self {
            Self::TimedOut => SandboxGuestDnsReadinessReason::ProcessTimeout,
            Self::Deadline => SandboxGuestDnsReadinessReason::Deadline,
            Self::ExitNonZero(2) | Self::UnexpectedAnswer => {
                SandboxGuestDnsReadinessReason::DnsPath
            }
            Self::Transport(_)
            | Self::Cancelled
            | Self::StartFailed
            | Self::WaitFailed
            | Self::ExitNonZero(_)
            | Self::OutputTruncated
            | Self::InvalidOutput => SandboxGuestDnsReadinessReason::Other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GuestDnsReadinessError {
    pub(crate) attempts: u16,
    pub(crate) elapsed: Duration,
    pub(crate) last_failure: GuestDnsReadinessFailure,
}

impl fmt::Display for GuestDnsReadinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "outcome={} attempts={} elapsed_ms={}",
            self.last_failure,
            self.attempts,
            self.elapsed.as_millis(),
        )
    }
}

impl std::error::Error for GuestDnsReadinessError {}

pub(crate) async fn wait_for_guest_dns_readiness(
    guest: &VsockHost,
) -> Result<(), GuestDnsReadinessError> {
    wait_for_guest_dns_readiness_with_policy(guest, PRODUCTION_POLICY).await
}

async fn wait_for_guest_dns_readiness_with_policy(
    guest: &VsockHost,
    policy: ReadinessPolicy,
) -> Result<(), GuestDnsReadinessError> {
    let started = Instant::now();
    let deadline = started + policy.total_timeout;
    let mut attempts = 0;

    loop {
        attempts += 1;
        let failure = match probe_guest_dns_once(guest, policy.attempt_timeout).await {
            Ok(()) => return Ok(()),
            Err(failure) => failure,
        };

        let complete_retry_fits =
            deadline.saturating_duration_since(Instant::now()) >= policy.attempt_timeout;
        if !failure.retryable() || attempts >= policy.max_attempts || !complete_retry_fits {
            return Err(GuestDnsReadinessError {
                attempts,
                elapsed: started.elapsed(),
                last_failure: failure,
            });
        }
    }
}

pub(crate) async fn probe_guest_dns_once(
    guest: &VsockHost,
    wait_timeout: Duration,
) -> Result<(), GuestDnsReadinessFailure> {
    let command = format!("/usr/bin/getent ahostsv4 {DNS_READINESS_HOSTNAME}");
    let request = ExecOperationRequest {
        timeout_ms: PROCESS_TIMEOUT_MS,
        start_write_timeout: wait_timeout,
        command: &command,
        env: RESOLVER_ENV,
        sudo: false,
        label: LABEL,
        stdout: ExecOutputPolicy::Capture {
            limit_bytes: STDOUT_LIMIT_BYTES,
        },
        stderr: ExecOutputPolicy::Capture {
            limit_bytes: STDERR_LIMIT_BYTES,
        },
        expected_exit_codes: EXPECTED_TRANSIENT_EXIT_CODES,
        stdin_bytes: None,
        stream_queue_capacity: None,
    };

    // Bound startup and terminal waiting by one deadline while leaving terminal
    // timeout cleanup to the operation handle.
    let deadline = Instant::now() + wait_timeout;
    let handle = match timeout_at(deadline, guest.start_exec_operation(request)).await {
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            return Err(GuestDnsReadinessFailure::Transport(error.kind()));
        }
        Err(_) => return Err(GuestDnsReadinessFailure::Deadline),
    };

    match handle
        .wait(deadline.saturating_duration_since(Instant::now()))
        .await
    {
        Ok(result) => validate_result(result),
        Err(error) if error.kind() == io::ErrorKind::TimedOut => {
            Err(GuestDnsReadinessFailure::Deadline)
        }
        Err(error) => Err(GuestDnsReadinessFailure::Transport(error.kind())),
    }
}

fn validate_result(result: ExecOperationResult) -> Result<(), GuestDnsReadinessFailure> {
    let ExecOperationResult {
        termination,
        stdout,
        stderr,
        stream_overflowed,
        ..
    } = result;

    match termination {
        ExecTermination::Exited { exit_code: 0 } => {}
        ExecTermination::Exited { exit_code } => {
            return Err(GuestDnsReadinessFailure::ExitNonZero(exit_code));
        }
        ExecTermination::TimedOut => return Err(GuestDnsReadinessFailure::TimedOut),
        ExecTermination::Cancelled => return Err(GuestDnsReadinessFailure::Cancelled),
        ExecTermination::StartFailed => return Err(GuestDnsReadinessFailure::StartFailed),
        ExecTermination::WaitFailed => return Err(GuestDnsReadinessFailure::WaitFailed),
    }

    if stream_overflowed {
        return Err(GuestDnsReadinessFailure::OutputTruncated);
    }
    let (stdout, stdout_truncated) = captured_output(stdout)?;
    let (_, stderr_truncated) = captured_output(stderr)?;
    if stdout_truncated || stderr_truncated {
        return Err(GuestDnsReadinessFailure::OutputTruncated);
    }

    let expected = DNS_READINESS_IPV4.to_string();
    if stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            line.split(|byte| byte.is_ascii_whitespace())
                .find(|field| !field.is_empty())
        })
        .any(|address| address == expected.as_bytes())
    {
        Ok(())
    } else {
        Err(GuestDnsReadinessFailure::UnexpectedAnswer)
    }
}

fn captured_output(
    output: ExecOwnedCapturedOutput,
) -> Result<(Vec<u8>, bool), GuestDnsReadinessFailure> {
    match output {
        ExecOwnedCapturedOutput::Captured { bytes, truncated } => Ok((bytes, truncated)),
        ExecOwnedCapturedOutput::Discarded => Err(GuestDnsReadinessFailure::InvalidOutput),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    use vsock_proto::{
        ExecCapturedOutput, ExecOutputPolicy, ExecTimeoutPolicy, HEADER_SIZE, MAX_MESSAGE_SIZE,
        MIN_BODY_SIZE, MSG_EXEC_RESULT, MSG_EXEC_START, MSG_PING, MSG_PONG, MSG_READY, RawMessage,
    };

    use super::*;

    const TEST_POLICY: ReadinessPolicy = ReadinessPolicy {
        total_timeout: Duration::from_secs(1),
        attempt_timeout: Duration::from_millis(250),
        max_attempts: 3,
    };

    async fn read_message(stream: &mut UnixStream) -> RawMessage {
        let mut header = [0_u8; HEADER_SIZE];
        tokio::time::timeout(Duration::from_secs(1), stream.read_exact(&mut header))
            .await
            .unwrap()
            .unwrap();
        let body_len = u32::from_be_bytes(header) as usize;
        assert!((MIN_BODY_SIZE..=MAX_MESSAGE_SIZE).contains(&body_len));
        let mut body = vec![0_u8; body_len];
        stream.read_exact(&mut body).await.unwrap();
        RawMessage {
            msg_type: body[0],
            seq: u32::from_be_bytes(body[1..MIN_BODY_SIZE].try_into().unwrap()),
            payload: body[MIN_BODY_SIZE..].to_vec(),
        }
    }

    async fn connect_mock_guest(vsock_path: &str) -> UnixStream {
        let listener_path = format!("{vsock_path}_{}", vsock_proto::VSOCK_PORT);
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            match UnixStream::connect(&listener_path).await {
                Ok(stream) => return stream,
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline =>
                {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("connect mock guest: {error}"),
            }
        }
    }

    async fn setup_host_and_guest() -> (Arc<VsockHost>, UnixStream) {
        let temp_dir = tempfile::tempdir().unwrap();
        let vsock_path = temp_dir
            .path()
            .join("guest-dns-readiness")
            .to_string_lossy()
            .into_owned();
        let wait_path = vsock_path.clone();
        let host_task = tokio::spawn(async move {
            VsockHost::wait_for_connection(&wait_path, Duration::from_secs(1))
                .await
                .unwrap()
        });
        let mut guest = connect_mock_guest(&vsock_path).await;
        guest
            .write_all(&vsock_proto::encode(MSG_READY, 0, &[]).unwrap())
            .await
            .unwrap();
        let ping = read_message(&mut guest).await;
        assert_eq!(ping.msg_type, MSG_PING);
        guest
            .write_all(&vsock_proto::encode(MSG_PONG, ping.seq, &[]).unwrap())
            .await
            .unwrap();
        (Arc::new(host_task.await.unwrap()), guest)
    }

    fn assert_readiness_request(message: &RawMessage) {
        assert_eq!(message.msg_type, MSG_EXEC_START);
        let request = vsock_proto::decode_exec_start(&message.payload).unwrap();
        assert_eq!(
            request.timeout,
            ExecTimeoutPolicy::Duration {
                timeout_ms: PROCESS_TIMEOUT_MS
            }
        );
        assert_eq!(
            request.command,
            format!("/usr/bin/getent ahostsv4 {DNS_READINESS_HOSTNAME}")
        );
        assert_eq!(request.env, RESOLVER_ENV);
        assert!(!request.sudo);
        assert_eq!(request.label, LABEL);
        assert_eq!(
            request.stdout,
            ExecOutputPolicy::Capture {
                limit_bytes: STDOUT_LIMIT_BYTES
            }
        );
        assert_eq!(
            request.stderr,
            ExecOutputPolicy::Capture {
                limit_bytes: STDERR_LIMIT_BYTES
            }
        );
        assert_eq!(request.expected_exit_codes, EXPECTED_TRANSIENT_EXIT_CODES);
        assert!(request.stdin_bytes.is_none());
    }

    async fn send_result(
        guest: &mut UnixStream,
        request: &RawMessage,
        termination: ExecTermination,
        stdout: &[u8],
        stdout_truncated: bool,
    ) {
        let payload = vsock_proto::encode_exec_result(
            termination,
            1,
            ExecCapturedOutput::Captured {
                bytes: stdout,
                truncated: stdout_truncated,
            },
            ExecCapturedOutput::Captured {
                bytes: b"",
                truncated: false,
            },
            "",
        )
        .unwrap();
        guest
            .write_all(&vsock_proto::encode(MSG_EXEC_RESULT, request.seq, &payload).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn guest_dns_readiness_uses_fixed_guest_resolver_request() {
        let (host, mut guest) = setup_host_and_guest().await;
        let task = tokio::spawn(async move {
            wait_for_guest_dns_readiness_with_policy(&host, TEST_POLICY).await
        });
        let request = read_message(&mut guest).await;
        assert_readiness_request(&request);
        send_result(
            &mut guest,
            &request,
            ExecTermination::Exited { exit_code: 0 },
            b"192.0.2.1 STREAM vm0-readiness.invalid\n",
            false,
        )
        .await;

        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn guest_dns_readiness_recovers_after_transient_failure() {
        let (host, mut guest) = setup_host_and_guest().await;
        let task = tokio::spawn(async move {
            wait_for_guest_dns_readiness_with_policy(&host, TEST_POLICY).await
        });
        let first = read_message(&mut guest).await;
        send_result(
            &mut guest,
            &first,
            ExecTermination::Exited { exit_code: 2 },
            b"",
            false,
        )
        .await;
        let second = read_message(&mut guest).await;
        send_result(
            &mut guest,
            &second,
            ExecTermination::Exited { exit_code: 0 },
            b"192.0.2.1 DGRAM vm0-readiness.invalid\n",
            false,
        )
        .await;

        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn guest_dns_readiness_retries_late_guest_process_timeout() {
        let (host, mut guest) = setup_host_and_guest().await;
        let task = tokio::spawn(async move {
            wait_for_guest_dns_readiness_with_policy(&host, PRODUCTION_POLICY).await
        });
        let first = read_message(&mut guest).await;

        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(1_600)).await;
        send_result(&mut guest, &first, ExecTermination::TimedOut, b"", false).await;

        let second = read_message(&mut guest).await;
        send_result(
            &mut guest,
            &second,
            ExecTermination::Exited { exit_code: 0 },
            b"192.0.2.1 STREAM vm0-readiness.invalid\n",
            false,
        )
        .await;

        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn guest_dns_readiness_does_not_start_shortened_retry() {
        let (host, mut guest) = setup_host_and_guest().await;
        let policy = ReadinessPolicy {
            total_timeout: Duration::from_millis(500),
            attempt_timeout: Duration::from_millis(300),
            max_attempts: 3,
        };
        let task =
            tokio::spawn(
                async move { wait_for_guest_dns_readiness_with_policy(&host, policy).await },
            );
        let first = read_message(&mut guest).await;

        tokio::time::pause();
        tokio::time::advance(Duration::from_millis(250)).await;
        send_result(
            &mut guest,
            &first,
            ExecTermination::Exited { exit_code: 2 },
            b"",
            false,
        )
        .await;

        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.attempts, 1);
        assert_eq!(error.last_failure, GuestDnsReadinessFailure::ExitNonZero(2));
        assert!(error.elapsed < policy.total_timeout);
    }

    #[tokio::test]
    async fn guest_dns_readiness_stops_at_attempt_limit() {
        let (host, mut guest) = setup_host_and_guest().await;
        let task = tokio::spawn(async move {
            wait_for_guest_dns_readiness_with_policy(&host, TEST_POLICY).await
        });
        for _ in 0..TEST_POLICY.max_attempts {
            let request = read_message(&mut guest).await;
            send_result(
                &mut guest,
                &request,
                ExecTermination::Exited { exit_code: 0 },
                b"203.0.113.1 STREAM vm0-readiness.invalid\n",
                false,
            )
            .await;
        }

        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.attempts, TEST_POLICY.max_attempts);
        assert_eq!(
            error.last_failure,
            GuestDnsReadinessFailure::UnexpectedAnswer
        );
    }

    #[tokio::test]
    async fn guest_dns_readiness_classifies_terminal_expiry_as_deadline() {
        let (host, mut guest) = setup_host_and_guest().await;
        tokio::time::pause();
        let policy = ReadinessPolicy {
            total_timeout: Duration::from_millis(50),
            attempt_timeout: Duration::from_millis(50),
            max_attempts: 3,
        };
        let readiness =
            async move { wait_for_guest_dns_readiness_with_policy(&host, policy).await };
        let task = tokio::spawn(readiness);
        let request = read_message(&mut guest).await;
        assert_readiness_request(&request);

        let error = task.await.unwrap().unwrap_err();

        assert_eq!(error.attempts, 1);
        assert_eq!(error.last_failure, GuestDnsReadinessFailure::Deadline);
        assert!(error.elapsed >= policy.total_timeout);
        assert!(error.elapsed < OPERATION_WAIT_TIMEOUT);
    }

    #[test]
    fn guest_dns_readiness_maps_every_failure_policy() {
        use GuestDnsReadinessFailure as Failure;
        use SandboxGuestDnsReadinessReason as Reason;

        for (failure, expected_retryable, expected_reason) in [
            (Failure::Deadline, false, Reason::Deadline),
            (
                Failure::Transport(io::ErrorKind::TimedOut),
                false,
                Reason::Other,
            ),
            (Failure::TimedOut, true, Reason::ProcessTimeout),
            (Failure::Cancelled, false, Reason::Other),
            (Failure::StartFailed, false, Reason::Other),
            (Failure::WaitFailed, false, Reason::Other),
            (Failure::ExitNonZero(2), true, Reason::DnsPath),
            (Failure::ExitNonZero(1), false, Reason::Other),
            (Failure::OutputTruncated, false, Reason::Other),
            (Failure::InvalidOutput, false, Reason::Other),
            (Failure::UnexpectedAnswer, true, Reason::DnsPath),
        ] {
            assert_eq!(
                failure.retryable(),
                expected_retryable,
                "unexpected retry policy for {failure:?}",
            );
            assert_eq!(
                failure.sandbox_reason(),
                expected_reason,
                "unexpected sandbox reason for {failure:?}",
            );
        }
    }

    #[tokio::test]
    async fn guest_dns_readiness_rejects_truncated_output() {
        let (host, mut guest) = setup_host_and_guest().await;
        let task = tokio::spawn(async move {
            wait_for_guest_dns_readiness_with_policy(&host, TEST_POLICY).await
        });
        let request = read_message(&mut guest).await;
        send_result(
            &mut guest,
            &request,
            ExecTermination::Exited { exit_code: 0 },
            b"192.0.2.1 STREAM vm0-readiness.invalid\n",
            true,
        )
        .await;

        let error = task.await.unwrap().unwrap_err();
        assert_eq!(
            error.last_failure,
            GuestDnsReadinessFailure::OutputTruncated
        );
        assert_eq!(error.attempts, 1);
    }
}
