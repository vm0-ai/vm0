use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::{HarnessError, Result};

const CASE_SCHEMA_REFERENCE: &str = "../schema.json";
const CASE_SCHEMA_VERSION: u32 = 1;
const RESERVED_ENVIRONMENT_KEYS: [&str; 8] = [
    "HOME",
    "NO_COLOR",
    "PATH",
    "TERM",
    "TMPDIR",
    "VM0_API_BACKEND_URL",
    "XDG_CACHE_HOME",
    "ZERO_CLI_PARITY_NPX_TARGET",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Case {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub schema_version: u32,
    pub name: String,
    pub description: String,
    pub argv: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub stdin: String,
    pub working_directory: PathBuf,
    pub terminal_mode: TerminalMode,
    pub timeout_ms: u64,
    pub mock_http: MockHttp,
    pub filesystem: Filesystem,
    pub normalizations: Vec<Normalization>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalMode {
    Pipe,
    Pty,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MockHttp {
    pub capture_headers: Vec<String>,
    pub exchanges: Vec<HttpExchange>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpExchange {
    pub request: ExpectedRequest,
    pub response: MockResponse,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MockResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Filesystem {
    pub seed: Vec<SeedEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SeedEntry {
    File {
        path: PathBuf,
        content: String,
        mode: u32,
    },
    Directory {
        path: PathBuf,
        mode: u32,
    },
    Symlink {
        path: PathBuf,
        target: PathBuf,
    },
}

impl SeedEntry {
    pub fn path(&self) -> &Path {
        match self {
            Self::File { path, .. } | Self::Directory { path, .. } | Self::Symlink { path, .. } => {
                path
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Normalization {
    RuntimeValue {
        value: RuntimeValue,
        targets: BTreeSet<TextTarget>,
    },
    UuidHttpHeader {
        header: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeValue {
    WorkspacePath,
    MockHttpUrl,
    HomePath,
    TempPath,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum TextTarget {
    Stdout,
    Stderr,
    HttpRequestBody,
    FilesystemFileContent,
}

#[derive(Debug)]
pub struct LoadedCase {
    pub path: PathBuf,
    pub case: Case,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Observation {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub termination: Termination,
    pub requests: Vec<RequestObservation>,
    pub filesystem: Vec<FilesystemEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Termination {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestObservation {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Vec<u8>,
    pub headers: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FilesystemEntry {
    pub path: String,
    pub mode: u32,
    pub kind: FilesystemEntryKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FilesystemEntryKind {
    File(Vec<u8>),
    Directory,
    Symlink(String),
}

#[derive(Clone, Debug)]
pub struct RuntimeValues {
    pub workspace_path: String,
    pub mock_http_url: String,
    pub home_path: String,
    pub temp_path: String,
}

pub fn load_cases(directory: &Path) -> Result<Vec<LoadedCase>> {
    let mut paths = Vec::new();
    collect_case_paths(directory, &mut paths)?;
    paths.sort();
    if paths.is_empty() {
        return Err(HarnessError::new(format!(
            "no JSON parity cases found under {}",
            directory.display()
        )));
    }

    let mut names = BTreeSet::new();
    let mut cases = Vec::with_capacity(paths.len());
    for path in paths {
        let content = fs::read_to_string(&path).map_err(|error| {
            HarnessError::new(format!("read parity case {}: {error}", path.display()))
        })?;
        let case: Case = serde_json::from_str(&content).map_err(|error| {
            HarnessError::new(format!("parse parity case {}: {error}", path.display()))
        })?;
        validate_case(&case, &path)?;
        if !names.insert(case.name.clone()) {
            return Err(HarnessError::new(format!(
                "duplicate parity case name {:?} at {}",
                case.name,
                path.display()
            )));
        }
        cases.push(LoadedCase { path, case });
    }
    Ok(cases)
}

fn collect_case_paths(directory: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    let entries = fs::read_dir(directory).map_err(|error| {
        HarnessError::new(format!(
            "read parity case directory {}: {error}",
            directory.display()
        ))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            HarnessError::new(format!(
                "read entry in parity case directory {}: {error}",
                directory.display()
            ))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            HarnessError::new(format!(
                "inspect parity case path {}: {error}",
                entry.path().display()
            ))
        })?;
        if file_type.is_dir() {
            collect_case_paths(&entry.path(), paths)?;
        } else if entry.path().extension() == Some(OsStr::new("json")) {
            paths.push(entry.path());
        }
    }
    Ok(())
}

fn validate_case(case: &Case, path: &Path) -> Result<()> {
    validate_case_metadata(case, path)?;
    validate_relative_path(&case.working_directory, true, "workingDirectory", path)?;
    validate_environment(&case.environment, path)?;
    validate_filesystem(&case.filesystem, path)?;
    let capture_headers = validate_mock_http(&case.mock_http, path)?;
    validate_normalizations(&case.normalizations, &capture_headers, path)
}

fn validate_case_metadata(case: &Case, path: &Path) -> Result<()> {
    if case.schema != CASE_SCHEMA_REFERENCE || case.schema_version != CASE_SCHEMA_VERSION {
        return Err(HarnessError::new(format!(
            "{} must use schema reference {CASE_SCHEMA_REFERENCE:?} and schema version {CASE_SCHEMA_VERSION}",
            path.display()
        )));
    }
    if case.name.trim().is_empty() || case.description.trim().is_empty() {
        return Err(HarnessError::new(format!(
            "{} must have a non-empty name and description",
            path.display()
        )));
    }
    if case.timeout_ms == 0 {
        return Err(HarnessError::new(format!(
            "{} timeoutMs must be greater than zero",
            path.display()
        )));
    }
    Ok(())
}

fn validate_environment(environment: &BTreeMap<String, String>, path: &Path) -> Result<()> {
    for (key, value) in environment {
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(HarnessError::new(format!(
                "{} contains invalid environment key {key:?}",
                path.display()
            )));
        }
        if RESERVED_ENVIRONMENT_KEYS.contains(&key.as_str()) {
            return Err(HarnessError::new(format!(
                "{} may not override harness-owned environment key {key}",
                path.display()
            )));
        }
        if value.contains('\0') {
            return Err(HarnessError::new(format!(
                "{} environment value for {key:?} contains a NUL byte",
                path.display()
            )));
        }
    }
    Ok(())
}

fn validate_filesystem(filesystem: &Filesystem, path: &Path) -> Result<()> {
    let mut seed_paths = BTreeSet::new();
    for entry in &filesystem.seed {
        validate_relative_path(entry.path(), false, "filesystem seed path", path)?;
        if !seed_paths.insert(entry.path().to_path_buf()) {
            return Err(HarnessError::new(format!(
                "{} contains duplicate filesystem seed path {}",
                path.display(),
                entry.path().display()
            )));
        }
        match entry {
            SeedEntry::File { mode, .. } | SeedEntry::Directory { mode, .. } => {
                if *mode > 0o7777 {
                    return Err(HarnessError::new(format!(
                        "{} contains invalid filesystem mode {mode}",
                        path.display()
                    )));
                }
            }
            SeedEntry::Symlink { target, .. } => {
                validate_relative_path(target, false, "symlink target", path)?;
            }
        }
    }
    Ok(())
}

fn validate_mock_http(mock_http: &MockHttp, path: &Path) -> Result<BTreeSet<String>> {
    let capture_headers = mock_http
        .capture_headers
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if capture_headers.len() != mock_http.capture_headers.len() {
        return Err(HarnessError::new(format!(
            "{} contains duplicate captureHeaders",
            path.display()
        )));
    }
    for header in &mock_http.capture_headers {
        if !is_http_token(header) || header.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err(HarnessError::new(format!(
                "{} capture header {header:?} must be non-empty lowercase ASCII",
                path.display()
            )));
        }
    }

    for exchange in &mock_http.exchanges {
        validate_http_exchange(exchange, path)?;
    }
    Ok(capture_headers)
}

fn validate_http_exchange(exchange: &HttpExchange, path: &Path) -> Result<()> {
    let request = &exchange.request;
    if request.method.is_empty()
        || request.method.bytes().any(|byte| byte.is_ascii_lowercase())
        || !request.path.starts_with('/')
        || request.query.starts_with('?')
    {
        return Err(HarnessError::new(format!(
            "{} contains an invalid mock HTTP request definition",
            path.display()
        )));
    }
    if !(100..=599).contains(&exchange.response.status) {
        return Err(HarnessError::new(format!(
            "{} contains invalid mock HTTP status {}",
            path.display(),
            exchange.response.status
        )));
    }
    for (header, value) in &exchange.response.headers {
        if !is_http_token(header) {
            return Err(HarnessError::new(format!(
                "{} contains invalid mock response header name {header:?}",
                path.display()
            )));
        }
        if header.eq_ignore_ascii_case("content-length")
            || header.eq_ignore_ascii_case("connection")
        {
            return Err(HarnessError::new(format!(
                "{} mock response must not set harness-owned header {header:?}",
                path.display()
            )));
        }
        if value.contains('\r') || value.contains('\n') {
            return Err(HarnessError::new(format!(
                "{} mock response header {header:?} contains a line break",
                path.display()
            )));
        }
    }
    Ok(())
}

fn validate_normalizations(
    normalizations: &[Normalization],
    capture_headers: &BTreeSet<String>,
    path: &Path,
) -> Result<()> {
    for normalization in normalizations {
        match normalization {
            Normalization::RuntimeValue { targets, .. } if targets.is_empty() => {
                return Err(HarnessError::new(format!(
                    "{} runtime-value normalization must name at least one target",
                    path.display()
                )));
            }
            Normalization::UuidHttpHeader { header }
                if !capture_headers.contains(header.as_str()) =>
            {
                return Err(HarnessError::new(format!(
                    "{} UUID normalization header {header:?} is not listed in captureHeaders",
                    path.display()
                )));
            }
            _ => {}
        }
    }
    Ok(())
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn validate_relative_path(
    value: &Path,
    allow_current_directory: bool,
    field: &str,
    case_path: &Path,
) -> Result<()> {
    if value.as_os_str().is_empty() || value.is_absolute() {
        return Err(HarnessError::new(format!(
            "{} {field} must be a non-empty relative path",
            case_path.display()
        )));
    }
    let mut normal_components = 0_usize;
    for component in value.components() {
        match component {
            Component::Normal(_) => normal_components += 1,
            Component::CurDir if allow_current_directory => {}
            Component::CurDir => {
                return Err(HarnessError::new(format!(
                    "{} {field} must not contain a current-directory component",
                    case_path.display()
                )));
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(HarnessError::new(format!(
                    "{} {field} must stay inside the case workspace",
                    case_path.display()
                )));
            }
        }
    }
    if normal_components == 0 && !allow_current_directory {
        return Err(HarnessError::new(format!(
            "{} {field} must name a workspace entry",
            case_path.display()
        )));
    }
    Ok(())
}
