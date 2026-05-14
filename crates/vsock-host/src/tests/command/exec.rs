use std::io;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vsock_proto::{CommandTermination, Decoder, MSG_COMMAND_START, MSG_ERROR};

use super::super::support::{host_from_stream, make_pair, mock_handshake, send_command_result};

#[tokio::test]
async fn test_exec() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);

        let d = vsock_proto::decode_command_start(&msgs[0].payload).unwrap();
        assert_eq!(d.command, "echo hello");
        assert_eq!(d.timeout_ms, 5000);
        assert!(d.env.is_empty());
        assert!(!d.sudo);
        assert_eq!(d.label, "exec");

        send_command_result(
            &mut guest,
            msgs[0].seq,
            CommandTermination::Exited { exit_code: 0 },
            b"hello\n",
            b"",
        )
        .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host.exec("echo hello", 5000, &[], false).await.unwrap();
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    assert!(result.stderr.is_empty());
}

/// `host.exec` with `timeout_ms == 0` must reject at the boundary rather
/// than send the request to the guest — an unbounded exec would leak a
/// guest-side orphan when the host's outer timeout fires.
#[tokio::test]
async fn test_exec_rejects_zero_timeout() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("echo hi", 0, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
}

#[tokio::test]
async fn test_exec_error_response() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();

        let payload = vsock_proto::encode_error("command not found");
        let resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("badcmd", 5000, &[], false).await.unwrap_err();
    assert!(err.to_string().contains("command not found"));
}
