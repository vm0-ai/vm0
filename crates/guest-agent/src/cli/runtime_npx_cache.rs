//! Workspace-backed cache policy for the immutable runtime CLI package.

#[cfg(target_os = "linux")]
use crate::nofollow_fs::{Dir, FileIdentity};
use guest_common::log_warn;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::io;
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

const LOG_TAG: &str = "sandbox:guest-agent";
pub(super) const CLI_PACKAGE_URL_ENV_KEY: &str = "CLI_PKG_URL";
pub(super) const NPM_CACHE_ENV_KEY: &str = "npm_config_cache";
const VM0_STATE_DIR_NAME: &str = ".vm0";
const CACHE_DIR_NAME: &str = "cache";
const RUNTIME_NPX_CACHE_DIR_NAME: &str = "runtime-npx-v1";
const SHA256_HEX_LEN: usize = 64;

pub(super) fn prepare(user_env: &HashMap<String, String>) -> Option<String> {
    let package_url = user_env
        .get(CLI_PACKAGE_URL_ENV_KEY)
        .filter(|value| !value.is_empty())?;
    let generation = hex::encode(Sha256::digest(package_url.as_bytes()));

    match prepare_generation(&generation) {
        Ok(path) => Some(path.to_string_lossy().into_owned()),
        Err(error) => {
            log_warn!(
                LOG_TAG,
                "Could not prepare workspace runtime npm cache; using existing npm cache behavior: {error}"
            );
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn prepare_generation(generation: &str) -> io::Result<PathBuf> {
    let workspace_path = Path::new(crate::paths::CANONICAL_WORKING_DIR);
    let workspace = Dir::open_absolute(workspace_path)?;
    let workspace_filesystem = workspace.identity()?;
    let vm0 = create_workspace_child(
        &workspace,
        OsStr::new(VM0_STATE_DIR_NAME),
        workspace_filesystem,
    )?;
    let cache = create_workspace_child(&vm0, OsStr::new(CACHE_DIR_NAME), workspace_filesystem)?;
    let generations = create_workspace_child(
        &cache,
        OsStr::new(RUNTIME_NPX_CACHE_DIR_NAME),
        workspace_filesystem,
    )?;
    create_workspace_child(&generations, OsStr::new(generation), workspace_filesystem)?;

    if let Err(error) = prune_stale_generations(&generations, generation, workspace_filesystem) {
        log_warn!(
            LOG_TAG,
            "Could not prune stale workspace runtime npm cache generations: {error}"
        );
    }

    Ok(workspace_path
        .join(VM0_STATE_DIR_NAME)
        .join(CACHE_DIR_NAME)
        .join(RUNTIME_NPX_CACHE_DIR_NAME)
        .join(generation))
}

#[cfg(not(target_os = "linux"))]
fn prepare_generation(_generation: &str) -> std::io::Result<std::path::PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "workspace runtime npm cache requires Linux no-follow filesystem support",
    ))
}

#[cfg(target_os = "linux")]
fn create_workspace_child(
    parent: &Dir,
    name: &OsStr,
    workspace_filesystem: FileIdentity,
) -> io::Result<Dir> {
    let child = parent.create_child_dir(name)?;
    child.identity()?.ensure_same_mount(workspace_filesystem)?;
    Ok(child)
}

#[cfg(target_os = "linux")]
fn prune_stale_generations(
    generations: &Dir,
    active_generation: &str,
    workspace_filesystem: FileIdentity,
) -> io::Result<()> {
    for entry in generations.read_dir()? {
        let entry = entry?;
        let name = entry.file_name();
        if name == active_generation || !is_managed_generation_name(&name) {
            continue;
        }
        if !entry.file_type()?.is_dir() {
            continue;
        }
        generations.remove_child_dir_all(&name, workspace_filesystem)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn is_managed_generation_name(name: &OsStr) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == SHA256_HEX_LEN
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}
