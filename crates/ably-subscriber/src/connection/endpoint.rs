use crate::Error;

pub(crate) const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
pub(super) const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = concat!("ably-subscriber-rs/", env!("CARGO_PKG_VERSION"));

fn is_localhost_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") => true,
        Some(url::Host::Ipv4(addr)) if addr == std::net::Ipv4Addr::LOCALHOST => true,
        Some(url::Host::Ipv6(addr)) if addr == std::net::Ipv6Addr::LOCALHOST => true,
        _ => false,
    }
}

fn parse_endpoint_host(host: &str) -> Result<url::Url, Error> {
    let url =
        url::Url::parse(&format!("http://{host}/")).map_err(|_| Error::InvalidEndpointHost)?;

    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::InvalidEndpointHost);
    }

    Ok(url)
}

fn build_endpoint_base_url(
    host: &str,
    localhost_scheme: &str,
    remote_scheme: &str,
) -> Result<url::Url, Error> {
    let mut url = parse_endpoint_host(host)?;
    let scheme = if is_localhost_url(&url) {
        localhost_scheme
    } else {
        remote_scheme
    };
    url.set_scheme(scheme)
        .map_err(|_| Error::InvalidEndpointHost)?;
    Ok(url)
}

/// Derive REST host from realtime host.
pub(crate) fn rest_host(realtime_host: &str) -> String {
    if realtime_host == DEFAULT_REALTIME_HOST {
        "rest.ably.io".to_string()
    } else {
        realtime_host.to_string()
    }
}

pub(super) fn build_ws_url(host: &str, token: &str, resume: Option<&str>) -> Result<String, Error> {
    let mut u = build_endpoint_base_url(host, "ws", "wss")?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("access_token", token);
        q.append_pair("format", "msgpack");
        q.append_pair("v", PROTOCOL_VERSION);
        q.append_pair("agent", AGENT_STRING);
        q.append_pair("heartbeats", "true");
        q.append_pair("echo", "false");
        if let Some(key) = resume {
            q.append_pair("resume", key);
        }
    }
    Ok(u.to_string())
}

