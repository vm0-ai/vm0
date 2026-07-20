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
    /// Path for this route.
    ///
    /// The path must begin with `/` before calling [`Route::url`].
    pub path: &'static str,
}

impl Route {
    /// Create a generated API route descriptor.
    ///
    /// `path` must begin with `/` before calling [`Self::url`].
    #[must_use]
    pub const fn new(method: Method, path: &'static str) -> Self {
        Self { method, path }
    }

    /// Build a URL by appending this route's path to a base API URL.
    ///
    /// If `base_url` is empty, returns the route path unchanged.
    ///
    /// # Panics
    ///
    /// Panics if this route's path does not begin with `/`.
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
    /// Concrete path for this route.
    ///
    /// The path must begin with `/` before calling [`ResolvedRoute::url`].
    pub path: String,
}

impl ResolvedRoute {
    /// Create a generated route descriptor with path params applied.
    ///
    /// `path` must begin with `/` before calling [`Self::url`].
    #[must_use]
    pub fn new(method: Method, path: String) -> Self {
        Self { method, path }
    }

    /// Build a URL by appending this route's path to a base API URL.
    ///
    /// If `base_url` is empty, returns the route path unchanged.
    ///
    /// # Panics
    ///
    /// Panics if this route's path does not begin with `/`.
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
