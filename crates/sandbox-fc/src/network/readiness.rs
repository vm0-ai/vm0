use std::fmt;
use std::fs::File;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

use nix::sched::{CloneFlags, setns};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::duration::duration_ms;

/// Local-only hostname used to validate a namespace's DNS redirect path.
pub const DNS_READINESS_HOSTNAME: &str = "vm0-readiness.invalid";

/// Local-only hostname reserved for post-failure namespace diagnostics.
pub const DNS_DIAGNOSTIC_HOSTNAME: &str = "vm0-diagnostic.invalid";

/// TEST-NET address returned for [`DNS_READINESS_HOSTNAME`].
pub const DNS_READINESS_IPV4: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);

pub(super) const DNS_READINESS_OPERATION_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) type DnsReadinessFuture =
    Pin<Box<dyn Future<Output = Result<u16, DnsReadinessError>> + Send>>;
pub(super) type DnsReadinessProbe = Arc<dyn Fn(String) -> DnsReadinessFuture + Send + Sync>;

const DNS_PORT: u16 = 53;
const DNS_RESPONSE_MAX_BYTES: usize = 512;
const DNS_QUERY_FLAGS_RECURSION_DESIRED: u16 = 0x0100;
const DNS_RESPONSE_FLAG: u16 = 0x8000;
const DNS_RESPONSE_CODE_MASK: u16 = 0x000f;
const DNS_TYPE_A: u16 = 1;
const DNS_CLASS_IN: u16 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_THREAD_GRACE: Duration = Duration::from_millis(250);
const PROBE_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(200);
const PROBE_RETRY_DELAY: Duration = Duration::from_millis(25);
const NETNS_DIR: &str = "/var/run/netns";

static NEXT_TRANSACTION_ID: AtomicU16 = AtomicU16::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DnsReadinessStage {
    SpawnThread,
    OpenCurrentNamespace,
    OpenTargetNamespace,
    EnterNamespace,
    BindSocket,
    ConnectSocket,
    ConfigureSocket,
    BuildQuery,
    SendQuery,
    ReceiveResponse,
    ValidateResponse,
    RestoreNamespace,
    WaitForThread,
    Timeout,
}

impl DnsReadinessStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::SpawnThread => "spawn_thread",
            Self::OpenCurrentNamespace => "open_current_namespace",
            Self::OpenTargetNamespace => "open_target_namespace",
            Self::EnterNamespace => "enter_namespace",
            Self::BindSocket => "bind_socket",
            Self::ConnectSocket => "connect_socket",
            Self::ConfigureSocket => "configure_socket",
            Self::BuildQuery => "build_query",
            Self::SendQuery => "send_query",
            Self::ReceiveResponse => "receive_response",
            Self::ValidateResponse => "validate_response",
            Self::RestoreNamespace => "restore_namespace",
            Self::WaitForThread => "wait_for_thread",
            Self::Timeout => "timeout",
        }
    }
}

impl fmt::Display for DnsReadinessStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Bounded failure from the runner-owned namespace DNS readiness probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DnsReadinessError {
    stage: DnsReadinessStage,
    io_kind: Option<io::ErrorKind>,
    attempts: u16,
}

impl DnsReadinessError {
    fn stage(stage: DnsReadinessStage) -> Self {
        Self {
            stage,
            io_kind: None,
            attempts: 0,
        }
    }

    fn io(stage: DnsReadinessStage, error: &io::Error) -> Self {
        Self {
            stage,
            io_kind: Some(error.kind()),
            attempts: 0,
        }
    }

    fn errno(stage: DnsReadinessStage, errno: nix::errno::Errno) -> Self {
        let error = io::Error::from_raw_os_error(errno as i32);
        Self::io(stage, &error)
    }

    fn stage_name(&self) -> DnsReadinessStage {
        self.stage
    }

    pub(crate) fn stage_label(&self) -> &'static str {
        self.stage.as_str()
    }

    pub(crate) fn io_kind(&self) -> Option<io::ErrorKind> {
        self.io_kind
    }

    pub(crate) fn attempts(&self) -> u16 {
        self.attempts
    }

    pub(super) fn timeout() -> Self {
        Self::stage(DnsReadinessStage::Timeout)
    }

    fn with_attempts(mut self, attempts: u16) -> Self {
        self.attempts = attempts;
        self
    }
}

impl fmt::Display for DnsReadinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "DNS readiness failed at stage={}", self.stage)?;
        if let Some(kind) = self.io_kind {
            write!(f, " io_kind={kind:?}")?;
        }
        write!(f, " attempts={}", self.attempts)?;
        Ok(())
    }
}

impl std::error::Error for DnsReadinessError {}

pub(super) fn production_dns_readiness_probe() -> DnsReadinessProbe {
    Arc::new(|namespace| Box::pin(probe_namespace_dns(namespace)))
}

