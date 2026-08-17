use std::future::{Future, pending};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;

const RAW_HTTP_FIXTURE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RAW_HTTP_REQUEST_BYTES: usize = 1024 * 1024;

pub(crate) enum RawHttpAction {
    Respond(Vec<u8>),
    Disconnect,
    WaitThenRespond {
        release: Arc<Notify>,
        response: Vec<u8>,
    },
    Stall,
}

pub(crate) struct RawHttpTestServer {
    url: String,
    requests: mpsc::Receiver<Vec<u8>>,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl RawHttpTestServer {
    pub(crate) async fn spawn(actions: Vec<RawHttpAction>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("raw HTTP fixture should bind a loopback listener");
        let address = listener
            .local_addr()
            .expect("raw HTTP fixture should have a local address");
        let (request_tx, request_rx) = mpsc::channel(actions.len().max(1));
        let task = tokio::spawn(serve_actions(listener, actions, request_tx));

        Self {
            url: format!("http://{address}"),
            requests: request_rx,
            task: Some(task),
        }
    }

    pub(crate) fn url(&self) -> String {
        self.url.clone()
    }

    pub(crate) async fn receive_request(&mut self) -> io::Result<Vec<u8>> {
        match tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, self.requests.recv()).await {
            Ok(Some(request)) => Ok(request),
            Ok(None) => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "raw HTTP fixture request channel closed",
            )),
            Err(_) => Err(timeout_error("receiving a captured raw HTTP request")),
        }
    }

    pub(crate) async fn receive_request_text(&mut self) -> io::Result<String> {
        String::from_utf8(self.receive_request().await?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub(crate) fn try_receive_request_text(&mut self) -> io::Result<Option<String>> {
        match self.requests.try_recv() {
            Ok(request) => String::from_utf8(request)
                .map(Some)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
            Err(mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(mpsc::error::TryRecvError::Disconnected) => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "raw HTTP fixture request channel closed",
            )),
        }
    }

    pub(crate) async fn assert_complete(&mut self) {
        let mut task = self
            .task
            .take()
            .expect("raw HTTP fixture task should be present");
        match tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, &mut task).await {
            Ok(result) => assert_task_succeeded(result),
            Err(_) => {
                task.abort();
                reap_aborted_task(task).await;
                panic!("raw HTTP fixture should finish within five seconds");
            }
        }
    }

    pub(crate) async fn cancel(&mut self) {
        let task = self
            .task
            .take()
            .expect("raw HTTP fixture task should be present");
        task.abort();
        reap_aborted_task(task).await;
    }
}

impl Drop for RawHttpTestServer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

pub(crate) async fn read_raw_http_request(socket: &mut TcpStream) -> io::Result<Vec<u8>> {
    with_io_timeout(
        "reading a complete raw HTTP request",
        read_raw_http_request_inner(socket),
    )
    .await
}

pub(crate) async fn read_raw_http_request_text(socket: &mut TcpStream) -> io::Result<String> {
    String::from_utf8(read_raw_http_request(socket).await?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub(crate) async fn accept_raw_http_request(
    listener: &TcpListener,
) -> io::Result<(TcpStream, Vec<u8>)> {
    with_io_timeout("accepting a complete raw HTTP request", async {
        let (mut socket, _) = listener.accept().await?;
        let request = read_raw_http_request_inner(&mut socket).await?;
        Ok((socket, request))
    })
    .await
}

pub(crate) async fn accept_raw_http_request_text(listener: &TcpListener) -> (TcpStream, String) {
    let (socket, request) = accept_raw_http_request(listener)
        .await
        .expect("raw HTTP fixture should accept a complete request");
    let request = String::from_utf8(request).expect("raw HTTP fixture request should be UTF-8");
    (socket, request)
}

pub(crate) fn raw_http_response(status: &str, body: &[u8]) -> Vec<u8> {
    response_bytes(status, None, body)
}

pub(crate) fn json_response(status: &str, body: &[u8]) -> Vec<u8> {
    response_bytes(status, Some("application/json"), body)
}

pub(crate) fn status_response(status: &str) -> Vec<u8> {
    raw_http_response(status, &[])
}

pub(crate) async fn write_raw_http_response(
    socket: &mut TcpStream,
    response: &[u8],
) -> io::Result<()> {
    with_io_timeout(
        "writing a raw HTTP response",
        write_raw_http_response_inner(socket, response),
    )
    .await
}

async fn serve_actions(
    listener: TcpListener,
    actions: Vec<RawHttpAction>,
    request_tx: mpsc::Sender<Vec<u8>>,
) -> io::Result<()> {
    for action in actions {
        let (mut socket, _) = listener.accept().await?;
        let request = read_raw_http_request_inner(&mut socket).await?;
        request_tx.send(request).await.map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "raw HTTP fixture request receiver was dropped",
            )
        })?;

        match action {
            RawHttpAction::Respond(response) => {
                write_raw_http_response_inner(&mut socket, &response).await?
            }
            RawHttpAction::Disconnect => {}
            RawHttpAction::WaitThenRespond { release, response } => {
                release.notified().await;
                write_raw_http_response_inner(&mut socket, &response).await?;
            }
            RawHttpAction::Stall => pending::<()>().await,
        }
    }
    Ok(())
}

