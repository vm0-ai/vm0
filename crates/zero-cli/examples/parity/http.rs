use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::model::{HttpExchange, MockHttp, MockResponse, RequestObservation};
use crate::{HarnessError, Result};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const STREAM_TIMEOUT: Duration = Duration::from_secs(5);

type HeaderValues = BTreeMap<String, Vec<Vec<u8>>>;

pub struct MockServer {
    address: SocketAddr,
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<Result<Vec<RequestObservation>>>>,
}

impl MockServer {
    pub fn start(specification: &MockHttp) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
            HarnessError::new(format!("bind isolated mock HTTP service: {error}"))
        })?;
        let address = listener.local_addr().map_err(|error| {
            HarnessError::new(format!("resolve mock HTTP service address: {error}"))
        })?;
        let (stop_sender, stop_receiver) = mpsc::channel();
        let specification = specification.clone();
        let thread = thread::spawn(move || {
            let mut requests = Vec::new();
            let mut errors = Vec::new();
            loop {
                let (mut stream, _) = listener.accept().map_err(|error| {
                    HarnessError::new(format!("accept mock HTTP connection: {error}"))
                })?;
                if stop_receiver.try_recv().is_ok() {
                    break;
                }
                let exchange = specification.exchanges.get(requests.len());
                match handle_connection(&mut stream, &specification.capture_headers, exchange) {
                    Ok(request) => requests.push(request),
                    Err(error) => {
                        errors.push(error.to_string());
                        let _ = write_response(
                            &mut stream,
                            &MockResponse {
                                status: 500,
                                headers: BTreeMap::from([(
                                    "content-type".to_owned(),
                                    "text/plain; charset=utf-8".to_owned(),
                                )]),
                                body: "parity mock HTTP service failed".to_owned(),
                            },
                        );
                    }
                }
            }
            if errors.is_empty() {
                Ok(requests)
            } else {
                Err(HarnessError::new(errors.join("; ")))
            }
        });

        Ok(Self {
            address,
            stop: Some(stop_sender),
            thread: Some(thread),
        })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn finish(mut self) -> Result<Vec<RequestObservation>> {
        self.stop_thread()
    }

    fn stop_thread(&mut self) -> Result<Vec<RequestObservation>> {
        let stop = self
            .stop
            .take()
            .ok_or_else(|| HarnessError::new("mock HTTP service was already stopped"))?;
        stop.send(()).map_err(|error| {
            HarnessError::new(format!("signal mock HTTP service shutdown: {error}"))
        })?;
        TcpStream::connect(self.address).map_err(|error| {
            HarnessError::new(format!("wake mock HTTP service for shutdown: {error}"))
        })?;
        let thread = self
            .thread
            .take()
            .ok_or_else(|| HarnessError::new("mock HTTP service thread is unavailable"))?;
        thread
            .join()
            .map_err(|_| HarnessError::new("mock HTTP service thread panicked"))?
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
            let _ = TcpStream::connect(self.address);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle_connection(
    stream: &mut TcpStream,
    capture_headers: &[String],
    exchange: Option<&HttpExchange>,
) -> Result<RequestObservation> {
    stream
        .set_read_timeout(Some(STREAM_TIMEOUT))
        .map_err(|error| HarnessError::new(format!("set mock HTTP read timeout: {error}")))?;
    stream
        .set_write_timeout(Some(STREAM_TIMEOUT))
        .map_err(|error| HarnessError::new(format!("set mock HTTP write timeout: {error}")))?;
    let request = read_request(stream, capture_headers)?;
    let response =
        exchange.map_or_else(unexpected_request_response, |value| value.response.clone());
    write_response(stream, &response)?;
    Ok(request)
}

fn read_request(stream: &mut TcpStream, capture_headers: &[String]) -> Result<RequestObservation> {
    let (mut received, header_end) = read_request_head(stream)?;
    let (method, target, headers) = parse_request_head(&received, header_end)?;
    let body = read_request_body(stream, &mut received, header_end, &headers)?;
    let captured_headers = capture_request_headers(&headers, capture_headers);
    let (path, query) = target
        .split_once('?')
        .map_or((target.as_str(), ""), |(path, query)| (path, query));
    Ok(RequestObservation {
        method,
        path: path.to_owned(),
        query: query.to_owned(),
        body,
        headers: captured_headers,
    })
}

fn read_request_head(stream: &mut TcpStream) -> Result<(Vec<u8>, usize)> {
    let mut received = Vec::new();
    let header_end = loop {
        if let Some(position) = find_bytes(&received, b"\r\n\r\n") {
            break position + 4;
        }
        if received.len() >= MAX_HEADER_BYTES {
            return Err(HarnessError::new(format!(
                "mock HTTP request headers exceed {MAX_HEADER_BYTES} bytes"
            )));
        }
        let mut buffer = [0_u8; 8192];
        let read = stream
            .read(&mut buffer)
            .map_err(|error| HarnessError::new(format!("read mock HTTP request: {error}")))?;
        if read == 0 {
            return Err(HarnessError::new(
                "mock HTTP client closed before completing request headers",
            ));
        }
        let bytes = buffer
            .get(..read)
            .ok_or_else(|| HarnessError::new("invalid mock HTTP read length"))?;
        received.extend_from_slice(bytes);
    };
    Ok((received, header_end))
}

fn parse_request_head(
    received: &[u8],
    header_end: usize,
) -> Result<(String, String, HeaderValues)> {
    let header_bytes = received
        .get(..header_end.saturating_sub(4))
        .ok_or_else(|| HarnessError::new("invalid mock HTTP header boundary"))?;
    let header_text = String::from_utf8(header_bytes.to_vec())
        .map_err(|error| HarnessError::new(format!("mock HTTP headers are not UTF-8: {error}")))?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| HarnessError::new("mock HTTP request line is missing"))?;
    let mut request_parts = request_line.split_ascii_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| HarnessError::new("mock HTTP method is missing"))?
        .to_owned();
    let target = request_parts
        .next()
        .ok_or_else(|| HarnessError::new("mock HTTP request target is missing"))?
        .to_owned();
    let version = request_parts
        .next()
        .ok_or_else(|| HarnessError::new("mock HTTP version is missing"))?;
    if request_parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return Err(HarnessError::new(format!(
            "unsupported mock HTTP request line {request_line:?}"
        )));
    }

    let mut headers = HeaderValues::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| HarnessError::new(format!("invalid mock HTTP header line {line:?}")))?;
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().as_bytes().to_vec();
        headers.entry(name).or_default().push(value);
    }
    Ok((method, target, headers))
}