pub(super) async fn run_dns_readiness_probe(
    namespace: String,
    probe: DnsReadinessProbe,
    timeout: Duration,
) -> Result<u16, DnsReadinessError> {
    let started = Instant::now();
    let result = match tokio::time::timeout(timeout, probe(namespace.clone())).await {
        Ok(result) => result,
        Err(_) => Err(DnsReadinessError::timeout()),
    };
    match &result {
        Ok(attempts) => info!(
            name = %namespace,
            attempts,
            elapsed_ms = duration_ms(started.elapsed()),
            "namespace DNS readiness probe succeeded"
        ),
        Err(error) => warn!(
            name = %namespace,
            stage = %error.stage_name(),
            io_kind = ?error.io_kind(),
            attempts = error.attempts(),
            elapsed_ms = duration_ms(started.elapsed()),
            "namespace DNS readiness probe failed"
        ),
    }
    result
}

pub(super) async fn probe_namespace_dns(namespace: String) -> Result<u16, DnsReadinessError> {
    probe_namespace_dns_for_hostname(namespace, PROBE_TIMEOUT, DNS_READINESS_HOSTNAME).await
}

pub(crate) async fn probe_namespace_dns_diagnostic(
    namespace: String,
    probe_timeout: Duration,
) -> Result<u16, DnsReadinessError> {
    probe_namespace_dns_for_hostname(namespace, probe_timeout, DNS_DIAGNOSTIC_HOSTNAME).await
}

async fn probe_namespace_dns_for_hostname(
    namespace: String,
    probe_timeout: Duration,
    hostname: &'static str,
) -> Result<u16, DnsReadinessError> {
    let (tx, rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("vm0-dns-readiness".into())
        .spawn(move || {
            let result = probe_namespace_dns_blocking(&namespace, probe_timeout, hostname);
            let _ = tx.send(result);
        })
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::SpawnThread, &error))?;

    match tokio::time::timeout(probe_timeout + PROBE_THREAD_GRACE, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(DnsReadinessError::stage(DnsReadinessStage::WaitForThread)),
        Err(_) => Err(DnsReadinessError::stage(DnsReadinessStage::Timeout)),
    }
}

fn probe_namespace_dns_blocking(
    namespace: &str,
    probe_timeout: Duration,
    hostname: &str,
) -> Result<u16, DnsReadinessError> {
    let current = File::open("/proc/self/ns/net")
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::OpenCurrentNamespace, &error))?;
    let target = File::open(Path::new(NETNS_DIR).join(namespace))
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::OpenTargetNamespace, &error))?;
    setns(&target, CloneFlags::CLONE_NEWNET)
        .map_err(|errno| DnsReadinessError::errno(DnsReadinessStage::EnterNamespace, errno))?;

    let result = probe_dns_endpoint(
        SocketAddrV4::new(DNS_READINESS_IPV4, DNS_PORT),
        probe_timeout,
        hostname,
    );
    let restore = setns(&current, CloneFlags::CLONE_NEWNET)
        .map_err(|errno| DnsReadinessError::errno(DnsReadinessStage::RestoreNamespace, errno));

    restore?;
    result
}

fn probe_dns_endpoint(
    destination: SocketAddrV4,
    timeout: Duration,
    hostname: &str,
) -> Result<u16, DnsReadinessError> {
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::BindSocket, &error))?;
    socket
        .connect(destination)
        .map_err(|error| DnsReadinessError::io(DnsReadinessStage::ConnectSocket, &error))?;

    let started = Instant::now();
    let deadline = started + timeout;
    let mut attempts = 0_u16;
    let mut last_error = DnsReadinessError::timeout();
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(last_error);
        }
        let attempt_timeout = PROBE_ATTEMPT_TIMEOUT.min(deadline.saturating_duration_since(now));
        socket
            .set_read_timeout(Some(attempt_timeout))
            .map_err(|error| DnsReadinessError::io(DnsReadinessStage::ConfigureSocket, &error))?;

        attempts = attempts.saturating_add(1);
        let transaction_id = NEXT_TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
        let query = build_dns_query(transaction_id, hostname)
            .map_err(|error| error.with_attempts(attempts))?;
        if let Err(error) = socket.send(&query) {
            last_error =
                DnsReadinessError::io(DnsReadinessStage::SendQuery, &error).with_attempts(attempts);
            sleep_before_retry(deadline);
            continue;
        }

        let mut response = [0_u8; DNS_RESPONSE_MAX_BYTES];
        match socket.recv(&mut response) {
            Ok(size) => {
                let Some(response) = response.get(..size) else {
                    last_error = invalid_response().with_attempts(attempts);
                    sleep_before_retry(deadline);
                    continue;
                };
                match validate_dns_response(response, transaction_id, DNS_READINESS_IPV4) {
                    Ok(()) => return Ok(attempts),
                    Err(error) => last_error = error.with_attempts(attempts),
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                last_error = DnsReadinessError::timeout().with_attempts(attempts);
            }
            Err(error) => {
                last_error = DnsReadinessError::io(DnsReadinessStage::ReceiveResponse, &error)
                    .with_attempts(attempts);
            }
        }
        sleep_before_retry(deadline);
    }
}

