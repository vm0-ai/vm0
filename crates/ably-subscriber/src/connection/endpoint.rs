use crate::Error;

pub(crate) const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
pub(super) const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = concat!("ably-subscriber-rs/", env!("CARGO_PKG_VERSION"));

pub(super) fn is_localhost(host: &str) -> bool {
    let Ok(url) = url::Url::parse(&format!("http://{host}/")) else {
        return false;
    };

    match url.host() {
        Some(url::Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") => true,
        Some(url::Host::Ipv4(addr)) if addr == std::net::Ipv4Addr::LOCALHOST => true,
        Some(url::Host::Ipv6(addr)) if addr == std::net::Ipv6Addr::LOCALHOST => true,
        _ => false,
    }
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
    let scheme = if is_localhost(host) { "ws" } else { "wss" };
    let mut u = url::Url::parse(&format!("{scheme}://{host}/"))?;
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
}
