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
        format!("{}{}", base_url.trim_end_matches('/'), self.path)
    }
}