pub(super) fn build_token_request_url(host: &str, key_name: &str) -> Result<url::Url, Error> {
    let mut url = build_endpoint_base_url(host, "http", "https")?;
    url.path_segments_mut()
        .map_err(|_| Error::InvalidEndpointHost)?
        .push("keys")
        .push(key_name)
        .push("requestToken");
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_ws_url_basic() {
        let url = build_ws_url("realtime.ably.io", "my-token", None);
        let url = url.unwrap();
        assert!(url.starts_with("wss://realtime.ably.io/"));
        assert!(url.contains("access_token=my-token"));
        assert!(url.contains("format=msgpack"));
        assert!(url.contains("v=5"));
        assert!(url.contains("heartbeats=true"));
        assert!(url.contains("echo=false"));
        let expected_agent = format!("agent=ably-subscriber-rs%2F{}", env!("CARGO_PKG_VERSION"));
        assert!(url.contains(&expected_agent));
        assert!(!url.contains("resume="));
    }

    #[test]
    fn build_ws_url_with_resume() {
        let url = build_ws_url("realtime.ably.io", "my-token", Some("conn-key!abc"));
        let url = url.unwrap();
        assert!(url.contains("resume=conn-key"));
        assert!(!url.contains("connection_serial"));
    }

    #[test]
    fn build_ws_url_custom_host() {
        let url = build_ws_url("sandbox-realtime.ably.io", "tok", None);
        let url = url.unwrap();
        assert!(url.starts_with("wss://sandbox-realtime.ably.io/"));
    }

    #[test]
    fn rest_host_default() {
        assert_eq!(rest_host("realtime.ably.io"), "rest.ably.io");
    }

    #[test]
    fn rest_host_custom() {
        assert_eq!(rest_host("custom.example.com"), "custom.example.com");
    }

    #[test]
    fn build_token_request_url_basic() {
        let url = build_token_request_url("rest.ably.io", "testKey.testId").unwrap();

        assert_eq!(
            url.as_str(),
            "https://rest.ably.io/keys/testKey.testId/requestToken"
        );
    }

    #[test]
    fn build_token_request_url_localhost_uses_http() {
        let url = build_token_request_url("127.0.0.1:9000", "testKey.testId").unwrap();

        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9000/keys/testKey.testId/requestToken"
        );
    }

    #[test]
    fn build_token_request_url_encodes_key_name_as_single_segment() {
        let url = build_token_request_url("rest.ably.io", "a/b?c#d% e").unwrap();

        assert_eq!(
            url.as_str(),
            "https://rest.ably.io/keys/a%2Fb%3Fc%23d%25%20e/requestToken"
        );
    }

    #[test]
    fn build_token_request_url_preserves_preencoded_key_name_as_raw_text() {
        let url = build_token_request_url("rest.ably.io", "%2F").unwrap();

        assert_eq!(url.as_str(), "https://rest.ably.io/keys/%252F/requestToken");
    }

    fn assert_websocket_endpoint(
        url: &str,
        scheme: &str,
        expected_host: url::Host<&str>,
        expected_port: Option<u16>,
    ) {
        let parsed = url::Url::parse(url).unwrap();
        assert_eq!(parsed.scheme(), scheme);
        assert_eq!(parsed.host(), Some(expected_host));
        assert_eq!(parsed.port(), expected_port);
    }

    #[test]
    fn build_ws_url_localhost_uses_ws() {
        let url = build_ws_url("127.0.0.1:9000", "tok", None).unwrap();
        assert_websocket_endpoint(
            &url,
            "ws",
            url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST),
            Some(9000),
        );

        let url = build_ws_url("localhost:9000", "tok", None).unwrap();
        assert_websocket_endpoint(&url, "ws", url::Host::Domain("localhost"), Some(9000));

        let url = build_ws_url("LOCALHOST:9000", "tok", None).unwrap();
        assert_websocket_endpoint(&url, "ws", url::Host::Domain("localhost"), Some(9000));

        let url = build_ws_url("[::1]:9000", "tok", None).unwrap();
        assert_websocket_endpoint(
            &url,
            "ws",
            url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST),
            Some(9000),
        );
    }

    #[test]
    fn build_ws_url_localhost_prefixes_use_wss() {
        let cases = [
            (
                "localhost.evil.com",
                url::Host::Domain("localhost.evil.com"),
            ),
            (
                "127.0.0.1.attacker.com",
                url::Host::Domain("127.0.0.1.attacker.com"),
            ),
            (
                "127.0.0.10",
                url::Host::Ipv4(std::net::Ipv4Addr::new(127, 0, 0, 10)),
            ),
        ];

        for (host, expected_host) in cases {
            let url = build_ws_url(host, "tok", None).unwrap();
            assert_websocket_endpoint(&url, "wss", expected_host, None);
        }
    }

    #[test]
    fn endpoint_builders_reject_base_url_inputs() {
        let cases = [
            "example.com/path",
            "example.com?x=1",
            "example.com#frag",
            "user@example.com",
            "user:pass@example.com",
        ];

        for host in cases {
            assert!(matches!(
                build_ws_url(host, "tok", None),
                Err(Error::InvalidEndpointHost)
            ));
            assert!(matches!(
                build_token_request_url(host, "testKey.testId"),
                Err(Error::InvalidEndpointHost)
            ));
        }
    }

    #[test]
    fn invalid_endpoint_host_error_does_not_include_raw_host() {
        let err = build_ws_url("user:secret@example.com", "tok", None).unwrap_err();
        let message = err.to_string();

        assert_eq!(message, "Invalid Ably endpoint host");
        assert!(!message.contains("user"));
        assert!(!message.contains("secret"));
        assert!(!message.contains("example.com"));
    }
}
