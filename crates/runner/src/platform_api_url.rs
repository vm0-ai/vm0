use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

use crate::error::{RunnerError, RunnerResult};

const HTTPS_OR_LOOPBACK_HTTP_MESSAGE: &str =
    "platform API URL must use https unless the http host is loopback";

pub(crate) fn validate_platform_api_url(api_url: &str) -> RunnerResult<()> {
    let parsed = Url::parse(api_url).map_err(|e| {
        RunnerError::Config(format!(
            "invalid platform API URL: {e}; {HTTPS_OR_LOOPBACK_HTTP_MESSAGE}"
        ))
    })?;
    if !has_scheme_authority_separator(api_url, parsed.scheme()) {
        return Err(RunnerError::Config(format!(
            "invalid platform API URL: missing scheme authority separator; {HTTPS_OR_LOOPBACK_HTTP_MESSAGE}"
        )));
    }
    let host = parsed.host().ok_or_else(|| {
        RunnerError::Config(format!(
            "invalid platform API URL: missing host; {HTTPS_OR_LOOPBACK_HTTP_MESSAGE}"
        ))
    })?;

    match parsed.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(host) => Ok(()),
        "http" => Err(RunnerError::Config(HTTPS_OR_LOOPBACK_HTTP_MESSAGE.into())),
        scheme => Err(RunnerError::Config(format!(
            "invalid platform API URL scheme `{scheme}`; {HTTPS_OR_LOOPBACK_HTTP_MESSAGE}"
        ))),
    }
}

fn has_scheme_authority_separator(api_url: &str, parsed_scheme: &str) -> bool {
    let Some((raw_scheme, rest)) = api_url.split_once(':') else {
        return false;
    };
    raw_scheme.eq_ignore_ascii_case(parsed_scheme) && rest.starts_with("//")
}

fn is_loopback_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => is_loopback_ipv6(ip),
    }
}

fn is_loopback_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    ipv4_mapped_is_loopback(ip)
}

fn ipv4_mapped_is_loopback(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if segments[..5] != [0, 0, 0, 0, 0] || segments[5] != 0xffff {
        return false;
    }
    let octets = [
        (segments[6] >> 8) as u8,
        segments[6] as u8,
        (segments[7] >> 8) as u8,
        segments[7] as u8,
    ];
    Ipv4Addr::from(octets).is_loopback()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_platform_api_urls() {
        for url in [
            "https://api.vm0.ai",
            "https://api.vm0.ai:443",
            "https://api.vm0.ai/api",
            "https://127.0.0.1",
            "https://[2001:db8::1]:8443",
        ] {
            validate_platform_api_url(url).unwrap_or_else(|err| {
                panic!("expected {url} to be accepted, got {err}");
            });
        }
    }

    #[test]
    fn accepts_loopback_http_platform_api_urls() {
        for url in [
            "http://localhost",
            "http://LOCALHOST:3000",
            "http://127.0.0.1:3000",
            "http://127.1.2.3:3000",
            "http://[::1]:3000",
            "http://[::ffff:127.0.0.1]:3000",
        ] {
            validate_platform_api_url(url).unwrap_or_else(|err| {
                panic!("expected {url} to be accepted, got {err}");
            });
        }
    }

    #[test]
    fn rejects_non_loopback_http_platform_api_urls() {
        for url in [
            "http://api.vm0.ai",
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.1.10",
            "http://169.254.1.1",
            "http://0.0.0.0",
            "http://[::ffff:10.0.0.1]",
            "http://localhost.",
        ] {
            let err = validate_platform_api_url(url).unwrap_err();
            assert!(
                err.to_string().contains("platform API URL must use https"),
                "{url} returned unexpected error: {err}"
            );
        }
    }

    #[test]
    fn rejects_unsupported_or_malformed_platform_api_urls() {
        for url in [
            "ftp://api.vm0.ai",
            "file:///etc/passwd",
            "//api.vm0.ai",
            "https:path-without-host",
            "http://",
            "http://api.vm0.ai:99999",
        ] {
            let err = match validate_platform_api_url(url) {
                Ok(()) => panic!("expected {url} to be rejected"),
                Err(err) => err,
            };
            assert!(
                err.to_string().contains("platform API URL"),
                "{url} returned unexpected error: {err}"
            );
        }
    }
}
