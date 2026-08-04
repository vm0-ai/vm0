//! Authenticated HTTP foundation for generated vm0 API routes.

use std::sync::Arc;
use std::time::Duration;

use api_contracts::generated::constants::client::headers::{
    CLIENT_REQUEST_ID_HEADER, CLIENT_SESSION_ID_HEADER, CLIENT_TYPE_HEADER, CLIENT_VERSION_HEADER,
};
use api_contracts::generated::constants::client::types::CLIENT_TYPE_CLI;
use api_contracts::{Method, ResolvedRoute, Route};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Request, Response};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::build::BuildInfo;
use crate::config::RuntimeConfig;
use crate::error::{ApiError, CliError};
use crate::secret::{SecretString, redact_secrets};

const VERCEL_BYPASS_HEADER: &str = "x-vercel-protection-bypass";

/// Shared authenticated client for generated vm0 API routes.
///
/// Reqwest's `rustls` feature uses the platform certificate verifier. Proxy
/// values captured by [`RuntimeConfig`] are applied only to this client, so
/// linking the release-tracking library into runner cannot change runner HTTP
/// behavior through Cargo feature unification.
#[derive(Clone)]
pub struct ApiClient {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    api_url: String,
    auth: HeaderValue,
    vercel_bypass: Option<HeaderValue>,
    client_headers: ClientHeaders,
    secrets: Arc<ErrorSecrets>,
}

#[derive(Clone)]
struct ClientHeaders {
    client_type: HeaderValue,
    client_version: HeaderValue,
    client_session_id: HeaderValue,
}

struct ErrorSecrets {
    token: SecretString,
    vercel_bypass: Option<SecretString>,
    proxies: Vec<SecretString>,
}

/// Request builder that finalizes auth and generated client headers after all
/// caller customization, preventing spoofed values from overriding them.
#[must_use = "request builders do nothing until sent or built"]
pub struct ApiRequestBuilder {
    client: Client,
    builder: reqwest::RequestBuilder,
    auth: HeaderValue,
    vercel_bypass: Option<HeaderValue>,
    client_headers: ClientHeaders,
    secrets: Arc<ErrorSecrets>,
}

impl ApiClient {
    /// Build the shared client from captured native runtime configuration.
    pub fn from_config(config: &RuntimeConfig) -> Result<Self, CliError> {
        let token = config.token().ok_or(CliError::NotAuthenticated)?;
        let auth = sensitive_header(&format!("Bearer {}", token.expose()))?;
        let vercel_bypass = config
            .vercel_bypass()
            .map(|value| sensitive_header(value.expose()))
            .transpose()?;
        let session_id = Uuid::new_v4().to_string();
        let client_session_id =
            HeaderValue::from_str(&session_id).map_err(|_| CliError::HttpClient)?;
        let client = build_client(config)?;
        let secrets = Arc::new(ErrorSecrets {
            token: token.clone(),
            vercel_bypass: config.vercel_bypass().cloned(),
            proxies: config
                .proxy()
                .http()
                .into_iter()
                .chain(config.proxy().https())
                .cloned()
                .collect(),
        });

        Ok(Self {
            inner: Arc::new(Inner {
                client,
                api_url: config.api_url().to_string(),
                auth,
                vercel_bypass,
                client_headers: ClientHeaders {
                    client_type: HeaderValue::from_static(CLIENT_TYPE_CLI),
                    client_version: HeaderValue::from_static(BuildInfo::current().version),
                    client_session_id,
                },
                secrets,
            }),
        })
    }

    /// Build a request for a generated static route.
    pub fn request_route(&self, route: Route) -> ApiRequestBuilder {
        self.request(method(route.method), route.url(&self.inner.api_url))
    }

    /// Build a request for a generated route whose path parameters are resolved.
    pub fn request_resolved_route(&self, route: &ResolvedRoute) -> ApiRequestBuilder {
        self.request(method(route.method), route.url(&self.inner.api_url))
    }

    fn request(&self, method: reqwest::Method, url: String) -> ApiRequestBuilder {
        ApiRequestBuilder {
            client: self.inner.client.clone(),
            builder: self.inner.client.request(method, url),
            auth: self.inner.auth.clone(),
            vercel_bypass: self.inner.vercel_bypass.clone(),
            client_headers: self.inner.client_headers.clone(),
            secrets: self.inner.secrets.clone(),
        }
    }
}