async fn write_raw_http_response_inner(socket: &mut TcpStream, response: &[u8]) -> io::Result<()> {
    socket.write_all(response).await?;
    socket.shutdown().await
}

async fn read_raw_http_request_inner(socket: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = socket.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before raw HTTP headers completed",
            ));
        }
        request.extend_from_slice(&buffer[..read]);
        if request.len() > MAX_RAW_HTTP_REQUEST_BYTES {
            return Err(request_too_large_error());
        }
        if let Some(header_end) = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        {
            break header_end;
        }
    };

    let body_length = content_length(&request[..header_end])?;
    let request_length = header_end
        .checked_add(body_length)
        .ok_or_else(request_too_large_error)?;
    if request_length > MAX_RAW_HTTP_REQUEST_BYTES {
        return Err(request_too_large_error());
    }
    while request.len() < request_length {
        let read = socket.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before raw HTTP body completed",
            ));
        }
        request.extend_from_slice(&buffer[..read]);
        if request.len() > MAX_RAW_HTTP_REQUEST_BYTES {
            return Err(request_too_large_error());
        }
    }
    request.truncate(request_length);
    Ok(request)
}

fn content_length(headers: &[u8]) -> io::Result<usize> {
    let headers = std::str::from_utf8(headers)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "raw HTTP Content-Length must contain only decimal digits",
                ));
            }
            return value
                .parse::<usize>()
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
    }
    Ok(0)
}

fn response_bytes(status: &str, content_type: Option<&str>, body: &[u8]) -> Vec<u8> {
    let content_type = content_type
        .map(|value| format!("Content-Type: {value}\r\n"))
        .unwrap_or_default();
    let mut response = format!(
        "HTTP/1.1 {status}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

async fn with_io_timeout<T>(
    context: &'static str,
    future: impl Future<Output = io::Result<T>>,
) -> io::Result<T> {
    tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, future)
        .await
        .map_err(|_| timeout_error(context))?
}

fn timeout_error(context: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("timed out while {context}"),
    )
}

fn request_too_large_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("raw HTTP request exceeds {MAX_RAW_HTTP_REQUEST_BYTES} bytes"),
    )
}

fn assert_task_succeeded(result: Result<io::Result<()>, tokio::task::JoinError>) {
    result
        .expect("raw HTTP fixture task should not panic")
        .expect("raw HTTP fixture should not fail");
}

