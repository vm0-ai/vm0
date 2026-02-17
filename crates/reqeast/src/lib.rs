//! Thin wrapper around [`reqwest`] that auto-installs the `ring` TLS crypto
//! provider on first use.
//!
//! Use [`builder()`] instead of `reqwest::Client::builder()` and [`get()`]
//! instead of `reqwest::get()` to ensure the provider is installed.

use std::sync::Once;

static INIT: Once = Once::new();

fn ensure_provider() {
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Create a [`reqwest::ClientBuilder`] with TLS provider auto-initialized.
pub fn builder() -> reqwest::ClientBuilder {
    ensure_provider();
    reqwest::Client::builder()
}

/// Send a GET request to the given URL (convenience wrapper).
pub async fn get<U: reqwest::IntoUrl>(url: U) -> reqwest::Result<reqwest::Response> {
    ensure_provider();
    reqwest::get(url).await
}

// Re-export commonly used types.
pub use reqwest::{Client, Error, IntoUrl, Method, RequestBuilder, Response, StatusCode};