fn sleep_before_retry(deadline: Instant) {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if !remaining.is_zero() {
        std::thread::sleep(PROBE_RETRY_DELAY.min(remaining));
    }
}

fn build_dns_query(transaction_id: u16, hostname: &str) -> Result<Vec<u8>, DnsReadinessError> {
    let mut query = Vec::with_capacity(64);
    query.extend_from_slice(&transaction_id.to_be_bytes());
    query.extend_from_slice(&DNS_QUERY_FLAGS_RECURSION_DESIRED.to_be_bytes());
    query.extend_from_slice(&1_u16.to_be_bytes());
    query.extend_from_slice(&0_u16.to_be_bytes());
    query.extend_from_slice(&0_u16.to_be_bytes());
    query.extend_from_slice(&0_u16.to_be_bytes());
    for label in hostname.split('.') {
        let length = u8::try_from(label.len())
            .map_err(|_| DnsReadinessError::stage(DnsReadinessStage::BuildQuery))?;
        query.push(length);
        query.extend_from_slice(label.as_bytes());
    }
    query.push(0);
    query.extend_from_slice(&DNS_TYPE_A.to_be_bytes());
    query.extend_from_slice(&DNS_CLASS_IN.to_be_bytes());
    Ok(query)
}

fn validate_dns_response(
    response: &[u8],
    transaction_id: u16,
    expected_ip: Ipv4Addr,
) -> Result<(), DnsReadinessError> {
    let mut cursor = 0;
    let response_id = read_u16(response, &mut cursor)?;
    let flags = read_u16(response, &mut cursor)?;
    let question_count = read_u16(response, &mut cursor)?;
    let answer_count = read_u16(response, &mut cursor)?;
    let _authority_count = read_u16(response, &mut cursor)?;
    let _additional_count = read_u16(response, &mut cursor)?;

    if response_id != transaction_id
        || flags & DNS_RESPONSE_FLAG == 0
        || flags & DNS_RESPONSE_CODE_MASK != 0
        || question_count != 1
        || answer_count == 0
    {
        return Err(DnsReadinessError::stage(
            DnsReadinessStage::ValidateResponse,
        ));
    }

    skip_dns_name(response, &mut cursor)?;
    skip_bytes(response, &mut cursor, 4)?;

    for _ in 0..answer_count {
        skip_dns_name(response, &mut cursor)?;
        let record_type = read_u16(response, &mut cursor)?;
        let class = read_u16(response, &mut cursor)?;
        skip_bytes(response, &mut cursor, 4)?;
        let data_len = usize::from(read_u16(response, &mut cursor)?);
        let data_start = cursor;
        skip_bytes(response, &mut cursor, data_len)?;
        let expected_octets = expected_ip.octets();
        if record_type == DNS_TYPE_A
            && class == DNS_CLASS_IN
            && data_len == 4
            && response.get(data_start..cursor) == Some(expected_octets.as_ref())
        {
            return Ok(());
        }
    }

    Err(DnsReadinessError::stage(
        DnsReadinessStage::ValidateResponse,
    ))
}

fn read_u16(response: &[u8], cursor: &mut usize) -> Result<u16, DnsReadinessError> {
    let end = cursor.checked_add(2).ok_or_else(invalid_response)?;
    let bytes = response
        .get(*cursor..end)
        .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
        .ok_or_else(invalid_response)?;
    *cursor = end;
    Ok(u16::from_be_bytes(bytes))
}

fn skip_bytes(response: &[u8], cursor: &mut usize, count: usize) -> Result<(), DnsReadinessError> {
    *cursor = cursor.checked_add(count).ok_or_else(invalid_response)?;
    if *cursor > response.len() {
        return Err(invalid_response());
    }
    Ok(())
}

fn skip_dns_name(response: &[u8], cursor: &mut usize) -> Result<(), DnsReadinessError> {
    loop {
        let length = *response.get(*cursor).ok_or_else(invalid_response)?;
        *cursor += 1;
        if length == 0 {
            return Ok(());
        }
        if length & 0xc0 == 0xc0 {
            skip_bytes(response, cursor, 1)?;
            return Ok(());
        }
        if length & 0xc0 != 0 {
            return Err(invalid_response());
        }
        skip_bytes(response, cursor, usize::from(length))?;
    }
}

