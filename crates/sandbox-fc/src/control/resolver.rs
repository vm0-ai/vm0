use std::path::{Path, PathBuf};

use sandbox::{SandboxControlError, SandboxId};

use crate::paths::{RuntimePaths, SockPaths};

/// Find the control socket for a given sandbox ID (full UUID or prefix).
///
/// Full UUIDs resolve through the exact socket path. Prefixes scan the runtime
/// socket directory for matching directories that contain a `control.sock` file.
pub(super) fn resolve_control_socket(input: &str) -> Result<PathBuf, SandboxControlError> {
    let runtime = RuntimePaths::new();
    let sock_parent = runtime.sock_base();
    resolve_control_socket_in(&sock_parent, input)
}

fn resolve_control_socket_in(
    sock_parent: &Path,
    input: &str,
) -> Result<PathBuf, SandboxControlError> {
    if let Ok(sandbox_id) = input.parse::<SandboxId>() {
        let control_sock = SockPaths::new(sock_parent.join(sandbox_id.to_string())).control_sock();
        return match control_sock.try_exists() {
            Ok(true) => Ok(control_sock),
            Ok(false) => {
                let _entries = read_control_socket_parent(sock_parent)?;
                Err(control_socket_not_found(input))
            }
            Err(e) => Err(SandboxControlError::Connection(format!(
                "cannot check {}: {e}",
                control_sock.display()
            ))),
        };
    }

    let entries = read_control_socket_parent(sock_parent)?;

    let mut matches: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            SandboxControlError::Connection(format!(
                "cannot read entry in {}: {e}",
                sock_parent.display()
            ))
        })?;
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(input) {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| {
            SandboxControlError::Connection(format!(
                "cannot inspect {}: {e}",
                entry.path().display()
            ))
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let control_sock = SockPaths::new(entry.path()).control_sock();
        match control_sock.try_exists() {
            Ok(true) => matches.push((name_str.to_owned(), control_sock)),
            Ok(false) => {}
            Err(e) => {
                return Err(SandboxControlError::Connection(format!(
                    "cannot check {}: {e}",
                    control_sock.display()
                )));
            }
        }
    }

    match matches.as_slice() {
        [] => Err(control_socket_not_found(input)),
        [single] => Ok(single.1.clone()),
        _ => {
            let ids: Vec<&str> = matches.iter().map(|(id, _)| id.as_str()).collect();
            Err(SandboxControlError::Ambiguous(format!(
                "prefix '{input}' matches: {}",
                ids.join(", ")
            )))
        }
    }
}

fn read_control_socket_parent(sock_parent: &Path) -> Result<std::fs::ReadDir, SandboxControlError> {
    std::fs::read_dir(sock_parent).map_err(|e| {
        SandboxControlError::Connection(format!(
            "cannot read {}: {e} (is a sandbox running?)",
            sock_parent.display()
        ))
    })
}

