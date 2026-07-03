use std::fmt::Write as _;

/// HTTP method for a generated API route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
    Options,
}

impl Method {
    /// Return the uppercase HTTP method string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
            Self::Options => "OPTIONS",
        }
    }
}

/// Method and path for a generated API route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Route {
    pub method: Method,
    pub path: &'static str,
}

impl Route {
    /// Create a generated API route descriptor.
    #[must_use]
    pub const fn new(method: Method, path: &'static str) -> Self {
        Self { method, path }
    }

    /// Build an absolute URL for this route from a base API URL.
    #[must_use]
    pub fn url(self, base_url: &str) -> String {
        url_from_base_and_path(base_url, self.path)
    }
}

/// Method and path template for a generated API route with path params.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteTemplate {
    pub method: Method,
    pub path: &'static str,
}

impl RouteTemplate {
    /// Create a generated API route template.
    #[must_use]
    pub const fn new(method: Method, path: &'static str) -> Self {
        Self { method, path }
    }
}

/// Method and concrete path for a generated route with path params applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRoute {
    pub method: Method,
    pub path: String,
}

impl ResolvedRoute {
    /// Create a generated route descriptor with path params applied.
    #[must_use]
    pub fn new(method: Method, path: String) -> Self {
        Self { method, path }
    }

    /// Build an absolute URL for this resolved route from a base API URL.
    #[must_use]
    pub fn url(&self, base_url: &str) -> String {
        url_from_base_and_path(base_url, &self.path)
    }
}

pub(crate) fn encode_path_segment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if is_unreserved_path_byte(byte) {
            output.push(char::from(byte));
        } else {
            let _ = write!(output, "%{byte:02X}");
        }
    }
    output
}

fn url_from_base_and_path(base_url: &str, path: &str) -> String {
    assert!(path.starts_with('/'), "api route path must start with '/'");
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn is_unreserved_path_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}