async fn reap_aborted_task(task: JoinHandle<io::Result<()>>) {
    match tokio::time::timeout(RAW_HTTP_FIXTURE_TIMEOUT, task).await {
        Ok(Err(error)) if error.is_cancelled() => {}
        Ok(result) => assert_task_succeeded(result),
        Err(_) => panic!("raw HTTP fixture task should be reaped after cancellation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address);
        let server = listener.accept();
        let (client, server) = tokio::join!(client, server);
        let (server, _) = server.unwrap();
        (client.unwrap(), server)
    }

    async fn connect_fixture(server: &RawHttpTestServer) -> TcpStream {
        let url = server.url();
        TcpStream::connect(url.trim_start_matches("http://"))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn captures_complete_request_and_responds() {
        let response = json_response("200 OK", br#"{"ok":true}"#);
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(response)]).await;
        let mut client = connect_fixture(&server).await;
        let request = b"POST /events HTTP/1.1\r\nContent-Length: 4\r\n\r\ntest";
        client.write_all(request).await.unwrap();

        assert_eq!(
            server.receive_request_text().await.unwrap(),
            String::from_utf8(request.to_vec()).unwrap()
        );
        let mut received_response = Vec::new();
        client.read_to_end(&mut received_response).await.unwrap();
        assert_eq!(
            received_response,
            json_response("200 OK", br#"{"ok":true}"#)
        );
        server.assert_complete().await;
    }

    #[tokio::test]
    async fn rejects_premature_header_eof() {
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: test")
            .await
            .unwrap();
        client.shutdown().await.unwrap();

        let error = read_raw_http_request_text(&mut server).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert!(error.to_string().contains("headers"));
    }

    #[tokio::test]
    async fn rejects_premature_body_eof() {
        let (mut client, mut server) = connected_pair().await;
        client
            .write_all(b"POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\nabc")
            .await
            .unwrap();
        client.shutdown().await.unwrap();

        let error = read_raw_http_request(&mut server).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert!(error.to_string().contains("body"));
    }

    #[tokio::test]
    async fn rejects_invalid_and_oversized_content_lengths() {
        for (content_length, expected_message) in [
            ("+4".to_string(), "decimal digits"),
            ((MAX_RAW_HTTP_REQUEST_BYTES + 1).to_string(), "exceeds"),
        ] {
            let (mut client, mut server) = connected_pair().await;
            client
                .write_all(
                    format!("POST / HTTP/1.1\r\nContent-Length: {content_length}\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();

            let error = read_raw_http_request(&mut server).await.unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert!(error.to_string().contains(expected_message));
        }
    }

    #[tokio::test]
    async fn disconnects_after_publishing_request() {
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Disconnect]).await;
        let mut client = connect_fixture(&server).await;
        let request = b"GET / HTTP/1.1\r\n\r\n";
        client.write_all(request).await.unwrap();

        assert_eq!(server.receive_request().await.unwrap(), request);
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(response.is_empty());
        server.assert_complete().await;
    }

    #[tokio::test]
    async fn publishes_request_before_waiting_for_release() {
        let release = Arc::new(Notify::new());
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::WaitThenRespond {
            release: Arc::clone(&release),
            response: status_response("204 No Content"),
        }])
        .await;
        let address = server.url().trim_start_matches("http://").to_string();
        let client_task = tokio::spawn(async move {
            let mut client = TcpStream::connect(address).await.unwrap();
            client.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
            let mut response = Vec::new();
            client.read_to_end(&mut response).await.unwrap();
            response
        });

        assert_eq!(
            server.receive_request().await.unwrap(),
            b"GET / HTTP/1.1\r\n\r\n"
        );
        assert!(!client_task.is_finished());
        release.notify_one();
        assert_eq!(
            client_task.await.unwrap(),
            status_response("204 No Content")
        );
        server.assert_complete().await;
    }

    #[tokio::test(start_paused = true)]
    async fn remains_available_across_virtual_time_advance_between_actions() {
        let response = status_response("204 No Content");
        let mut server = RawHttpTestServer::spawn(vec![
            RawHttpAction::Respond(response.clone()),
            RawHttpAction::Respond(response.clone()),
        ])
        .await;

        for request in [
            &b"GET /first HTTP/1.1\r\n\r\n"[..],
            &b"GET /second HTTP/1.1\r\n\r\n"[..],
        ] {
            let mut client = connect_fixture(&server).await;
            client.write_all(request).await.unwrap();
            assert_eq!(server.receive_request().await.unwrap(), request);
            let mut received_response = Vec::new();
            client.read_to_end(&mut received_response).await.unwrap();
            assert_eq!(received_response, response);
            tokio::time::advance(RAW_HTTP_FIXTURE_TIMEOUT + Duration::from_secs(1)).await;
        }

        server.assert_complete().await;
    }

    #[tokio::test(start_paused = true)]
    async fn assert_complete_aborts_and_reaps_timed_out_task() {
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Stall]).await;
        let assertion = tokio::spawn(async move {
            server.assert_complete().await;
        });
        tokio::task::yield_now().await;
        tokio::time::advance(RAW_HTTP_FIXTURE_TIMEOUT).await;

        assert!(assertion.await.unwrap_err().is_panic());
    }

    #[tokio::test]
    async fn cancellation_reaps_stalled_task() {
        let mut server = RawHttpTestServer::spawn(vec![RawHttpAction::Stall]).await;
        let mut client = connect_fixture(&server).await;
        client.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
        assert_eq!(
            server.receive_request().await.unwrap(),
            b"GET / HTTP/1.1\r\n\r\n"
        );

        server.cancel().await;
    }
}
