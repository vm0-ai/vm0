use std::collections::{BTreeMap, BTreeSet};

use uuid::Uuid;

use crate::model::{
    Case, FilesystemEntry, FilesystemEntryKind, Normalization, Observation, RuntimeValue,
    RuntimeValues, TextTarget,
};
use crate::{HarnessError, Result};

const DIAGNOSTIC_CONTEXT_BEFORE: usize = 48;
const DIAGNOSTIC_CONTEXT_AFTER: usize = 160;

pub fn normalize_observation(
    observation: &mut Observation,
    case: &Case,
    runtime_values: &RuntimeValues,
) -> Result<()> {
    for normalization in &case.normalizations {
        if let Normalization::RuntimeValue { value, targets } = normalization {
            normalize_runtime_value(observation, *value, targets, runtime_values)?;
        }
    }

    let uuid_headers = case
        .normalizations
        .iter()
        .filter_map(|normalization| match normalization {
            Normalization::UuidHttpHeader { header } => Some(header.as_str()),
            Normalization::RuntimeValue { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    normalize_uuid_headers(observation, &uuid_headers)
}

fn normalize_runtime_value(
    observation: &mut Observation,
    value: RuntimeValue,
    targets: &BTreeSet<TextTarget>,
    runtime_values: &RuntimeValues,
) -> Result<()> {
    let (source, replacement) = match value {
        RuntimeValue::WorkspacePath => (&runtime_values.workspace_path, "<WORKSPACE>"),
        RuntimeValue::MockHttpUrl => (&runtime_values.mock_http_url, "<MOCK_HTTP_URL>"),
        RuntimeValue::HomePath => (&runtime_values.home_path, "<HOME>"),
        RuntimeValue::TempPath => (&runtime_values.temp_path, "<TEMP>"),
    };
    if source.is_empty() {
        return Err(HarnessError::new(format!(
            "runtime value {value:?} is empty"
        )));
    }

    let source = source.as_bytes();
    let replacement = replacement.as_bytes();
    let mut replacements = 0_usize;
    if targets.contains(&TextTarget::Stdout) {
        replacements += replace_bytes(&mut observation.stdout, source, replacement);
    }
    if targets.contains(&TextTarget::Stderr) {
        replacements += replace_bytes(&mut observation.stderr, source, replacement);
    }
    if targets.contains(&TextTarget::HttpRequestBody) {
        for request in &mut observation.requests {
            replacements += replace_bytes(&mut request.body, source, replacement);
        }
    }
    if targets.contains(&TextTarget::FilesystemFileContent) {
        for entry in &mut observation.filesystem {
            if let FilesystemEntryKind::File(content) = &mut entry.kind {
                replacements += replace_bytes(content, source, replacement);
            }
        }
    }
    if replacements == 0 {
        return Err(HarnessError::new(format!(
            "runtime-value normalization {value:?} did not match any declared target"
        )));
    }
    Ok(())
}

fn normalize_uuid_headers(
    observation: &mut Observation,
    header_names: &BTreeSet<&str>,
) -> Result<()> {
    if header_names.is_empty() {
        return Ok(());
    }
    let mut identities: BTreeMap<Uuid, Vec<u8>> = BTreeMap::new();
    let mut matched_headers = BTreeSet::new();
    for request in &mut observation.requests {
        for (name, value) in &mut request.headers {
            if !header_names.contains(name.as_str()) {
                continue;
            }
            matched_headers.insert(name.clone());
            let text = std::str::from_utf8(value).map_err(|error| {
                HarnessError::new(format!(
                    "UUID header {name:?} is not UTF-8 and cannot be normalized: {error}"
                ))
            })?;
            let uuid = Uuid::parse_str(text).map_err(|error| {
                HarnessError::new(format!(
                    "UUID header {name:?} has invalid value {text:?}: {error}"
                ))
            })?;
            let next_identity = identities.len() + 1;
            let normalized = identities
                .entry(uuid)
                .or_insert_with(|| format!("<UUID:{next_identity}>").into_bytes());
            *value = normalized.clone();
        }
    }

    for header in header_names {
        if !matched_headers.contains(*header) {
            return Err(HarnessError::new(format!(
                "UUID normalization header {header:?} was not present in any request"
            )));
        }
    }
    Ok(())
}

fn replace_bytes(value: &mut Vec<u8>, source: &[u8], replacement: &[u8]) -> usize {
    let Some(first_match) = find_bytes(value, source) else {
        return 0;
    };
    let mut result = Vec::with_capacity(value.len());
    let mut cursor = 0_usize;
    let mut next_match = Some(first_match);
    let mut replacements = 0_usize;
    while let Some(position) = next_match {
        if let Some(prefix) = value.get(cursor..position) {
            result.extend_from_slice(prefix);
        }
        result.extend_from_slice(replacement);
        replacements += 1;
        cursor = position.saturating_add(source.len());
        next_match = value
            .get(cursor..)
            .and_then(|remaining| find_bytes(remaining, source))
            .map(|offset| cursor.saturating_add(offset));
    }
    if let Some(suffix) = value.get(cursor..) {
        result.extend_from_slice(suffix);
    }
    *value = result;
    replacements
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn compare_observations(
    case: &Case,
    typescript: &Observation,
    rust: &Observation,
) -> Option<String> {
    let mut mismatches = Vec::new();
    compare_bytes(
        "stdout",
        &typescript.stdout,
        &rust.stdout,
        false,
        &mut mismatches,
    );
    compare_bytes(
        "stderr",
        &typescript.stderr,
        &rust.stderr,
        false,
        &mut mismatches,
    );
    compare_value(
        "exit.code",
        typescript.termination.code,
        rust.termination.code,
        &mut mismatches,
    );
    compare_value(
        "exit.signal",
        typescript.termination.signal,
        rust.termination.signal,
        &mut mismatches,
    );
    compare_requests(&typescript.requests, &rust.requests, &mut mismatches);
    compare_filesystem(&typescript.filesystem, &rust.filesystem, &mut mismatches);

    if mismatches.is_empty() {
        return None;
    }
    let numbered = mismatches
        .iter()
        .enumerate()
        .map(|(index, mismatch)| format!("  {}. {mismatch}", index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "case {:?} (schema v{}): {}\n{} parity mismatch(es):\n{}",
        case.name,
        case.schema_version,
        case.description,
        mismatches.len(),
        numbered
    ))
}

fn compare_requests(
    typescript: &[crate::model::RequestObservation],
    rust: &[crate::model::RequestObservation],
    mismatches: &mut Vec<String>,
) {
    compare_value(
        "http.requestCount",
        typescript.len(),
        rust.len(),
        mismatches,
    );
    for (index, (typescript_request, rust_request)) in typescript.iter().zip(rust).enumerate() {
        compare_value(
            &format!("http[{index}].method"),
            &typescript_request.method,
            &rust_request.method,
            mismatches,
        );
        compare_value(
            &format!("http[{index}].path"),
            &typescript_request.path,
            &rust_request.path,
            mismatches,
        );
        compare_value(
            &format!("http[{index}].query"),
            &typescript_request.query,
            &rust_request.query,
            mismatches,
        );
        compare_bytes(
            &format!("http[{index}].body"),
            &typescript_request.body,
            &rust_request.body,
            false,
            mismatches,
        );

        let header_names = typescript_request
            .headers
            .keys()
            .chain(rust_request.headers.keys())
            .collect::<BTreeSet<_>>();
        for header_name in header_names {
            let label = format!("http[{index}].headers[{header_name:?}]");
            let typescript_value = typescript_request.headers.get(header_name);
            let rust_value = rust_request.headers.get(header_name);
            compare_optional_bytes(
                &label,
                typescript_value,
                rust_value,
                header_name.eq_ignore_ascii_case("authorization"),
                mismatches,
            );
        }
    }
}

fn compare_filesystem(
    typescript: &[FilesystemEntry],
    rust: &[FilesystemEntry],
    mismatches: &mut Vec<String>,
) {
    let typescript_by_path = typescript
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let rust_by_path = rust
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    let paths = typescript_by_path
        .keys()
        .chain(rust_by_path.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    for path in paths {
        let typescript_entry = typescript_by_path.get(path).copied();
        let rust_entry = rust_by_path.get(path).copied();
        match (typescript_entry, rust_entry) {
            (Some(typescript_entry), Some(rust_entry)) => {
                compare_value(
                    &format!("filesystem[{path:?}].mode"),
                    format!("{:04o}", typescript_entry.mode),
                    format!("{:04o}", rust_entry.mode),
                    mismatches,
                );
                compare_value(
                    &format!("filesystem[{path:?}].kind"),
                    filesystem_kind_name(&typescript_entry.kind),
                    filesystem_kind_name(&rust_entry.kind),
                    mismatches,
                );
                match (&typescript_entry.kind, &rust_entry.kind) {
                    (
                        FilesystemEntryKind::File(typescript_content),
                        FilesystemEntryKind::File(rust_content),
                    ) => compare_bytes(
                        &format!("filesystem[{path:?}].content"),
                        typescript_content,
                        rust_content,
                        false,
                        mismatches,
                    ),
                    (
                        FilesystemEntryKind::Symlink(typescript_target),
                        FilesystemEntryKind::Symlink(rust_target),
                    ) => compare_value(
                        &format!("filesystem[{path:?}].target"),
                        typescript_target,
                        rust_target,
                        mismatches,
                    ),
                    _ => {}
                }
            }
            (Some(entry), None) => mismatches.push(format!(
                "filesystem[{path:?}] exists only for TypeScript ({}, mode {:04o})",
                filesystem_kind_name(&entry.kind),
                entry.mode
            )),
            (None, Some(entry)) => mismatches.push(format!(
                "filesystem[{path:?}] exists only for Rust ({}, mode {:04o})",
                filesystem_kind_name(&entry.kind),
                entry.mode
            )),
            (None, None) => {}
        }
    }
}

fn filesystem_kind_name(kind: &FilesystemEntryKind) -> &'static str {
    match kind {
        FilesystemEntryKind::File(_) => "file",
        FilesystemEntryKind::Directory => "directory",
        FilesystemEntryKind::Symlink(_) => "symlink",
    }
}

fn compare_value<T: std::fmt::Debug + PartialEq>(
    label: &str,
    typescript: T,
    rust: T,
    mismatches: &mut Vec<String>,
) {
    if typescript != rust {
        mismatches.push(format!(
            "{label} differs\n       TypeScript: {typescript:?}\n       Rust:       {rust:?}"
        ));
    }
}

fn compare_optional_bytes(
    label: &str,
    typescript: Option<&Vec<u8>>,
    rust: Option<&Vec<u8>>,
    sensitive: bool,
    mismatches: &mut Vec<String>,
) {
    match (typescript, rust) {
        (Some(typescript), Some(rust)) => {
            compare_bytes(label, typescript, rust, sensitive, mismatches);
        }
        (Some(typescript), None) => mismatches.push(format!(
            "{label} differs\n       TypeScript: {}\n       Rust:       <missing>",
            render_value(typescript, sensitive)
        )),
        (None, Some(rust)) => mismatches.push(format!(
            "{label} differs\n       TypeScript: <missing>\n       Rust:       {}",
            render_value(rust, sensitive)
        )),
        (None, None) => {}
    }
}

fn compare_bytes(
    label: &str,
    typescript: &[u8],
    rust: &[u8],
    sensitive: bool,
    mismatches: &mut Vec<String>,
) {
    if typescript == rust {
        return;
    }
    let difference = typescript
        .iter()
        .zip(rust)
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| typescript.len().min(rust.len()));
    mismatches.push(format!(
        "{label} differs at byte {difference} (TypeScript {} bytes, Rust {} bytes)\n       TypeScript: {}\n       Rust:       {}",
        typescript.len(),
        rust.len(),
        render_context(typescript, difference, sensitive),
        render_context(rust, difference, sensitive)
    ));
}

fn render_value(value: &[u8], sensitive: bool) -> String {
    if sensitive {
        return format!("<redacted, {} bytes>", value.len());
    }
    render_bytes(value)
}

fn render_context(value: &[u8], difference: usize, sensitive: bool) -> String {
    if sensitive {
        return format!("<redacted, {} bytes>", value.len());
    }
    let start = difference.saturating_sub(DIAGNOSTIC_CONTEXT_BEFORE);
    let end = value
        .len()
        .min(difference.saturating_add(DIAGNOSTIC_CONTEXT_AFTER));
    let context = value.get(start..end).unwrap_or_default();
    let prefix = if start > 0 { "..." } else { "" };
    let suffix = if end < value.len() { "..." } else { "" };
    format!("{prefix}{}{suffix}", render_bytes(context))
}

fn render_bytes(value: &[u8]) -> String {
    match std::str::from_utf8(value) {
        Ok(text) => format!("{text:?}"),
        Err(_) => format!(
            "0x{}",
            value
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use crate::model::{Filesystem, MockHttp, RequestObservation, TerminalMode, Termination};

    use super::*;

    #[test]
    fn intentional_mismatches_name_each_parity_dimension() {
        let case = test_case(Vec::new());
        let typescript = Observation {
            stdout: b"alpha\n".to_vec(),
            stderr: Vec::new(),
            termination: Termination {
                code: Some(0),
                signal: None,
            },
            requests: vec![RequestObservation {
                method: "GET".to_owned(),
                path: "/left".to_owned(),
                query: String::new(),
                body: Vec::new(),
                headers: BTreeMap::new(),
            }],
            filesystem: vec![FilesystemEntry {
                path: "result.txt".to_owned(),
                mode: 0o644,
                kind: FilesystemEntryKind::File(b"left".to_vec()),
            }],
        };
        let rust = Observation {
            stdout: b"alpHa\n".to_vec(),
            stderr: b"rust error\n".to_vec(),
            termination: Termination {
                code: Some(2),
                signal: None,
            },
            requests: vec![RequestObservation {
                method: "POST".to_owned(),
                path: "/right".to_owned(),
                query: String::new(),
                body: Vec::new(),
                headers: BTreeMap::new(),
            }],
            filesystem: vec![FilesystemEntry {
                path: "result.txt".to_owned(),
                mode: 0o600,
                kind: FilesystemEntryKind::File(b"right".to_vec()),
            }],
        };

        let report = compare_observations(&case, &typescript, &rust).unwrap();

        assert!(report.contains("case \"diagnostic\" (schema v1)"));
        assert!(report.contains("stdout differs at byte 3"));
        assert!(report.contains("stderr differs"));
        assert!(report.contains("exit.code differs"));
        assert!(report.contains("http[0].method differs"));
        assert!(report.contains("http[0].path differs"));
        assert!(report.contains("filesystem[\"result.txt\"].mode differs"));
        assert!(report.contains("filesystem[\"result.txt\"].content differs"));
    }

    #[test]
    fn declared_runtime_and_uuid_values_are_normalized_narrowly() {
        let case = test_case(vec![
            Normalization::RuntimeValue {
                value: RuntimeValue::MockHttpUrl,
                targets: BTreeSet::from([TextTarget::Stdout]),
            },
            Normalization::UuidHttpHeader {
                header: "x-request-id".to_owned(),
            },
        ]);
        let mut observation = Observation {
            stdout: b"API: http://127.0.0.1:32123\n".to_vec(),
            stderr: Vec::new(),
            termination: Termination {
                code: Some(0),
                signal: None,
            },
            requests: vec![RequestObservation {
                method: "GET".to_owned(),
                path: "/".to_owned(),
                query: String::new(),
                body: Vec::new(),
                headers: BTreeMap::from([(
                    "x-request-id".to_owned(),
                    b"00000000-0000-4000-8000-000000000001".to_vec(),
                )]),
            }],
            filesystem: Vec::new(),
        };
        let runtime_values = RuntimeValues {
            workspace_path: "/tmp/workspace".to_owned(),
            mock_http_url: "http://127.0.0.1:32123".to_owned(),
            home_path: "/tmp/home".to_owned(),
            temp_path: "/tmp/tmp".to_owned(),
        };

        normalize_observation(&mut observation, &case, &runtime_values).unwrap();

        assert_eq!(observation.stdout, b"API: <MOCK_HTTP_URL>\n");
        assert_eq!(observation.requests[0].headers["x-request-id"], b"<UUID:1>");
    }

    fn test_case(normalizations: Vec<Normalization>) -> Case {
        Case {
            schema: "../schema.json".to_owned(),
            schema_version: 1,
            name: "diagnostic".to_owned(),
            description: "intentional mismatch".to_owned(),
            argv: Vec::new(),
            environment: BTreeMap::new(),
            stdin: String::new(),
            working_directory: PathBuf::from("."),
            terminal_mode: TerminalMode::Pipe,
            timeout_ms: 1_000,
            mock_http: MockHttp {
                capture_headers: vec!["x-request-id".to_owned()],
                exchanges: Vec::new(),
            },
            filesystem: Filesystem { seed: Vec::new() },
            normalizations,
        }
    }
}