fn read_request_body(
    stream: &mut TcpStream,
    received: &mut Vec<u8>,
    header_end: usize,
    headers: &HeaderValues,
) -> Result<Vec<u8>> {
    if headers
        .get("transfer-encoding")
        .is_some_and(|values| !values.is_empty())
    {
        return Err(HarnessError::new(
            "chunked mock HTTP request bodies are not supported by schema v1",
        ));
    }
    let content_length = parse_content_length(headers)?;
    if content_length > MAX_BODY_BYTES {
        return Err(HarnessError::new(format!(
            "mock HTTP request body exceeds {MAX_BODY_BYTES} bytes"
        )));
    }
    while received.len().saturating_sub(header_end) < content_length {
        let remaining = content_length.saturating_sub(received.len().saturating_sub(header_end));
        let mut buffer = vec![0_u8; remaining.min(8192)];
        stream
            .read_exact(&mut buffer)
            .map_err(|error| HarnessError::new(format!("read mock HTTP body: {error}")))?;
        received.extend_from_slice(&buffer);
    }
    let body_end = header_end
        .checked_add(content_length)
        .ok_or_else(|| HarnessError::new("mock HTTP body boundary overflow"))?;
    let body = received
        .get(header_end..body_end)
        .ok_or_else(|| HarnessError::new("invalid mock HTTP body boundary"))?
        .to_vec();
    Ok(body)
}

