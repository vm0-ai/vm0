//! Curated environment for CLI children.

use std::collections::HashMap;

use crate::env;

use super::CliRuntimeConfig;

const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_SHELL: &str = "/bin/bash";
// The sandbox CLI needs the same API origin as the guest-agent in local
// development. Keep runner-visible env intentionally narrow: tokens and other
// VM0 bootstrap controls must stay private to the guest-agent.
const RUNNER_VISIBLE_API_URL_ENV_KEY: &str = guest_contracts::env::API_URL_ENV;
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
    let api_url = runner_visible_api_url_from_process_env();
    apply_to_tokio_command_with_values(cmd, env::home_dir(), env::user_env(), &api_url);
}

pub(super) fn apply_to_tokio_command_for_config(
    cmd: &mut tokio::process::Command,
    config: &env::GuestConfig,
) {
    apply_to_tokio_command_with_values(cmd, &config.home_dir, &config.user_env, &config.api_url);
}

pub(super) fn apply_to_tokio_command_for_runtime(
    cmd: &mut tokio::process::Command,
    runtime: &CliRuntimeConfig<'_>,
) {
    apply_to_tokio_command_with_values(
        cmd,
        runtime.home_dir.as_ref(),
        runtime.user_env,
        runtime.api_url.as_ref(),
    );
}

fn apply_to_tokio_command_with_values(
    cmd: &mut tokio::process::Command,
    home_dir: &str,
    user_env: &HashMap<String, String>,
    api_url: &str,
) {
    cmd.env_clear();
    for (key, value) in base_child_env(home_dir) {
        cmd.env(key, value);
    }
    for (key, value) in user_env {
        cmd.env(key, value);
    }
    apply_runner_visible_env(api_url, |key, value| {
        cmd.env(key, value);
    });
}

fn base_child_env(home_dir: &str) -> Vec<(&'static str, String)> {
    let mut base = Vec::with_capacity(OPTIONAL_BASE_ENV_KEYS.len() + 3);
    base.push(("HOME", home_dir.to_string()));
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

fn apply_runner_visible_env(api_url: &str, mut apply: impl FnMut(&'static str, String)) {
    if !api_url.is_empty() {
        apply(RUNNER_VISIBLE_API_URL_ENV_KEY, api_url.to_string());
    }
}

fn runner_visible_api_url_from_process_env() -> String {
    std::env::var(RUNNER_VISIBLE_API_URL_ENV_KEY)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_child_env_includes_stable_minimum() {
        let keys: Vec<&str> = base_child_env("/tmp/home")
            .into_iter()
            .map(|(key, _)| key)
            .collect();

        assert!(keys.contains(&"HOME"));
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"SHELL"));
    }
}
