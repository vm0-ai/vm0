use std::io;
use std::time::{Duration, Instant};

use vsock_proto::ExecControlStatus;

use super::super::sink::ControlSinkInner;
use super::super::{ExecControlRegistry, is_timeout};
use super::support::{NONCE, resolve_error, unique_test_nonce};

#[test]
fn registered_operation_rejects_nonce_mismatch() {
    let registry = ExecControlRegistry::default();
    let _registration = registry.register(7, NONCE, false).unwrap();
    let wrong_nonce = *b"fedcba9876543210";

    let (status, diagnostic) = resolve_error(&registry, 7, wrong_nonce);

    assert_eq!(status, ExecControlStatus::NonceMismatch);
    assert_eq!(diagnostic, "exec operation nonce mismatch");
}
#[test]
fn released_operation_is_inactive() {
    let registry = ExecControlRegistry::default();
    let registration = registry.register(7, NONCE, false).unwrap();

    registration.guard.release();
    let (status, diagnostic) = resolve_error(&registry, 7, NONCE);

    assert_eq!(status, ExecControlStatus::Inactive);
    assert_eq!(diagnostic, "exec operation is not active");
}
#[test]
fn dropped_operation_allows_sequence_reuse() {
    let registry = ExecControlRegistry::default();
    {
        let _registration = registry.register(7, NONCE, false).unwrap();
        assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
    }

    assert!(registry.register(7, NONCE, false).is_ok());
}
#[test]
fn dropped_operation_closes_control_sink() {
    let nonce = unique_test_nonce(20);
    let registry = ExecControlRegistry::default();
    let registration = registry.register(20, nonce, true).unwrap();
    let sink = registry.resolve(20, nonce).unwrap();

    drop(registration);

    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Closed
    ));
    let (status, diagnostic) = resolve_error(&registry, 20, nonce);
    assert_eq!(status, ExecControlStatus::Inactive);
    assert_eq!(diagnostic, "exec operation is not active");
}
#[test]
fn dropped_operation_closes_connected_control_sink() {
    let nonce = unique_test_nonce(19);
    let registry = ExecControlRegistry::default();
    let registration = registry.register(19, nonce, true).unwrap();
    let endpoint = registration.bootstrap_endpoint.clone().unwrap();
    let sink = registry.resolve(19, nonce).unwrap();
    let mut stream = process_control_ipc::connect_abstract(&endpoint).unwrap();
    process_control_ipc::write_hello(&mut stream).unwrap();

    let mut guard = sink.inner.lock().unwrap_or_else(|e| e.into_inner());
    let deadline = Instant::now() + Duration::from_secs(1);
    while !matches!(&*guard, ControlSinkInner::Connected(_)) {
        let now = Instant::now();
        assert!(now < deadline, "control sink should connect after hello");
        let (next_guard, _) = sink
            .ready
            .wait_timeout(guard, deadline.duration_since(now))
            .unwrap_or_else(|e| e.into_inner());
        guard = next_guard;
    }
    drop(guard);

    drop(registration);

    assert!(matches!(
        *sink.inner.lock().unwrap_or_else(|e| e.into_inner()),
        ControlSinkInner::Closed
    ));
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let error = process_control_ipc::read_request(&mut stream).unwrap_err();
    assert!(
        !is_timeout(&error),
        "operation drop should interrupt the connected control sink stream"
    );
}
#[test]
fn valid_operation_without_sink_is_unsupported() {
    let registry = ExecControlRegistry::default();
    let _registration = registry.register(7, NONCE, false).unwrap();

    let (status, diagnostic) = resolve_error(&registry, 7, NONCE);

    assert_eq!(status, ExecControlStatus::Unsupported);
    assert_eq!(diagnostic, "exec control sink is not configured");
}
#[test]
fn duplicate_active_sequence_is_rejected_until_guard_releases() {
    let registry = ExecControlRegistry::default();
    let first = registry.register(7, NONCE, false).unwrap();

    assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
    let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
    assert_eq!(status, ExecControlStatus::Unsupported);
    assert_eq!(diagnostic, "exec control sink is not configured");

    first.guard.release();
    assert!(registry.register(7, NONCE, false).is_ok());
}
#[test]
fn released_guard_drop_does_not_remove_reused_sequence() {
    let registry = ExecControlRegistry::default();
    let first = registry.register(7, NONCE, false).unwrap();

    first.guard.release();
    let _second = registry.register(7, NONCE, false).unwrap();
    drop(first);

    let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
    assert_eq!(status, ExecControlStatus::Unsupported);
    assert_eq!(diagnostic, "exec control sink is not configured");
    assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
}
#[test]
fn second_release_does_not_remove_reused_sequence() {
    let registry = ExecControlRegistry::default();
    let first = registry.register(7, NONCE, false).unwrap();

    first.guard.release();
    let _second = registry.register(7, NONCE, false).unwrap();
    first.guard.release();

    let (status, diagnostic) = resolve_error(&registry, 7, NONCE);
    assert_eq!(status, ExecControlStatus::Unsupported);
    assert_eq!(diagnostic, "exec control sink is not configured");
    assert!(registry.register(7, *b"fedcba9876543210", false).is_err());
}
#[test]
fn duplicate_control_sink_sequence_is_rejected_without_rebinding_endpoint() {
    let sink_nonce = unique_test_nonce(14);

    let registry = ExecControlRegistry::default();
    let first = registry.register(14, sink_nonce, true).unwrap();

    let error = match registry.register(14, sink_nonce, true) {
        Ok(_) => panic!("expected duplicate exec control registration to fail"),
        Err(error) => error,
    };

    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(error.to_string(), "exec operation already active");
    assert!(registry.resolve(14, sink_nonce).is_ok());

    first.guard.release();
}
#[test]
fn control_sink_registration_exports_bootstrap_endpoint() {
    let nonce = unique_test_nonce(7);
    let registry = ExecControlRegistry::default();
    let registration = registry.register(7, nonce, true).unwrap();

    assert!(registration.bootstrap_endpoint.is_some());
    assert!(registry.resolve(7, nonce).is_ok());
}