fn capture_request_headers(
    headers: &HeaderValues,
    capture_headers: &[String],
) -> BTreeMap<String, Vec<u8>> {
    let mut captured_headers = BTreeMap::new();
    for name in capture_headers {
        if let Some(values) = headers.get(name) {
            captured_headers.insert(name.clone(), join_header_values(values));
        }
    }
    captured_headers
}

fn parse_content_length(headers: &HeaderValues) -> Result<usize> {
    let Some(values) = headers.get("content-length") else {
        return Ok(0);
    };
    if values.len() != 1 {
        return Err(HarnessError::new(
            "mock HTTP request has multiple Content-Length headers",
        ));
    }
    let value = values
        .first()
        .ok_or_else(|| HarnessError::new("mock HTTP Content-Length value is missing"))?;
    let value = std::str::from_utf8(value).map_err(|error| {
        HarnessError::new(format!("mock HTTP Content-Length is not UTF-8: {error}"))
    })?;
    value.parse::<usize>().map_err(|error| {
        HarnessError::new(format!(
            "invalid mock HTTP Content-Length {value:?}: {error}"
        ))
    })
}

fn join_header_values(values: &[Vec<u8>]) -> Vec<u8> {
    let capacity = values.iter().map(Vec::len).sum::<usize>()
        + values.len().saturating_sub(1).saturating_mul(2);
    let mut joined = Vec::with_capacity(capacity);
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            joined.extend_from_slice(b", ");
        }
        joined.extend_from_slice(value);
    }
    joined
}

fn write_response(stream: &mut TcpStream, response: &MockResponse) -> Result<()> {
    let body = response.body.as_bytes();
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Length: {}\r\n",
        response.status,
        reason_phrase(response.status),
        body.len()
    )
    .map_err(|error| HarnessError::new(format!("write mock HTTP status: {error}")))?;
    for (name, value) in &response.headers {
        write!(stream, "{name}: {value}\r\n").map_err(|error| {
            HarnessError::new(format!("write mock HTTP response header: {error}"))
        })?;
    }
    stream
        .write_all(b"\r\n")
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush())
        .map_err(|error| HarnessError::new(format!("write mock HTTP response body: {error}")))
}

fn unexpected_request_response() -> MockResponse {
    MockResponse {
        status: 500,
        headers: BTreeMap::from([(
            "content-type".to_owned(),
            "application/json".to_owned(),
        )]),
        body: r#"{"error":{"code":"UNEXPECTED_PARITY_REQUEST","message":"No fixture response is configured"}}"#
            .to_owned(),
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Fixture Response",
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_selected_request_dimensions_and_returns_fixture_response() {
        let specification = MockHttp {
            capture_headers: vec!["x-test".to_owned()],
            exchanges: vec![HttpExchange {
                request: crate::model::ExpectedRequest {
                    method: "POST".to_owned(),
                    path: "/resource".to_owned(),
                    query: "a=1".to_owned(),
                    body: "payload".to_owned(),
                },
                response: MockResponse {
                    status: 201,
                    headers: BTreeMap::from([("content-type".to_owned(), "text/plain".to_owned())]),
                    body: "created".to_owned(),
                },
            }],
        };
        let server = MockServer::start(&specification).unwrap();
        let mut stream = TcpStream::connect(server.address).unwrap();
        stream
            .write_all(
                b"POST /resource?a=1 HTTP/1.1\r\nHost: local\r\nX-Test: value\r\nContent-Length: 7\r\n\r\npayload",
            )
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let requests = server.finish().unwrap();

        assert!(response.starts_with("HTTP/1.1 201 Created\r\n"));
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].path, "/resource");
        assert_eq!(requests[0].query, "a=1");
        assert_eq!(requests[0].body, b"payload");
        assert_eq!(requests[0].headers["x-test"], b"value");
    }
}
