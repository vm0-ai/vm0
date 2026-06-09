//! Curated environment for CLI children.

use crate::env;

const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_SHELL: &str = "/bin/bash";
const RUNNER_VISIBLE_CHILD_ENV_KEYS: &[&str] = &[
    // The sandbox CLI needs the same API origin as the guest-agent in local
    // development. Keep this list intentionally narrow: tokens and other VM0
    // bootstrap controls must stay private to the guest-agent.
    "VM0_API_URL",
];
const OPTIONAL_BASE_ENV_KEYS: &[&str] = &[
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    // Rootfs-wide runtime settings from /etc/environment. Keep these out of
    // guest-agent bootstrap control while preserving the CLI contract that
    // tools trust the injected proxy CA by default.
    "NPM_CONFIG_UPDATE_NOTIFIER",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CARGO_HTTP_CAINFO",
];

pub(super) fn apply_to_tokio_command(cmd: &mut tokio::process::Command) {
    cmd.env_clear();
    for (key, value) in base_child_env() {
        cmd.env(key, value);
    }
    for (key, value) in env::user_env() {
        cmd.env(key, value);
    }
    apply_runner_visible_env(|key, value| {
        cmd.env(key, value);
    });
}

pub(super) fn apply_to_std_command(cmd: &mut std::process::Command) {
    cmd.env_clear();
    for (key, value) in base_child_env() {
        cmd.env(key, value);
    }
    for (key, value) in env::user_env() {
        cmd.env(key, value);
    }
    apply_runner_visible_env(|key, value| {
        cmd.env(key, value);
    });
}

fn base_child_env() -> Vec<(&'static str, String)> {
    let mut base = Vec::with_capacity(OPTIONAL_BASE_ENV_KEYS.len() + 3);
    base.push(("HOME", env::home_dir().to_string()));
    base.push((
        "PATH",
        std::env::var("PATH")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_PATH.to_string()),
    ));
    base.push((
        "SHELL",
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_SHELL.to_string()),
    ));

    for key in OPTIONAL_BASE_ENV_KEYS {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            base.push((*key, value));
        }
    }

    base
}

fn apply_runner_visible_env(mut apply: impl FnMut(&'static str, String)) {
    for key in RUNNER_VISIBLE_CHILD_ENV_KEYS {
        if let Ok(value) = std::env::var(key)
            && !value.is_empty()
        {
            apply(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_child_env_includes_stable_minimum() {
        let keys: Vec<&str> = base_child_env().into_iter().map(|(key, _)| key).collect();

        assert!(keys.contains(&"HOME"));
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"SHELL"));
    }
}