fn control_socket_not_found(input: &str) -> SandboxControlError {
    SandboxControlError::NotFound(format!(
        "no running sandbox matches '{input}' (no control.sock found)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener as StdUnixListener;

    fn bind_control_socket_for_test(sandbox_dir: &Path) -> (PathBuf, StdUnixListener) {
        std::fs::create_dir_all(sandbox_dir).unwrap();
        let control_sock = SockPaths::new(sandbox_dir.to_path_buf()).control_sock();
        let listener = StdUnixListener::bind(&control_sock).unwrap();
        (control_sock, listener)
    }

    #[test]
    fn resolve_control_socket_missing_parent_returns_connection() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");

        let err = resolve_control_socket_in(&missing, "nonexistent-id-12345").unwrap_err();

        assert!(matches!(err, SandboxControlError::Connection(_)));
    }

    #[test]
    fn resolve_control_socket_full_id_missing_parent_returns_connection() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let sandbox_id = SandboxId::new_v4();

        let err = resolve_control_socket_in(&missing, &sandbox_id.to_string()).unwrap_err();

        assert!(matches!(err, SandboxControlError::Connection(_)));
    }

    #[test]
    fn resolve_control_socket_empty_parent_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        std::fs::create_dir(&sock_parent).unwrap();

        let err = resolve_control_socket_in(&sock_parent, "nonexistent-id-12345").unwrap_err();

        assert!(matches!(err, SandboxControlError::NotFound(_)));
    }

    #[test]
    fn resolve_control_socket_full_id_returns_exact_socket_path() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_id = SandboxId::new_v4();

        let (control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join(sandbox_id.to_string()));
        let (_sibling_control_sock, _sibling_listener) =
            bind_control_socket_for_test(&sock_parent.join(format!("{sandbox_id}-suffix")));

        let resolved = resolve_control_socket_in(&sock_parent, &sandbox_id.to_string()).unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_full_id_uses_canonical_socket_dir() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_id = SandboxId::new_v4();
        let (control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join(sandbox_id.to_string()));
        let uppercase_id = sandbox_id.to_string().to_ascii_uppercase();

        let resolved = resolve_control_socket_in(&sock_parent, &uppercase_id).unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_full_id_ignores_sibling_socket_check_error() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_id = SandboxId::new_v4();

        let (control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join(sandbox_id.to_string()));
        let sibling_dir = sock_parent.join(format!("{sandbox_id}-loop"));
        std::fs::create_dir_all(&sibling_dir).unwrap();
        let sibling_control_sock = SockPaths::new(sibling_dir).control_sock();
        symlink("control.sock", &sibling_control_sock).unwrap();

        let resolved = resolve_control_socket_in(&sock_parent, &sandbox_id.to_string()).unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_full_id_without_socket_returns_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_id = SandboxId::new_v4();
        std::fs::create_dir_all(sock_parent.join(sandbox_id.to_string())).unwrap();

        let err = resolve_control_socket_in(&sock_parent, &sandbox_id.to_string()).unwrap_err();

        assert!(matches!(err, SandboxControlError::NotFound(_)));
    }

    #[test]
    fn resolve_control_socket_full_id_without_socket_ignores_prefix_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_id = SandboxId::new_v4();
        let (_sibling_control_sock, _sibling_listener) =
            bind_control_socket_for_test(&sock_parent.join(format!("{sandbox_id}-suffix")));

        let err = resolve_control_socket_in(&sock_parent, &sandbox_id.to_string()).unwrap_err();

        assert!(matches!(err, SandboxControlError::NotFound(_)));
    }

    #[test]
    fn resolve_control_socket_full_id_socket_check_error_returns_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_id = SandboxId::new_v4();
        let sandbox_dir = sock_parent.join(sandbox_id.to_string());
        std::fs::create_dir_all(&sandbox_dir).unwrap();
        let control_sock = SockPaths::new(sandbox_dir).control_sock();
        symlink("control.sock", &control_sock).unwrap();

        let err = resolve_control_socket_in(&sock_parent, &sandbox_id.to_string()).unwrap_err();

        let SandboxControlError::Connection(message) = err else {
            panic!("expected connection error");
        };
        assert!(message.contains(&control_sock.display().to_string()));
    }

    #[test]
    fn resolve_control_socket_single_match_returns_socket_path() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let running_id = "sandbox-aa-live";
        let stale_id = "sandbox-aa-stale";
        let unrelated_id = "sandbox-bb-live";

        let (control_sock, _listener) = bind_control_socket_for_test(&sock_parent.join(running_id));
        let (_unrelated_control_sock, _unrelated_listener) =
            bind_control_socket_for_test(&sock_parent.join(unrelated_id));
        std::fs::create_dir_all(sock_parent.join(stale_id)).unwrap();

        let resolved = resolve_control_socket_in(&sock_parent, "sandbox-aa-").unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_prefix_socket_check_error_returns_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_dir = sock_parent.join("sandbox-aa-loop");
        std::fs::create_dir_all(&sandbox_dir).unwrap();
        let control_sock = SockPaths::new(sandbox_dir).control_sock();
        symlink("control.sock", &control_sock).unwrap();

        let err = resolve_control_socket_in(&sock_parent, "sandbox-aa-").unwrap_err();

        let SandboxControlError::Connection(message) = err else {
            panic!("expected connection error");
        };
        assert!(message.contains(&control_sock.display().to_string()));
    }

    #[test]
    fn resolve_control_socket_prefix_socket_check_error_prevents_partial_match() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let (_valid_control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join("sandbox-aa-live"));
        let sandbox_dir = sock_parent.join("sandbox-aa-loop");
        std::fs::create_dir_all(&sandbox_dir).unwrap();
        let control_sock = SockPaths::new(sandbox_dir).control_sock();
        symlink("control.sock", &control_sock).unwrap();

        let err = resolve_control_socket_in(&sock_parent, "sandbox-aa-").unwrap_err();

        let SandboxControlError::Connection(message) = err else {
            panic!("expected connection error");
        };
        assert!(message.contains(&control_sock.display().to_string()));
    }

    #[test]
    fn resolve_control_socket_prefix_ignores_non_utf8_entries() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let (control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join("sandbox-aa-live"));
        let non_utf8_name = std::ffi::OsString::from_vec(b"sandbox-aa-\xff".to_vec());
        let (_ignored_control_sock, _ignored_listener) =
            bind_control_socket_for_test(&sock_parent.join(non_utf8_name));

        let resolved = resolve_control_socket_in(&sock_parent, "sandbox-aa-").unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_prefix_ignores_matching_non_directory_entries() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let (control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join("sandbox-aa-live"));
        std::fs::write(sock_parent.join("sandbox-aa-file"), b"not a directory").unwrap();

        let resolved = resolve_control_socket_in(&sock_parent, "sandbox-aa-").unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_prefix_ignores_matching_symlinked_directories() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let (control_sock, _listener) =
            bind_control_socket_for_test(&sock_parent.join("sandbox-aa-live"));
        let (_linked_control_sock, _linked_listener) =
            bind_control_socket_for_test(&dir.path().join("linked-target"));
        symlink(
            dir.path().join("linked-target"),
            sock_parent.join("sandbox-aa-link"),
        )
        .unwrap();

        let resolved = resolve_control_socket_in(&sock_parent, "sandbox-aa-").unwrap();

        assert_eq!(resolved, control_sock);
    }

    #[test]
    fn resolve_control_socket_multiple_matches_returns_ambiguous() {
        let dir = tempfile::tempdir().unwrap();
        let sock_parent = dir.path().join("sock");
        let sandbox_a = "sandbox-aa-1";
        let sandbox_b = "sandbox-aa-2";
        let prefix = "sandbox-aa-";

        let (_control_sock_a, _listener_a) =
            bind_control_socket_for_test(&sock_parent.join(sandbox_a));
        let (_control_sock_b, _listener_b) =
            bind_control_socket_for_test(&sock_parent.join(sandbox_b));

        let err = resolve_control_socket_in(&sock_parent, prefix).unwrap_err();

        let SandboxControlError::Ambiguous(message) = err else {
            panic!("expected ambiguous error");
        };
        assert!(message.contains(&format!("prefix '{prefix}'")));
        assert!(message.contains(sandbox_a));
        assert!(message.contains(sandbox_b));
    }
}