fn invalid_response() -> DnsReadinessError {
    DnsReadinessError::stage(DnsReadinessStage::ValidateResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn response_for_query(query: &[u8], answer: Ipv4Addr) -> Vec<u8> {
        let mut response = Vec::new();
        response.extend_from_slice(query.get(..2).unwrap());
        response.extend_from_slice(&0x8180_u16.to_be_bytes());
        response.extend_from_slice(&1_u16.to_be_bytes());
        response.extend_from_slice(&1_u16.to_be_bytes());
        response.extend_from_slice(&0_u16.to_be_bytes());
        response.extend_from_slice(&0_u16.to_be_bytes());
        response.extend_from_slice(query.get(12..).unwrap());
        response.extend_from_slice(&[0xc0, 0x0c]);
        response.extend_from_slice(&DNS_TYPE_A.to_be_bytes());
        response.extend_from_slice(&DNS_CLASS_IN.to_be_bytes());
        response.extend_from_slice(&0_u32.to_be_bytes());
        response.extend_from_slice(&4_u16.to_be_bytes());
        response.extend_from_slice(&answer.octets());
        response
    }

    #[test]
    fn query_uses_readiness_name_and_a_record() {
        let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();

        assert_eq!(query.get(..2).unwrap(), &0x1234_u16.to_be_bytes());
        assert_eq!(
            query.get(2..4).unwrap(),
            &DNS_QUERY_FLAGS_RECURSION_DESIRED.to_be_bytes()
        );
        assert!(
            query
                .windows("vm0-readiness".len())
                .any(|part| part == b"vm0-readiness")
        );
        assert_eq!(query.get(query.len() - 4..).unwrap(), &[0, 1, 0, 1]);
    }

    #[test]
    fn diagnostic_query_uses_distinct_fixed_name() {
        let query = build_dns_query(0x1234, DNS_DIAGNOSTIC_HOSTNAME).unwrap();

        assert!(
            query
                .windows("vm0-diagnostic".len())
                .any(|part| part == b"vm0-diagnostic")
        );
        assert!(
            !query
                .windows("vm0-readiness".len())
                .any(|part| part == b"vm0-readiness")
        );
    }

    #[test]
    fn response_validation_accepts_expected_compressed_a_record() {
        let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
        let response = response_for_query(&query, DNS_READINESS_IPV4);

        validate_dns_response(&response, 0x1234, DNS_READINESS_IPV4).unwrap();
    }

    #[test]
    fn response_validation_rejects_wrong_transaction_and_answer() {
        let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
        let response = response_for_query(&query, Ipv4Addr::new(192, 0, 2, 2));

        assert!(validate_dns_response(&response, 0x4321, DNS_READINESS_IPV4).is_err());
        assert!(validate_dns_response(&response, 0x1234, DNS_READINESS_IPV4).is_err());
    }

    #[test]
    fn response_validation_rejects_truncated_name() {
        let query = build_dns_query(0x1234, DNS_READINESS_HOSTNAME).unwrap();
        let mut response = response_for_query(&query, DNS_READINESS_IPV4);
        response.truncate(13);

        assert!(validate_dns_response(&response, 0x1234, DNS_READINESS_IPV4).is_err());
    }

    #[test]
    fn endpoint_probe_accepts_controlled_local_response() {
        let server = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let destination = match server.local_addr().unwrap() {
            std::net::SocketAddr::V4(address) => address,
            std::net::SocketAddr::V6(_) => panic!("test server should use IPv4"),
        };
        let server_thread = std::thread::spawn(move || {
            let mut query = [0_u8; DNS_RESPONSE_MAX_BYTES];
            let (size, peer) = server.recv_from(&mut query).unwrap();
            let response = response_for_query(&query[..size], DNS_READINESS_IPV4);
            server.send_to(&response, peer).unwrap();
        });

        probe_dns_endpoint(destination, Duration::from_secs(1), DNS_READINESS_HOSTNAME).unwrap();
        server_thread.join().unwrap();
    }

    #[test]
    fn endpoint_probe_times_out_without_response() {
        let server = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let destination = match server.local_addr().unwrap() {
            std::net::SocketAddr::V4(address) => address,
            std::net::SocketAddr::V6(_) => panic!("test server should use IPv4"),
        };
        let (received_tx, received_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server_thread = std::thread::spawn(move || {
            let mut query = [0_u8; DNS_RESPONSE_MAX_BYTES];
            server.recv_from(&mut query).unwrap();
            received_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });

        let result = probe_dns_endpoint(
            destination,
            Duration::from_millis(30),
            DNS_READINESS_HOSTNAME,
        );

        let received = received_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).unwrap();
        server_thread.join().unwrap();
        received.unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.stage_name(), DnsReadinessStage::Timeout);
    }
}