impl ApiRequestBuilder {
    /// Add a caller header. Auth and generated client headers are reapplied at
    /// finalization and cannot be overridden through this method.
    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.builder = self.builder.header(name, value);
        self
    }

    /// Serialize a JSON body. Bodyless requests do not receive Content-Type.
    pub fn json<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.builder = self.builder.json(value);
        self
    }

    /// Serialize query parameters.
    pub fn query<T: Serialize + ?Sized>(mut self, query: &T) -> Self {
        self.builder = self.builder.query(query);
        self
    }

    /// Override the timeout for this request.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.builder = self.builder.timeout(timeout);
        self
    }

    /// Finalize a request without sending it.
    pub fn build(self) -> Result<Request, CliError> {
        let mut request = self
            .builder
            .build()
            .map_err(|error| transport_error(error, &self.secrets))?;
        apply_protected_headers(
            request.headers_mut(),
            &self.auth,
            self.vercel_bypass.as_ref(),
            &self.client_headers,
        )?;
        Ok(request)
    }

    /// Send the request, parsing non-success API error bodies through the
    /// shared error model.
    pub async fn send(self, default_error_message: &str) -> Result<Response, CliError> {
        let client = self.client.clone();
        let secrets = self.secrets.clone();
        let request = self.build()?;
        let response = client
            .execute(request)
            .await
            .map_err(|error| transport_error(error, &secrets))?;
        if response.status().is_success() {
            return Ok(response);
        }
        Err(parse_api_error(response, default_error_message, &secrets).await)
    }
}

fn apply_protected_headers(
    headers: &mut HeaderMap,
    auth: &HeaderValue,
    vercel_bypass: Option<&HeaderValue>,
    client_headers: &ClientHeaders,
) -> Result<(), CliError> {
    let request_id = Uuid::new_v4().to_string();
    let request_id = HeaderValue::from_str(&request_id).map_err(|_| CliError::HttpClient)?;
    headers.insert(reqwest::header::AUTHORIZATION, auth.clone());
    if let Some(vercel_bypass) = vercel_bypass {
        headers.insert(VERCEL_BYPASS_HEADER, vercel_bypass.clone());
    }
    headers.insert(CLIENT_VERSION_HEADER, client_headers.client_version.clone());
    headers.insert(CLIENT_TYPE_HEADER, client_headers.client_type.clone());
    headers.insert(
        CLIENT_SESSION_ID_HEADER,
        client_headers.client_session_id.clone(),
    );
    headers.insert(CLIENT_REQUEST_ID_HEADER, request_id);
    Ok(())
}

fn sensitive_header(value: &str) -> Result<HeaderValue, CliError> {
    let mut value = HeaderValue::from_str(value).map_err(|_| CliError::HttpClient)?;
    value.set_sensitive(true);
    Ok(value)
}

fn transport_error(error: reqwest::Error, secrets: &ErrorSecrets) -> CliError {
    let message = error.without_url().to_string();
    CliError::transport(secrets.redact(&message))
}

async fn parse_api_error(
    response: Response,
    default_message: &str,
    secrets: &ErrorSecrets,
) -> CliError {
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.ok();
    let message = body
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_message);
    let code = body
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("UNKNOWN");
    CliError::Api(ApiError::new(
        status,
        secrets.redact(code),
        secrets.redact(message),
    ))
}

impl ErrorSecrets {
    fn redact(&self, text: &str) -> String {
        let mut secrets = Vec::with_capacity(2 + self.proxies.len());
        secrets.push(&self.token);
        secrets.extend(self.vercel_bypass.as_ref());
        secrets.extend(&self.proxies);
        redact_secrets(text, &secrets)
    }
}

fn build_client(config: &RuntimeConfig) -> Result<Client, CliError> {
    let mut builder = Client::builder();
    let http_proxy = config.proxy().http();
    let https_proxy = config.proxy().https().or(http_proxy);
    let no_proxy = config
        .proxy()
        .no_proxy()
        .and_then(|value| reqwest::NoProxy::from_string(value.expose()));
    if let Some(value) = http_proxy {
        let proxy = reqwest::Proxy::http(value.expose())
            .map_err(|_| CliError::HttpClient)?
            .no_proxy(no_proxy.clone());
        builder = builder.proxy(proxy);
    }
    if let Some(value) = https_proxy {
        let proxy = reqwest::Proxy::https(value.expose())
            .map_err(|_| CliError::HttpClient)?
            .no_proxy(no_proxy);
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|_| CliError::HttpClient)
}

const fn method(method: Method) -> reqwest::Method {
    match method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
        Method::Put => reqwest::Method::PUT,
        Method::Patch => reqwest::Method::PATCH,
        Method::Delete => reqwest::Method::DELETE,
        Method::Head => reqwest::Method::HEAD,
        Method::Options => reqwest::Method::OPTIONS,
    }
}
