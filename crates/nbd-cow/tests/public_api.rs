use nbd_cow::error::{NbdCowError, ProtocolError};

#[test]
fn protocol_error_is_available_from_public_error_module() {
    let error = NbdCowError::from(ProtocolError::UnknownCommand(99));

    assert!(matches!(
        error,
        NbdCowError::Protocol(ProtocolError::UnknownCommand(99))
    ));
}
